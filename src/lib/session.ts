import { CHUNK_SIZE } from './package';
import type { ImportSession, OfflinePackage, SessionStatus, WorkbenchState } from './types';

const SESSIONS_STORAGE_KEY = 'a11y-audit-sessions-v1';

/** 创建导入会话：按分片容量规划总片数。 */
export function createImportSession(pkg: OfflinePackage): ImportSession {
  const id = `session-${crypto.randomUUID()}`;
  const totalChunks = Math.max(1, Math.ceil(pkg.issues.length / CHUNK_SIZE));
  const now = new Date().toISOString();
  return {
    id,
    batchId: pkg.batch.id,
    source: pkg.batch.source,
    exportedBy: pkg.batch.exportedBy,
    packageData: pkg,
    status: 'pending',
    processedFingerprints: [],
    failedFingerprints: [],
    currentChunk: 0,
    totalChunks,
    createdAt: now,
    updatedAt: now,
  };
}

/** 持久化全部导入会话到 localStorage（重开后仍可续接）。 */
export function persistSessions(sessions: ImportSession[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // 容量不足时由调用方标记会话失败并分批续接。
  }
}

/** 读取持久化的导入会话。 */
export function loadPersistedSessions(): ImportSession[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImportSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 取某会话当前分片对应的问题列表。 */
export function currentChunkIssues(session: ImportSession) {
  const start = session.currentChunk * CHUNK_SIZE;
  return session.packageData.issues.slice(start, start + CHUNK_SIZE);
}

/** 取某会话已处理的问题数（按分片累计）。 */
export function processedCount(session: ImportSession): number {
  return session.currentChunk * CHUNK_SIZE;
}

/** 判断会话是否还有未完成分片。 */
export function hasMoreChunks(session: ImportSession): boolean {
  return session.currentChunk < session.totalChunks;
}

/** 推进到下一分片；返回新会话。 */
export function advanceChunk(session: ImportSession): ImportSession {
  const next = session.currentChunk + 1;
  const done = next >= session.totalChunks;
  return {
    ...session,
    currentChunk: next,
    status: done ? 'completed' : 'paused',
    updatedAt: new Date().toISOString(),
  };
}

/** 标记会话失败（容量不足或校验失败），保留当前分片以便重试。 */
export function failSession(session: ImportSession, error: string): ImportSession {
  return { ...session, status: 'failed', error, updatedAt: new Date().toISOString() };
}

/** 暂停会话：保留进度，可稍后续接。 */
export function pauseSession(session: ImportSession): ImportSession {
  return { ...session, status: 'paused', updatedAt: new Date().toISOString() };
}

/** 重试失败会话：清除错误，从当前分片继续。 */
export function retrySession(session: ImportSession): ImportSession {
  return { ...session, status: 'pending', error: undefined, updatedAt: new Date().toISOString() };
}

/** 续接会话：从当前分片继续处理。 */
export function continueSession(session: ImportSession): ImportSession {
  return { ...session, status: 'pending', error: undefined, updatedAt: new Date().toISOString() };
}

/** 统计未完成（pending/paused/failed）会话数。 */
export function unfinishedCount(sessions: ImportSession[]): number {
  return sessions.filter((s) => s.status !== 'completed').length;
}

/** 会话状态的中文展示。 */
export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'pending': return '待处理';
    case 'paused': return '已暂停';
    case 'failed': return '失败';
    case 'completed': return '已完成';
  }
}

/** 会话来源的中文展示。 */
export function sourceLabel(source: ImportSession['source']): string {
  return source === 'audit' ? '审核员离线' : '远程修复';
}

/** 从工作台状态中移除已完成会话对应的包数据引用（释放容量）。 */
export function pruneCompletedSessions(sessions: ImportSession[]): ImportSession[] {
  return sessions.filter((s) => s.status !== 'completed');
}

/** 尝试写入 localStorage，捕获容量不足错误。 */
export function tryPersistState(state: WorkbenchState): { ok: boolean; error?: string } {
  if (typeof localStorage === 'undefined') return { ok: true };
  try {
    localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('quota') || message.includes('Quota') || message.includes('storage')) {
      return { ok: false, error: '本地容量不足，请分批续接或清理空间后重试' };
    }
    return { ok: false, error: message };
  }
}
