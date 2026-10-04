import { computeFingerprint } from './fingerprint';
import type { AuditEvent, AuditIssue, OfflinePackage, WorkbenchState } from './types';

/** 取某问题在事件流中最新有效动作的时间戳；无有效动作时返回 0。 */
function latestValidAt(events: AuditEvent[], issueId: string): number {
  let latest = 0;
  for (const event of events) {
    if (event.issueId !== issueId) continue;
    if (event.valid === false) continue;
    const t = Date.parse(event.at);
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  return latest;
}

/** 为旧动作生成冲突说明事件：旧动作保留在时间线中，仅追加冲突说明。 */
function makeConflictNote(
  issueId: string,
  loserSide: 'local' | 'remote',
  loserUpdatedAt: string,
  winnerBatchId: string,
  at: string
): AuditEvent {
  const sideLabel = loserSide === 'local' ? '本地' : '远程';
  return {
    id: `conflict-${issueId}-${winnerBatchId}`,
    at,
    issueId,
    message: `${sideLabel}操作（${loserUpdatedAt}）已被批次 ${winnerBatchId} 的更新覆盖`,
    batchId: winnerBatchId,
    valid: false,
    conflictNote: `两端对同一问题处置不同，以时间线最新有效动作归属为准；旧动作仅保留冲突说明。`,
  };
}

export interface MergeResult {
  issues: AuditIssue[];
  events: AuditEvent[];
  /** 本次合并新增的问题指纹（用于去重统计）。 */
  addedFingerprints: string[];
  /** 本次合并更新的问题指纹。 */
  updatedFingerprints: string[];
  /** 产生冲突说明的问题 id。 */
  conflictIssueIds: string[];
}

/**
 * 按问题指纹合并任务包到工作台状态。
 * - 指纹相同则合并：以时间线最新有效动作归属为准，旧动作留冲突说明。
 * - 保留本地人工记录（manualNote）与证据（evidence），不被覆盖。
 * - 重复导入不重复累计：事件按 id 去重，问题按指纹归并。
 */
export function mergePackage(
  state: WorkbenchState,
  pkg: OfflinePackage
): MergeResult {
  const batchId = pkg.batch.id;
  const now = new Date().toISOString();
  const issues: AuditIssue[] = state.issues.map((issue) => ({ ...issue }));
  const events: AuditEvent[] = state.events.map((event) => ({ ...event }));
  const addedFingerprints: string[] = [];
  const updatedFingerprints: string[] = [];
  const conflictIssueIds: string[] = [];

  // 事件按 id 去重（重复导入不重复累计）。
  const eventIds = new Set(events.map((event) => event.id));
  for (const remoteEvent of pkg.events) {
    if (eventIds.has(remoteEvent.id)) continue;
    eventIds.add(remoteEvent.id);
    events.push({ ...remoteEvent, batchId: remoteEvent.batchId || batchId });
  }

  const issueByFingerprint = new Map(issues.map((issue) => [issue.fingerprint, issue]));

  for (const remote of pkg.issues) {
    const fingerprint = remote.fingerprint || computeFingerprint(remote.title, remote.flow);
    const local = issueByFingerprint.get(fingerprint);

    if (!local) {
      // 新问题：以包内数据为准，归属到导入批次。
      const newIssue: AuditIssue = {
        ...remote,
        fingerprint,
        evidence: remote.evidence ?? '',
        manualNote: remote.manualNote ?? '',
        batchId,
        updatedAt: now,
      };
      issues.push(newIssue);
      issueByFingerprint.set(fingerprint, newIssue);
      addedFingerprints.push(fingerprint);
      continue;
    }

    // 已存在：按最新有效动作归属。
    const localLatest = latestValidAt(events, local.id);
    const remoteLatest = latestValidAt(pkg.events, remote.id);
    const merged: AuditIssue = { ...local };

    // 保留本地人工记录与证据，不被覆盖。
    merged.manualNote = local.manualNote || remote.manualNote || '';
    merged.evidence = local.evidence || remote.evidence || '';

    if (remoteLatest > localLatest) {
      // 远程较新：状态与修复/复测记录以远程为准。
      merged.status = remote.status;
      merged.fixNote = remote.fixNote;
      merged.retestNote = remote.retestNote;
      merged.canonicalId = remote.canonicalId ?? local.canonicalId;
      merged.batchId = batchId;
      merged.updatedAt = now;
      // 本地旧动作留冲突说明（重复导入不重复累计）。
      const conflictId = `conflict-${local.id}-${batchId}`;
      if (!eventIds.has(conflictId)) {
        eventIds.add(conflictId);
        events.push(makeConflictNote(local.id, 'local', local.updatedAt, batchId, now));
        conflictIssueIds.push(local.id);
      }
    } else {
      // 本地较新：保留本地状态，远程旧动作留冲突说明。
      merged.batchId = local.batchId;
      merged.updatedAt = local.updatedAt;
      const conflictId = `conflict-${local.id}-${local.batchId}`;
      if (!eventIds.has(conflictId)) {
        eventIds.add(conflictId);
        events.push(makeConflictNote(local.id, 'remote', remote.updatedAt, local.batchId, now));
        conflictIssueIds.push(local.id);
      }
    }

    // 将合并结果写回 issues 数组。
    const index = issues.findIndex((i) => i.id === local.id);
    if (index !== -1) {
      issues[index] = merged;
      issueByFingerprint.set(fingerprint, merged);
    }

    updatedFingerprints.push(fingerprint);
  }

  return { issues, events, addedFingerprints, updatedFingerprints, conflictIssueIds };
}

/** 统计唯一问题数（按指纹去重，避免重复导入重复累计）。 */
export function countUniqueIssues(issues: AuditIssue[]): number {
  return new Set(issues.map((issue) => issue.fingerprint)).size;
}
