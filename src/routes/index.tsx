import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  ACTION_LABELS, BATCH_STATUS_LABELS, DEFAULT_CHUNK_SIZE, ROLE_LABELS, ROLE_PERMISSIONS, STATUS_LABELS,
  applyPackageChunk, buildDemoPackage, buildPackage, isQuotaError, issueFingerprint, migrateState, validatePackage,
  type AuditEvent, type AuditIssue, type BatchStatus, type DemoKind, type EventAction, type ImportBatch,
  type IssueStatus, type PackageSource, type Severity, type SourceRole, type TaskPackage, type WorkbenchState
} from '~/lib/offline-package';

const STORAGE_KEY = 'a11y-audit-v1';
const IDENTITY_KEY = 'a11y-audit-identity';

interface Identity { name: string; role: SourceRole; workstation: string }

const withFingerprint = (issue: Omit<AuditIssue, 'fingerprint'>): AuditIssue => ({ ...issue, fingerprint: issueFingerprint(issue) });

const seedIssues: AuditIssue[] = [
  withFingerprint({ id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', evidence: ['console-esc-focus.log'], updatedAt: new Date(Date.now() - 3600_000).toISOString() }),
  withFingerprint({ id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', evidence: ['shot-describedby.png'], updatedAt: new Date(Date.now() - 7200_000).toISOString() })
];

const seed: WorkbenchState = {
  issues: seedIssues,
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', fingerprint: seedIssues[0].fingerprint, actor: '王审核', actorRole: 'reviewer', action: 'triage', message: '审核员确认问题有效并进入修复中', statusAfter: 'triaged' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', fingerprint: seedIssues[1].fingerprint, actor: '李开发', actorRole: 'developer', action: 'fix-start', message: '开发人员提交焦点管理修复', statusAfter: 'fixing' }
  ],
  batches: []
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  evidence: z.string().optional()
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WorkbenchState | null;
    return raw ? migrateState(raw) : seed;
  } catch { return seed; }
}

function loadIdentity(): Identity {
  const fallback: Identity = { name: '本地审核员', role: 'auditor', workstation: 'ws-local-01' };
  if (typeof localStorage === 'undefined') return fallback;
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null') as Partial<Identity> | null) }; } catch { return fallback; }
}

const shortBatch = (id: string) => (id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`);
const tick = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [identity, setIdentity] = createSignal<Identity>(loadIdentity());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const [noteText, setNoteText] = createSignal('');
  const [importText, setImportText] = createSignal('');
  const [importMessage, setImportMessage] = createSignal('');
  const [exportSummary, setExportSummary] = createSignal('');
  const [persistError, setPersistError] = createSignal('');
  const [simulateQuota, setSimulateQuota] = createSignal(false);
  const [demoKind, setDemoKind] = createSignal<DemoKind>('remote-fix');
  const importControl = new Map<string, { pause: boolean }>();
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious', evidence: '' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const sortedEvents = createMemo(() => [...state.events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)));
  const sortedBatches = createMemo(() => [...state.batches].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  const can = (action: EventAction) => ROLE_PERMISSIONS[identity().role].includes(action);
  const latestDisposition = createMemo(() => {
    const issue = selected();
    if (!issue) return undefined;
    return state.events
      .filter((event) => event.fingerprint === issue.fingerprint && event.statusAfter)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
  });

  createEffect(() => {
    const snapshot = JSON.stringify(state);
    if (typeof localStorage === 'undefined') return;
    if (simulateQuota()) { setPersistError('模拟容量受限：本地写入被拦截，导入将自动分批续接'); return; }
    try { localStorage.setItem(STORAGE_KEY, snapshot); setPersistError(''); } catch { setPersistError('本地存储容量不足，导入将自动分批续接'); }
  });
  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity()));
  });

  const persistNow = () => {
    if (simulateQuota()) { const err = new Error('本地容量不足（模拟）'); err.name = 'QuotaExceededError'; throw err; }
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const addEvent = (issue: AuditIssue, message: string, action: EventAction, statusAfter?: IssueStatus) =>
    setState('events', (events) => [{
      id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, fingerprint: issue.fingerprint,
      actor: identity().name, actorRole: identity().role, action, message, statusAfter
    }, ...events]);

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string, action: EventAction, statusAfter?: IssueStatus) => {
    const issue = state.issues.find((item) => item.id === id);
    if (!issue) return;
    setState('issues', (item) => item.id === id, produce((item) => Object.assign(item, patch, { updatedAt: new Date().toISOString() })));
    addEvent(issue, message, action, statusAfter);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = {
      id: crypto.randomUUID(), fingerprint: issueFingerprint(values),
      title: values.title, flow: values.flow, steps: values.steps, impactGroup: values.impactGroup, severity: values.severity,
      status: 'open', fixNote: '', retestNote: '',
      evidence: (values.evidence ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      updatedAt: new Date().toISOString()
    };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue, '审计员创建问题并保存证据', 'create', 'open');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`, 'merge');
    setSelectedId(canonical.id);
  };

  const addNote = () => {
    const issue = selected();
    const text = noteText().trim();
    if (!issue || !text) return;
    addEvent(issue, text, 'note');
    setNoteText('');
  };

  // ---------- 离线合并任务包 ----------
  const source = (): PackageSource => ({ workstation: identity().workstation, role: identity().role, exportedBy: identity().name });

  const exportPackage = () => {
    const pkg = buildPackage({ issues: state.issues, events: state.events }, source());
    const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `a11y-audit-${pkg.batchId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setExportSummary(`已导出批次 ${shortBatch(pkg.batchId)}：${pkg.issues.length} 个问题 · ${pkg.events.length} 条时间线动作 · 来源 ${pkg.source.workstation}（${ROLE_LABELS[pkg.source.role]} · ${pkg.source.exportedBy}）`);
  };

  const getBatch = (id: string) => state.batches.find((batch) => batch.id === id);
  const patchBatch = (id: string, patch: Partial<ImportBatch>) =>
    setState('batches', (batch) => batch.id === id, produce((batch) => Object.assign(batch, patch)));

  const applyChunk = (batchId: string) => {
    const batch = getBatch(batchId);
    if (!batch?.pkg) throw new Error('批次数据缺失，无法续接');
    const result = applyPackageChunk({ issues: state.issues, events: state.events }, batch.pkg, batch.cursor, batch.chunkSize);
    setState('issues', result.issues);
    setState('events', result.events);
    setState('batches', (item) => item.id === batchId, produce((item) => {
      item.cursor += result.processed;
      item.processedItems = item.cursor;
      item.addedIssues += result.addedIssues;
      item.mergedIssues += result.mergedIssues;
      item.appliedEvents += result.appliedEvents;
      item.skippedEvents += result.skippedEvents;
    }));
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const runImport = async (batchId: string) => {
    if (importControl.has(batchId)) return;
    const control = { pause: false };
    importControl.set(batchId, control);
    patchBatch(batchId, { status: 'importing' as BatchStatus });
    try {
      for (;;) {
        const batch = getBatch(batchId);
        if (!batch) return;
        if (control.pause) { patchBatch(batchId, { status: 'paused', error: '已手动暂停，可续接' }); return; }
        if (batch.cursor >= batch.totalItems) {
          patchBatch(batchId, { status: 'done', error: undefined, pkg: undefined });
          setImportMessage(`批次 ${shortBatch(batchId)} 导入完成：新增 ${batch.addedIssues} 个问题，合并 ${batch.mergedIssues} 个，应用 ${batch.appliedEvents} 条动作，跳过重复 ${batch.skippedEvents} 条`);
          return;
        }
        try {
          applyChunk(batchId);
          persistNow();
        } catch (err) {
          const size = getBatch(batchId)?.chunkSize ?? 1;
          if (isQuotaError(err) && size > 1) {
            const next = Math.max(1, Math.floor(size / 2));
            patchBatch(batchId, { chunkSize: next, error: `容量不足，自动降为每批 ${next} 条续接` });
            await tick(360);
            continue;
          }
          patchBatch(batchId, {
            status: 'failed',
            error: isQuotaError(err) ? '容量不足且已是最小批次，请清理空间后重试' : `导入失败：${err instanceof Error ? err.message : String(err)}`
          });
          return;
        }
        await tick(240);
      }
    } finally {
      importControl.delete(batchId);
    }
  };

  const pauseImport = (id: string) => { const control = importControl.get(id); if (control) control.pause = true; };
  const resumeImport = (id: string) => void runImport(id);

  const startImport = (raw: string) => {
    setImportMessage('');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { setImportMessage('任务包不是有效的 JSON，请检查后重试'); return; }
    const result = validatePackage(parsed);
    if (!result.ok) {
      const peek = parsed as Partial<TaskPackage>;
      const batchId = typeof peek.batchId === 'string' && peek.batchId ? peek.batchId : `batch-rejected-${Date.now().toString(36)}`;
      if (!state.batches.some((batch) => batch.id === batchId)) {
        const rejected: ImportBatch = {
          id: batchId,
          source: peek.source && typeof peek.source.workstation === 'string' ? peek.source : { workstation: '未知来源', role: 'auditor', exportedBy: '未知' },
          exportedAt: typeof peek.exportedAt === 'string' ? peek.exportedAt : new Date().toISOString(),
          startedAt: new Date().toISOString(),
          totalItems: Array.isArray(peek.issues) ? peek.issues.length : 0,
          processedItems: 0, addedIssues: 0, mergedIssues: 0, appliedEvents: 0, skippedEvents: 0,
          status: 'rejected', cursor: 0, chunkSize: 0, error: result.reason
        };
        setState('batches', (batches) => [rejected, ...batches]);
      }
      setImportMessage(`整包已拒绝，未写入任何数据：${result.reason}`);
      return;
    }
    const pkg = result.pkg;
    const existing = getBatch(pkg.batchId);
    if (existing) {
      if (existing.status === 'done') { setImportMessage(`批次 ${shortBatch(pkg.batchId)} 已导入完成，重复导入不会重复累计`); return; }
      if (existing.status === 'rejected') { setImportMessage('该批次此前因校验失败被整包拒绝'); return; }
      setImportMessage(`检测到批次 ${shortBatch(pkg.batchId)} 的未完成记录，已从断点续接`);
      resumeImport(existing.id);
      return;
    }
    const batch: ImportBatch = {
      id: pkg.batchId, source: pkg.source, exportedAt: pkg.exportedAt, startedAt: new Date().toISOString(),
      totalItems: pkg.issues.length, processedItems: 0, addedIssues: 0, mergedIssues: 0, appliedEvents: 0, skippedEvents: 0,
      status: 'importing', cursor: 0, chunkSize: DEFAULT_CHUNK_SIZE, pkg
    };
    setState('batches', (batches) => [batch, ...batches]);
    setImportMessage(`开始导入批次 ${shortBatch(pkg.batchId)}，来源 ${pkg.source.workstation}（${ROLE_LABELS[pkg.source.role]} · ${pkg.source.exportedBy}）`);
    void runImport(batch.id);
  };

  const onFilePicked = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    void file.text().then((text) => { setImportText(text); setImportMessage(`已读取文件 ${file.name}，点击「校验并导入」开始`); });
  };

  const generateDemo = () => {
    const anchor = state.issues.find((issue) => !issue.canonicalId) ?? seed.issues[0];
    const pkg = buildDemoPackage(demoKind(), anchor);
    setImportText(JSON.stringify(pkg, null, 2));
    setImportMessage('已生成示例任务包，点击「校验并导入」开始');
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="card identity" aria-labelledby="identity-title">
          <h2 id="identity-title">当前身份（本地动作与导出的归属来源）</h2>
          <div class="identity-fields">
            <label>操作人<input value={identity().name} onInput={(event) => setIdentity({ ...identity(), name: event.currentTarget.value })} /></label>
            <label>角色
              <select value={identity().role} onChange={(event) => setIdentity({ ...identity(), role: event.currentTarget.value as SourceRole })}>
                <For each={Object.entries(ROLE_LABELS) as [SourceRole, string][]}>{([role, label]) => <option value={role}>{label}</option>}</For>
              </select>
            </label>
            <label>工作站<input value={identity().workstation} onInput={(event) => setIdentity({ ...identity(), workstation: event.currentTarget.value })} /></label>
          </div>
          <p class="meta">可执行动作：{ROLE_PERMISSIONS[identity().role].map((action) => ACTION_LABELS[action]).join('、')}；切换角色以执行对应环节的操作。</p>
        </section>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
          <div class="card"><span>导入批次</span><strong>{state.batches.length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta"><span class="badge">{STATUS_LABELS[issue.status]}</span><span class="badge">{issue.severity}</span><span>{issue.flow}</span><span>{issue.impactGroup}</span><Show when={issue.canonicalId}><span class="badge">重复项</span></Show></div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <p><strong>证据：</strong>{issue.evidence.length ? issue.evidence.join('、') : '暂无'}</p>
                <p class="meta">问题指纹 <code>{issue.fingerprint}</code>（离线合并按指纹匹配）</p>
                <Show when={latestDisposition()}>{(disposition) => (
                  <p class="disposition">最新有效处置：{ACTION_LABELS[disposition().action]} · {disposition().actor}（{ROLE_LABELS[disposition().actorRole]}） · {new Date(disposition().at).toLocaleString()} · {disposition().batchId ? `批次 ${shortBatch(disposition().batchId!)}` : '本地'}</p>
                )}</Show>
                <div role="group" aria-label="问题状态操作">
                  <button disabled={!can('triage')} onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊', 'triage', 'triaged')}>确认问题</button>{' '}
                  <button disabled={!can('fix-start')} onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复', 'fix-start', 'fixing')}>开始修复</button>{' '}
                  <button disabled={!can('fix-submit')} onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测', 'fix-submit', 'verifying')}>提交复测</button>{' '}
                  <button disabled={!can('retest-pass')} onClick={() => updateIssue(issue.id, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题', 'retest-pass', 'closed')}>复测通过</button>{' '}
                  <button class="danger" disabled={!can('retest-fail')} onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开', 'retest-fail', 'reopened')}>复测失败</button>
                </div>
                <div class="note-box">
                  <label>补充人工记录（合并时本地记录始终保留）
                    <input value={noteText()} onInput={(event) => setNoteText(event.currentTarget.value)} placeholder="例如：线下陪同观察补充" />
                  </label>
                  <button class="secondary" disabled={!noteText().trim()} onClick={addNote}>添加记录</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto() || !can('merge')} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <section class="card offline" aria-labelledby="offline-title">
          <h2 id="offline-title">离线合并任务包</h2>
          <div class="offline-grid">
            <div>
              <h3>导出</h3>
              <p class="meta">任务包包含全部审计问题、操作时间线和批次归属（批次号 + 来源工作站/角色/操作人）。</p>
              <button onClick={exportPackage}>导出任务包</button>
              <Show when={exportSummary()}><p role="status">{exportSummary()}</p></Show>
            </div>
            <div>
              <h3>导入</h3>
              <label>选择任务包文件<input type="file" accept=".json,application/json" onChange={onFilePicked} /></label>
              <label>或粘贴任务包内容<textarea rows={5} value={importText()} onInput={(event) => setImportText(event.currentTarget.value)} placeholder='{"format":"a11y-audit-package", ...}' /></label>
              <div>
                <button disabled={!importText().trim()} onClick={() => startImport(importText())}>校验并导入</button>{' '}
                <label class="inline-demo">示例：
                  <select value={demoKind()} onChange={(event) => setDemoKind(event.currentTarget.value as DemoKind)}>
                    <option value="remote-fix">远程修复完成包（正常合并）</option>
                    <option value="permission">权限不符包（应整包拒绝）</option>
                    <option value="evidence">证据缺失包（应整包拒绝）</option>
                  </select>
                </label>{' '}
                <button class="secondary" onClick={generateDemo}>生成示例</button>
              </div>
              <label class="inline-demo"><input type="checkbox" checked={simulateQuota()} onChange={(event) => setSimulateQuota(event.currentTarget.checked)} /> 模拟容量受限（演示自动分批续接）</label>
              <Show when={importMessage()}><p role="status">{importMessage()}</p></Show>
              <Show when={persistError()}><p class="error" role="alert">{persistError()}</p></Show>
            </div>
          </div>
          <h3>批次记录（重开后保留来源与未完成入口）</h3>
          <Show when={state.batches.length} fallback={<p class="meta">暂无导入批次。</p>}>
            <For each={sortedBatches()}>{(batch) => (
              <article class="batch-row">
                <div class="meta">
                  <strong>批次 {shortBatch(batch.id)}</strong>
                  <span class="badge">{BATCH_STATUS_LABELS[batch.status]}</span>
                  <span>来源：{batch.source.workstation} · {ROLE_LABELS[batch.source.role]} · {batch.source.exportedBy}</span>
                  <span>导出于 {new Date(batch.exportedAt).toLocaleString()}</span>
                </div>
                <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={batch.totalItems} aria-valuenow={batch.processedItems} aria-label={`批次 ${shortBatch(batch.id)} 导入进度`}>
                  <span style={`width:${batch.totalItems ? Math.round((batch.processedItems / batch.totalItems) * 100) : 0}%`} />
                </div>
                <div class="meta">已处理 {batch.processedItems}/{batch.totalItems} · 新增 {batch.addedIssues} · 合并 {batch.mergedIssues} · 应用动作 {batch.appliedEvents} · 跳过重复 {batch.skippedEvents}</div>
                <Show when={batch.error}><p class="error" role="alert">{batch.error}</p></Show>
                <div>
                  <Show when={batch.status === 'importing'}><button class="secondary" onClick={() => pauseImport(batch.id)}>暂停</button></Show>
                  <Show when={batch.status === 'paused'}><button onClick={() => resumeImport(batch.id)}>继续导入</button></Show>
                  <Show when={batch.status === 'failed'}><button onClick={() => resumeImport(batch.id)}>重试</button></Show>
                </div>
              </article>
            )}</For>
          </Show>
        </section>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => field.value = event.currentTarget.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => field.value = event.currentTarget.value as Severity}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <AuditField name="evidence">{ (field, props) => <label>证据链接（每行一条，可选）<textarea {...props} rows={2} value={field.value ?? ''} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <button type="submit" disabled={!can('create')}>创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={sortedEvents().slice(0, 20)}>{(event: AuditEvent) => (
                <div class="timeline-item">
                  <strong>{new Date(event.at).toLocaleString()}</strong>
                  <div class="meta">
                    <span class="badge">{ACTION_LABELS[event.action]}</span>
                    <span>{event.actor} · {ROLE_LABELS[event.actorRole]}</span>
                    <span class="badge">{event.batchId ? `批次 ${shortBatch(event.batchId)}` : '本地'}</span>
                  </div>
                  <div>{event.message}</div>
                  <Show when={event.conflictNote}><div class="conflict">冲突说明：{event.conflictNote}（旧动作不再生效，仅保留说明）</div></Show>
                </div>
              )}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
