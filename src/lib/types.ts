export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type PackageSource = 'audit' | 'remote-fix';
export type SessionStatus = 'pending' | 'paused' | 'failed' | 'completed';

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
  evidence: string;
  manualNote: string;
  batchId: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
  batchId: string;
  valid: boolean;
  conflictNote?: string;
}

export interface Batch {
  id: string;
  source: PackageSource;
  exportedAt: string;
  exportedBy: string;
  note?: string;
  issueCount: number;
  eventCount: number;
}

export interface OfflinePackage {
  format: 'a11y-audit-package';
  version: 1;
  batch: {
    id: string;
    source: PackageSource;
    exportedAt: string;
    exportedBy: string;
    note?: string;
  };
  issues: AuditIssue[];
  events: AuditEvent[];
}

export interface ImportSession {
  id: string;
  batchId: string;
  source: PackageSource;
  exportedBy: string;
  packageData: OfflinePackage;
  status: SessionStatus;
  processedFingerprints: string[];
  failedFingerprints: string[];
  currentChunk: number;
  totalChunks: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchState {
  issues: AuditIssue[];
  events: AuditEvent[];
  batches: Batch[];
  importSessions: ImportSession[];
}
