/**
 * 问题指纹：跨离线/在线副本唯一标识同一问题。
 * 基于标题与业务流程的归一化内容生成，与具体实例 id 无关。
 */
export function computeFingerprint(title: string, flow: string): string {
  const normalized = `${title.trim().toLowerCase()}|${flow.trim().toLowerCase()}`;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `fp-${(hash >>> 0).toString(36)}`;
}

/** 为问题补齐指纹（迁移旧数据时使用）。 */
export function withFingerprint<T extends { title: string; flow: string; fingerprint?: string }>(issue: T): T & { fingerprint: string } {
  return { ...issue, fingerprint: issue.fingerprint ?? computeFingerprint(issue.title, issue.flow) };
}
