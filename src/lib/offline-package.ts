import { z } from 'zod';

// ---------- 类型 ----------
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type SourceRole = 'auditor' | 'reviewer' | 'developer' | 'retester';
export type EventAction = 'create' | 'note' | 'triage' | 'merge' | 'fix-start' | 'fix-submit' | 'retest-pass' | 'retest-fail';

export interface AuditIssue {
  id: string;
  fingerprint: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  evidence: string[];
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  fingerprint: string;
  actor: string;
  actorRole: SourceRole;
  action: EventAction;
  message: string;
  statusAfter?: IssueStatus;
  batchId?: string;
  conflictNote?: string;
  supersededBy?: string;
}

export interface PackageSource { workstation: string; role: SourceRole; exportedBy: string }

export interface TaskPackage {
  format: 'a11y-audit-package';
  version: 1;
  batchId: string;
  source: PackageSource;
  exportedAt: string;
  issues: AuditIssue[];
  events: AuditEvent[];
}

export type BatchStatus = 'importing' | 'paused' | 'failed' | 'done' | 'rejected';

export interface ImportBatch {
  id: string;
  source: PackageSource;
  exportedAt: string;
  startedAt: string;
  totalItems: number;
  processedItems: number;
  addedIssues: number;
  mergedIssues: number;
  appliedEvents: number;
  skippedEvents: number;
  status: BatchStatus;
  cursor: number;
  chunkSize: number;
  error?: string;
  /** 未完成批次保留任务包数据，重开后可从断点续接 */
  pkg?: TaskPackage;
}

export interface WorkbenchState { issues: AuditIssue[]; events: AuditEvent[]; batches: ImportBatch[] }

// ---------- 常量 ----------
export const ROLE_LABELS: Record<SourceRole, string> = { auditor: '审计员', reviewer: '审核员', developer: '开发人员', retester: '复测人员' };
export const ACTION_LABELS: Record<EventAction, string> = {
  create: '创建问题', note: '人工记录', triage: '确认分诊', merge: '重复合并',
  'fix-start': '开始修复', 'fix-submit': '提交复测', 'retest-pass': '复测通过', 'retest-fail': '复测失败'
};
export const STATUS_LABELS: Record<IssueStatus, string> = { open: '待分诊', triaged: '已确认', fixing: '修复中', verifying: '待复测', closed: '已关闭', reopened: '重新打开' };
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = { importing: '导入中', paused: '已暂停·可续接', failed: '失败·可重试', done: '已完成', rejected: '已整包拒绝' };

/** 每个角色允许执行的动作；导入时逐条校验，不符则整包拒绝 */
export const ROLE_PERMISSIONS: Record<SourceRole, EventAction[]> = {
  auditor: ['create', 'note'],
  reviewer: ['triage', 'merge', 'note'],
  developer: ['fix-start', 'fix-submit', 'note'],
  retester: ['retest-pass', 'retest-fail', 'note']
};

export const DEFAULT_CHUNK_SIZE = 5;

// ---------- 指纹 ----------
const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** FNV-1a：同一问题在两端计算出相同指纹，用于导入合并匹配 */
export function issueFingerprint(input: { title: string; flow: string; steps: string }): string {
  const text = `${normalizeText(input.title)}␟${normalizeText(input.flow)}␟${normalizeText(input.steps)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------- 校验 ----------
const issueSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  title: z.string(),
  flow: z.string(),
  steps: z.string(),
  impactGroup: z.string(),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  status: z.enum(['open', 'triaged', 'fixing', 'verifying', 'closed', 'reopened']),
  canonicalId: z.string().optional(),
  fixNote: z.string().default(''),
  retestNote: z.string().default(''),
  evidence: z.array(z.string()).default([]),
  updatedAt: z.string()
});
const eventSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  issueId: z.string(),
  fingerprint: z.string(),
  actor: z.string(),
  actorRole: z.enum(['auditor', 'reviewer', 'developer', 'retester']),
  action: z.enum(['create', 'note', 'triage', 'merge', 'fix-start', 'fix-submit', 'retest-pass', 'retest-fail']),
  message: z.string(),
  statusAfter: z.enum(['open', 'triaged', 'fixing', 'verifying', 'closed', 'reopened']).optional(),
  batchId: z.string().optional(),
  conflictNote: z.string().optional(),
  supersededBy: z.string().optional()
});
const packageSchema = z.object({
  format: z.literal('a11y-audit-package'),
  version: z.literal(1),
  batchId: z.string().min(1),
  source: z.object({
    workstation: z.string().min(1),
    role: z.enum(['auditor', 'reviewer', 'developer', 'retester']),
    exportedBy: z.string().min(1)
  }),
  exportedAt: z.string(),
  issues: z.array(issueSchema),
  events: z.array(eventSchema)
});

export type ValidationResult = { ok: true; pkg: TaskPackage } | { ok: false; reason: string };

/** 整包校验：格式、来源权限、证据完整性。任一不符即整包拒绝，不部分应用 */
export function validatePackage(raw: unknown): ValidationResult {
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `任务包格式不正确（${parsed.error.issues[0]?.path.join('.') || '结构'}：${parsed.error.issues[0]?.message ?? '未知'}）` };
  const pkg = parsed.data as TaskPackage;

  for (const event of pkg.events) {
    const allowed = ROLE_PERMISSIONS[event.actorRole];
    if (!allowed.includes(event.action)) {
      return { ok: false, reason: `来源权限不符：${ROLE_LABELS[event.actorRole]}「${event.actor}」不能执行「${ACTION_LABELS[event.action]}」` };
    }
  }

  const byFingerprint = new Map(pkg.issues.map((issue) => [issue.fingerprint, issue]));
  for (const issue of pkg.issues) {
    if ((issue.status === 'verifying' || issue.status === 'closed') && (!issue.fixNote.trim() || issue.evidence.length === 0)) {
      return { ok: false, reason: `证据缺失：问题「${issue.title}」已进入复测/关闭，但缺少修复说明或证据` };
    }
    if (issue.status === 'closed' && !issue.retestNote.trim()) {
      return { ok: false, reason: `证据缺失：问题「${issue.title}」已关闭，但缺少复测记录` };
    }
  }
  for (const event of pkg.events) {
    const issue = byFingerprint.get(event.fingerprint);
    if (!issue) return { ok: false, reason: '任务包格式不正确：时间线动作找不到对应问题' };
    if (event.action === 'fix-submit' && !issue.fixNote.trim()) {
      return { ok: false, reason: `证据缺失：「${issue.title}」提交了复测但缺少修复说明` };
    }
    if ((event.action === 'retest-pass' || event.action === 'retest-fail') && !issue.retestNote.trim()) {
      return { ok: false, reason: `证据缺失：「${issue.title}」记录了复测结果但缺少复测说明` };
    }
  }
  return { ok: true, pkg };
}

// ---------- 时间线合并 ----------
const byTime = (a: AuditEvent, b: AuditEvent) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/**
 * 以时间线里最新有效动作归属为准；被覆盖的旧动作不删除，只留冲突说明。
 * 直接修改传入的事件对象（调用方负责先克隆）。
 */
export function resolveTimeline(events: AuditEvent[]): { status?: IssueStatus; winner?: AuditEvent } {
  const statusEvents = events.filter((event) => event.statusAfter).sort(byTime);
  const winner = statusEvents[statusEvents.length - 1];
  for (const event of statusEvents) {
    if (event === winner) {
      delete event.conflictNote;
      delete event.supersededBy;
    } else if (winner && event.statusAfter !== winner.statusAfter) {
      event.conflictNote = `与 ${winner.actor}（${ROLE_LABELS[winner.actorRole]}）的「${ACTION_LABELS[winner.action]}」（${winner.at}）冲突，以最新有效动作为准`;
      event.supersededBy = winner.id;
    } else {
      delete event.conflictNote;
      delete event.supersededBy;
    }
  }
  return { status: winner?.statusAfter, winner };
}

export interface ChunkResult {
  issues: AuditIssue[];
  events: AuditEvent[];
  processed: number;
  addedIssues: number;
  mergedIssues: number;
  appliedEvents: number;
  skippedEvents: number;
}

/**
 * 应用任务包的一个分片（按问题为单位）。纯函数，返回新数组。
 * 幂等：事件按 id 去重、问题按指纹去重，重复导入/分片重试不会重复累计。
 * 本地人工记录优先：本地已有的修复/复测说明不被覆盖，本地事件永不删除。
 */
export function applyPackageChunk(
  data: { issues: AuditIssue[]; events: AuditEvent[] },
  pkg: TaskPackage,
  start: number,
  size: number
): ChunkResult {
  const issues = data.issues.map((issue) => ({ ...issue, evidence: [...issue.evidence] }));
  const events = data.events.map((event) => ({ ...event }));
  const eventIds = new Set(events.map((event) => event.id));
  const byFingerprint = new Map(issues.map((issue) => [issue.fingerprint, issue]));
  const usedIds = new Set(issues.map((issue) => issue.id));
  let processed = 0, addedIssues = 0, mergedIssues = 0, appliedEvents = 0, skippedEvents = 0;

  for (const pkgIssue of pkg.issues.slice(start, start + size)) {
    processed++;
    const incoming = pkg.events.filter((event) => event.fingerprint === pkgIssue.fingerprint);
    const local = byFingerprint.get(pkgIssue.fingerprint);

    if (!local) {
      let id = pkgIssue.id;
      if (usedIds.has(id)) id = crypto.randomUUID();
      usedIds.add(id);
      const issue: AuditIssue = { ...pkgIssue, id, evidence: [...pkgIssue.evidence] };
      issues.push(issue);
      byFingerprint.set(issue.fingerprint, issue);
      for (const event of incoming) {
        if (eventIds.has(event.id)) { skippedEvents++; continue; }
        eventIds.add(event.id);
        events.push({ ...event, issueId: id, batchId: event.batchId ?? pkg.batchId });
        appliedEvents++;
      }
      addedIssues++;
      continue;
    }

    mergedIssues++;
    // 保留本地人工记录：本地已有内容不覆盖，只补空白
    local.fixNote = local.fixNote || pkgIssue.fixNote;
    local.retestNote = local.retestNote || pkgIssue.retestNote;
    local.evidence = [...new Set([...local.evidence, ...pkgIssue.evidence])];
    local.canonicalId = local.canonicalId ?? pkgIssue.canonicalId;
    local.updatedAt = local.updatedAt > pkgIssue.updatedAt ? local.updatedAt : pkgIssue.updatedAt;

    const issueEvents = events.filter((event) => event.fingerprint === local.fingerprint);
    for (const event of incoming) {
      if (eventIds.has(event.id)) { skippedEvents++; continue; }
      eventIds.add(event.id);
      const merged = { ...event, issueId: local.id, batchId: event.batchId ?? pkg.batchId };
      events.push(merged);
      issueEvents.push(merged);
      appliedEvents++;
    }
    const { status } = resolveTimeline(issueEvents);
    if (status) local.status = status;
  }
  return { issues, events, processed, addedIssues, mergedIssues, appliedEvents, skippedEvents };
}

// ---------- 导出 ----------
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function buildPackage(
  state: { issues: AuditIssue[]; events: AuditEvent[] },
  source: PackageSource
): TaskPackage {
  return {
    format: 'a11y-audit-package',
    version: 1,
    batchId: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    exportedAt: new Date().toISOString(),
    issues: deepClone(state.issues),
    events: deepClone(state.events)
  };
}

// ---------- 本地数据迁移 ----------
export function migrateState(raw: unknown): WorkbenchState {
  const data = (raw ?? {}) as Partial<WorkbenchState>;
  const issues = (data.issues ?? []).map((issue) => ({
    ...issue,
    evidence: issue.evidence ?? [],
    fingerprint: issue.fingerprint || issueFingerprint(issue)
  }));
  const events = (data.events ?? []).map((event) => ({
    ...event,
    actor: event.actor ?? '本地记录',
    actorRole: event.actorRole ?? ('auditor' as SourceRole),
    action: event.action ?? ('note' as EventAction),
    fingerprint: event.fingerprint || issues.find((issue) => issue.id === event.issueId)?.fingerprint || ''
  }));
  const batches = (data.batches ?? []).map((batch) =>
    batch.status === 'importing'
      ? { ...batch, status: 'paused' as BatchStatus, error: '上次导入被中断，可从断点续接' }
      : batch
  );
  return { issues, events, batches };
}

export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

// ---------- 演示任务包 ----------
export type DemoKind = 'remote-fix' | 'permission' | 'evidence';

/** 生成示例任务包，便于单浏览器演示合并、整包拒绝等流程 */
export function buildDemoPackage(kind: DemoKind, anchor: { title: string; flow: string; steps: string }): TaskPackage {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const source: PackageSource = { workstation: 'ws-remote-02', role: 'developer', exportedBy: '李开发' };
  const base = { format: 'a11y-audit-package' as const, version: 1 as const, batchId: `batch-demo-${kind}-${now.toString(36)}`, source, exportedAt: at(0) };
  const fp = issueFingerprint(anchor);

  if (kind === 'remote-fix') {
    const focusIssue: AuditIssue = {
      id: crypto.randomUUID(), fingerprint: fp, title: anchor.title, flow: anchor.flow, steps: anchor.steps,
      impactGroup: '键盘与读屏用户', severity: 'serious', status: 'closed',
      fixNote: '关闭弹窗后焦点返回触发按钮', retestNote: '键盘与读屏回归通过',
      evidence: ['commit-7f3a2c', 'retest-0412.mp4'], updatedAt: at(10)
    };
    const formIssue: AuditIssue = {
      id: crypto.randomUUID(), fingerprint: issueFingerprint({ title: '表单提交错误未汇总提示', flow: '账户设置', steps: '提交空表单后错误分散在各字段' }),
      title: '表单提交错误未汇总提示', flow: '账户设置', steps: '1. 留空必填项\n2. 提交表单\n3. 读屏无法获知错误汇总',
      impactGroup: '读屏用户', severity: 'moderate', status: 'fixing',
      fixNote: '正在增加错误汇总区域', retestNote: '', evidence: ['shot-err-summary.png'], updatedAt: at(60)
    };
    const events: AuditEvent[] = [
      { id: crypto.randomUUID(), at: at(120), issueId: focusIssue.id, fingerprint: fp, actor: '陈审计', actorRole: 'auditor', action: 'create', message: '审计员创建问题并保存证据', statusAfter: 'open' },
      { id: crypto.randomUUID(), at: at(50), issueId: focusIssue.id, fingerprint: fp, actor: '李开发', actorRole: 'developer', action: 'fix-start', message: '开发人员开始修复', statusAfter: 'fixing' },
      { id: crypto.randomUUID(), at: at(40), issueId: focusIssue.id, fingerprint: fp, actor: '李开发', actorRole: 'developer', action: 'fix-submit', message: '开发人员提交修复，进入复测', statusAfter: 'verifying' },
      { id: crypto.randomUUID(), at: at(30), issueId: focusIssue.id, fingerprint: fp, actor: '赵复测', actorRole: 'retester', action: 'retest-pass', message: '复测通过并关闭问题', statusAfter: 'closed' },
      { id: crypto.randomUUID(), at: at(110), issueId: formIssue.id, fingerprint: formIssue.fingerprint, actor: '陈审计', actorRole: 'auditor', action: 'create', message: '审计员创建问题并保存证据', statusAfter: 'open' },
      { id: crypto.randomUUID(), at: at(100), issueId: formIssue.id, fingerprint: formIssue.fingerprint, actor: '王审核', actorRole: 'reviewer', action: 'triage', message: '审核员完成分诊', statusAfter: 'triaged' },
      { id: crypto.randomUUID(), at: at(70), issueId: formIssue.id, fingerprint: formIssue.fingerprint, actor: '李开发', actorRole: 'developer', action: 'fix-start', message: '开发人员开始修复', statusAfter: 'fixing' }
    ];
    return { ...base, issues: [focusIssue, formIssue], events };
  }

  if (kind === 'permission') {
    const bad: AuditIssue = {
      id: crypto.randomUUID(), fingerprint: issueFingerprint({ title: '按钮对比度不足', flow: '订单结算', steps: '使用对比度工具测量主按钮' }),
      title: '按钮对比度不足', flow: '订单结算', steps: '使用对比度工具测量主按钮',
      impactGroup: '低视力用户', severity: 'serious', status: 'closed',
      fixNote: '已调整色值', retestNote: '复测通过', evidence: ['contrast-report.png'], updatedAt: at(20)
    };
    const events: AuditEvent[] = [
      { id: crypto.randomUUID(), at: at(90), issueId: bad.id, fingerprint: bad.fingerprint, actor: '陈审计', actorRole: 'auditor', action: 'create', message: '审计员创建问题', statusAfter: 'open' },
      { id: crypto.randomUUID(), at: at(25), issueId: bad.id, fingerprint: bad.fingerprint, actor: '李开发', actorRole: 'developer', action: 'retest-pass', message: '开发人员直接关闭问题', statusAfter: 'closed' }
    ];
    return { ...base, issues: [bad], events };
  }

  const noEvidence: AuditIssue = {
    id: crypto.randomUUID(), fingerprint: issueFingerprint({ title: '弹窗缺少 aria-modal 标注', flow: '账户设置', steps: '打开设置弹窗后用读屏浏览' }),
    title: '弹窗缺少 aria-modal 标注', flow: '账户设置', steps: '打开设置弹窗后用读屏浏览',
    impactGroup: '读屏用户', severity: 'moderate', status: 'closed',
    fixNote: '已补充 aria-modal', retestNote: '', evidence: [], updatedAt: at(15)
  };
  const events: AuditEvent[] = [
    { id: crypto.randomUUID(), at: at(80), issueId: noEvidence.id, fingerprint: noEvidence.fingerprint, actor: '陈审计', actorRole: 'auditor', action: 'create', message: '审计员创建问题', statusAfter: 'open' },
    { id: crypto.randomUUID(), at: at(18), issueId: noEvidence.id, fingerprint: noEvidence.fingerprint, actor: '赵复测', actorRole: 'retester', action: 'retest-pass', message: '复测通过并关闭问题', statusAfter: 'closed' }
  ];
  return { ...base, issues: [noEvidence], events };
}
