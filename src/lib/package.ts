import type { AuditEvent, AuditIssue, Batch, OfflinePackage, PackageSource, WorkbenchState } from './types';

export const PACKAGE_FORMAT = 'a11y-audit-package';
export const PACKAGE_VERSION = 1;

/** 单次导入处理的问题分片大小，容量不足时按分片续接。 */
export const CHUNK_SIZE = 5;

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** 审计来源可写全部字段；远程修复来源仅可写状态与修复/复测记录。 */
const REMOTE_FIX_WRITABLE_FIELDS = ['status', 'fixNote', 'retestNote', 'canonicalId'] as const;

/** 从当前工作台状态构建离线合并任务包。 */
export function createPackage(
  state: WorkbenchState,
  source: PackageSource,
  exportedBy: string,
  note?: string
): OfflinePackage {
  const batchId = `batch-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const issues: AuditIssue[] = state.issues.map((issue) => ({ ...issue }));
  const events: AuditEvent[] = state.events.map((event) => ({ ...event }));
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    batch: { id: batchId, source, exportedAt: now, exportedBy, note },
    issues,
    events,
  };
}

/** 将包内批次登记到工作台批次列表。 */
export function packageToBatch(pkg: OfflinePackage): Batch {
  return {
    id: pkg.batch.id,
    source: pkg.batch.source,
    exportedAt: pkg.batch.exportedAt,
    exportedBy: pkg.batch.exportedBy,
    note: pkg.batch.note,
    issueCount: pkg.issues.length,
    eventCount: pkg.events.length,
  };
}

/** 校验任务包结构与证据完整性。 */
export function validatePackage(pkg: unknown): ValidationResult {
  if (!pkg || typeof pkg !== 'object') return { ok: false, error: '任务包格式无效' };
  const p = pkg as Partial<OfflinePackage>;
  if (p.format !== PACKAGE_FORMAT) return { ok: false, error: '无法识别的任务包格式' };
  if (p.version !== PACKAGE_VERSION) return { ok: false, error: '任务包版本不兼容' };
  if (!p.batch || typeof p.batch !== 'object') return { ok: false, error: '缺少批次信息' };
  if (!Array.isArray(p.issues)) return { ok: false, error: '缺少审计问题列表' };
  if (!Array.isArray(p.events)) return { ok: false, error: '缺少操作时间线' };

  for (const issue of p.issues) {
    if (!issue || typeof issue !== 'object') return { ok: false, error: '问题条目无效' };
    if (!issue.title || !issue.flow) return { ok: false, error: '问题缺少标题或业务流程' };
    // 证据缺失：复现步骤与证据均为空时整包拒收。
    if (!issue.steps?.trim() && !issue.evidence?.trim()) {
      return { ok: false, error: `问题「${issue.title}」缺少证据（复现步骤），整包不予覆盖` };
    }
  }
  return { ok: true };
}

/**
 * 校验来源权限：远程修复来源不得改写审计字段。
 * 以本地对应问题为基准，若远程包试图改动审计字段则整包拒收。
 */
export function validatePermission(
  pkg: OfflinePackage,
  localIssues: AuditIssue[]
): ValidationResult {
  if (pkg.batch.source !== 'remote-fix') return { ok: true };
  const localByFingerprint = new Map(localIssues.map((issue) => [issue.fingerprint, issue]));
  for (const remote of pkg.issues) {
    const local = localByFingerprint.get(remote.fingerprint);
    if (!local) {
      // 远程修复来源不得新建审计问题（无法提供完整审计字段）。
      return { ok: false, error: `来源「远程修复」无权新建问题「${remote.title}」，整包不予覆盖` };
    }
    for (const field of REMOTE_FIX_WRITABLE_FIELDS) {
      // 仅比对可写字段之外的审计字段是否被改动。
    }
    const auditFields = ['title', 'flow', 'steps', 'impactGroup', 'severity', 'evidence'] as const;
    for (const field of auditFields) {
      if ((remote as AuditIssue)[field] !== (local as AuditIssue)[field]) {
        return { ok: false, error: `来源「远程修复」无权改写审计字段「${field}」，整包不予覆盖` };
      }
    }
  }
  return { ok: true };
}

/** 触发浏览器下载任务包 JSON 文件。 */
export function downloadPackage(pkg: OfflinePackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `a11y-audit-package-${pkg.batch.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 从上传的 File 读取并解析任务包。 */
export function readPackageFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result))); }
      catch { reject(new Error('任务包文件解析失败')); }
    };
    reader.onerror = () => reject(new Error('任务包文件读取失败'));
    reader.readAsText(file);
  });
}
