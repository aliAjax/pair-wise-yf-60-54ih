import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import { computeFingerprint } from '../lib/fingerprint';
import {
  createPackage,
  downloadPackage,
  readPackageFile,
  validatePackage,
  validatePermission,
  packageToBatch,
} from '../lib/package';
import { mergePackage, countUniqueIssues } from '../lib/merge';
import {
  createImportSession,
  persistSessions,
  loadPersistedSessions,
  currentChunkIssues,
  advanceChunk,
  failSession,
  pauseSession,
  retrySession,
  continueSession,
  unfinishedCount,
  sessionStatusLabel,
  sourceLabel,
  tryPersistState,
} from '../lib/session';
import type {
  AuditEvent,
  AuditIssue,
  Batch,
  ImportSession,
  IssueStatus,
  OfflinePackage,
  PackageSource,
  Severity,
  WorkbenchState,
} from '../lib/types';

const seedIssues: AuditIssue[] = [
  { id: 'issue-1', fingerprint: computeFingerprint('结算弹窗关闭后焦点丢失', '订单结算'), title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', evidence: '', manualNote: '', batchId: 'local-seed', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
  { id: 'issue-2', fingerprint: computeFingerprint('错误提示未与输入框关联', '账户设置'), title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', evidence: '', manualNote: '', batchId: 'local-seed', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
];
const seedEvents: AuditEvent[] = [
  { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中', batchId: 'local-seed', valid: true },
  { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复', batchId: 'local-seed', valid: true }
];
const seed: WorkbenchState = { issues: seedIssues, events: seedEvents, batches: [], importSessions: [] };

function normalizeState(raw: Partial<WorkbenchState> | null): WorkbenchState {
  const issues: AuditIssue[] = (raw?.issues ?? seed.issues).map((issue) => ({
    ...issue,
    fingerprint: issue.fingerprint ?? computeFingerprint(issue.title, issue.flow),
    evidence: issue.evidence ?? '',
    manualNote: issue.manualNote ?? '',
    batchId: issue.batchId ?? 'local-seed',
  }));
  const events: AuditEvent[] = (raw?.events ?? seed.events).map((event) => ({
    ...event,
    batchId: event.batchId ?? 'local-seed',
    valid: event.valid ?? true,
    conflictNote: event.conflictNote,
  }));
  return {
    issues,
    events,
    batches: raw?.batches ?? [],
    importSessions: raw?.importSessions ?? [],
  };
}

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return normalizeState(seed);
  try {
    const raw = JSON.parse(localStorage.getItem('a11y-audit-v1') ?? 'null') as Partial<WorkbenchState> | null;
    return normalizeState(raw);
  } catch {
    return normalizeState(seed);
  }
}

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');

  // 离线合并相关状态
  const [exportSource, setExportSource] = createSignal<PackageSource>('audit');
  const [exportedBy, setExportedBy] = createSignal('审核员');
  const [exportNote, setExportNote] = createSignal('');
  const [importError, setImportError] = createSignal('');
  const [importInfo, setImportInfo] = createSignal('');
  const [isProcessing, setIsProcessing] = createSignal(false);

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const uniqueIssueCount = createMemo(() => countUniqueIssues(state.issues));
  const unfinishedSessions = createMemo(() => state.importSessions.filter((s) => s.status !== 'completed'));

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
  });

  // 重开后恢复未完成的导入会话。
  onMount(() => {
    const persisted = loadPersistedSessions();
    if (persisted.length > 0) {
      setState('importSessions', persisted);
    }
  });

  const addEvent = (issueId: string, message: string) => {
    setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message, batchId: 'local-seed', valid: true }, ...events]);
  };

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const now = new Date().toISOString();
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      fingerprint: computeFingerprint(values.title, values.flow),
      ...values,
      status: 'open',
      fixNote: '',
      retestNote: '',
      evidence: '',
      manualNote: '',
      batchId: 'local-seed',
      updatedAt: now,
    };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  // ===== 离线合并：导出 =====
  const handleExport = () => {
    const pkg = createPackage(state, exportSource(), exportedBy() || '未署名', exportNote() || undefined);
    setState('batches', (batches) => {
      if (batches.some((b) => b.id === pkg.batch.id)) return batches;
      return [...batches, packageToBatch(pkg)];
    });
    downloadPackage(pkg);
    setImportInfo(`已导出离线任务包（${sourceLabel(pkg.batch.source)}），批次 ${pkg.batch.id}`);
    setImportError('');
  };

  // ===== 离线合并：导入 =====
  const handleImportFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setImportError('');
    setImportInfo('');
    try {
      const raw = await readPackageFile(file);
      const validation = validatePackage(raw);
      if (!validation.ok) {
        setImportError(validation.error!);
        return;
      }
      const pkg = raw as OfflinePackage;
      const permCheck = validatePermission(pkg, state.issues);
      if (!permCheck.ok) {
        setImportError(permCheck.error!);
        return;
      }
      // 重复导入同一批次不重复累计。
      if (state.batches.some((b) => b.id === pkg.batch.id)) {
        setImportError('该批次已导入，重复导入不会重复累计');
        return;
      }
      const session = createImportSession(pkg);
      setState('importSessions', (sessions) => [...sessions, session]);
      persistSessions([...state.importSessions, session]);
      await processSessionChunk(session.id);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      input.value = '';
    }
  };

  // 处理会话的当前分片；失败则暂停并保留进度以便重试。
  const processSessionChunk = async (sessionId: string) => {
    setIsProcessing(true);
    setImportError('');
    try {
      // 从最新状态读取会话。
      const session = state.importSessions.find((s) => s.id === sessionId);
      if (!session) return;

      const chunkIssues = currentChunkIssues(session);
      if (chunkIssues.length === 0) {
        // 无更多分片，标记完成。
        setState('importSessions', (sessions) =>
          sessions.map((s) => (s.id === sessionId ? { ...s, status: 'completed', updatedAt: new Date().toISOString() } : s))
        );
        persistSessions(state.importSessions);
        setImportInfo(`批次 ${session.batchId} 导入完成`);
        return;
      }

      const chunkPkg: OfflinePackage = {
        ...session.packageData,
        issues: chunkIssues,
        events: session.packageData.events.filter((e) => chunkIssues.some((i) => i.id === e.issueId)),
      };

      const result = mergePackage(state, chunkPkg);

      // 容量校验：先尝试持久化新状态，失败则暂停本分片。
      const persistResult = tryPersistState({ ...state, issues: result.issues, events: result.events });
      if (!persistResult.ok) {
        setState('importSessions', (sessions) =>
          sessions.map((s) => (s.id === sessionId ? failSession(s, persistResult.error!) : s))
        );
        persistSessions(state.importSessions);
        setImportError(persistResult.error!);
        return;
      }

      // 持久化成功后再应用合并结果。
      setState('issues', result.issues);
      setState('events', result.events);

      // 推进分片。
      const updated = advanceChunk(session);
      setState('importSessions', (sessions) => sessions.map((s) => (s.id === sessionId ? updated : s)));

      if (updated.status === 'completed') {
        setState('batches', (batches) => {
          if (batches.some((b) => b.id === session.batchId)) return batches;
          return [...batches, packageToBatch(session.packageData)];
        });
        setImportInfo(`批次 ${session.batchId} 导入完成，新增 ${result.addedFingerprints.length} 条，更新 ${result.updatedFingerprints.length} 条`);
      } else {
        setImportInfo(`批次 ${session.batchId} 已处理 ${updated.currentChunk}/${updated.totalChunks} 分片，可继续续接`);
      }
      persistSessions(state.importSessions);
      void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetrySession = (sessionId: string) => {
    setState('importSessions', (sessions) => sessions.map((s) => (s.id === sessionId ? retrySession(s) : s)));
    void processSessionChunk(sessionId);
  };

  const handleContinueSession = (sessionId: string) => {
    setState('importSessions', (sessions) => sessions.map((s) => (s.id === sessionId ? continueSession(s) : s)));
    void processSessionChunk(sessionId);
  };

  const handlePauseSession = (sessionId: string) => {
    setState('importSessions', (sessions) => sessions.map((s) => (s.id === sessionId ? pauseSession(s) : s)));
    persistSessions(state.importSessions);
  };

  const handleContinueAll = async () => {
    const unfinished = state.importSessions.filter((s) => s.status !== 'completed');
    for (const session of unfinished) {
      // 逐个续接，直到完成或失败。
      let current = state.importSessions.find((s) => s.id === session.id);
      while (current && current.status !== 'completed' && current.status !== 'failed') {
        await processSessionChunk(session.id);
        current = state.importSessions.find((s) => s.id === session.id);
      }
    }
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
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'English' : '中文')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题（按指纹去重）</span><strong>{uniqueIssueCount()}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{issue.status}</span>
                  <span class="badge">{issue.severity}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                  <Show when={issue.batchId && issue.batchId !== 'local-seed'}>
                    <span class="badge" title={`归属批次：${issue.batchId}`}>批次 {issue.batchId.slice(0, 14)}</span>
                  </Show>
                </div>
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
                <Show when={issue.evidence}><p><strong>证据：</strong>{issue.evidence}</p></Show>
                <Show when={issue.manualNote}><p><strong>本地人工记录：</strong>{issue.manualNote}</p></Show>
                <p class="meta"><strong>问题指纹：</strong>{issue.fingerprint} · <strong>归属批次：</strong>{issue.batchId}</p>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        {/* 离线合并任务包 */}
        <section class="card" aria-labelledby="offline-merge-title" style="margin-top:18px">
          <h2 id="offline-merge-title">离线合并任务包</h2>
          <p>导出时带上审计问题、操作时间线和批次归属；导入时按问题指纹合并，保留本地人工记录。两端同一问题处置不同，以时间线最新有效动作归属为准。</p>
          <div class="grid" style="grid-template-columns:1fr 1fr">
            <div>
              <h3>导出任务包</h3>
              <label>来源
                <select value={exportSource()} onChange={(e) => setExportSource(e.currentTarget.value as PackageSource)}>
                  <option value="audit">审核员离线</option>
                  <option value="remote-fix">远程修复</option>
                </select>
              </label>
              <label>导出人<input value={exportedBy()} onInput={(e) => setExportedBy(e.currentTarget.value)} /></label>
              <label>备注<input value={exportNote()} onInput={(e) => setExportNote(e.currentTarget.value)} placeholder="可选" /></label>
              <button onClick={handleExport}>导出任务包（JSON）</button>
            </div>
            <div>
              <h3>导入任务包</h3>
              <label>选择任务包文件<input type="file" accept="application/json,.json" onChange={handleImportFile} disabled={isProcessing()} /></label>
              <Show when={importError()}><p class="error" role="alert">{importError()}</p></Show>
              <Show when={importInfo()}><p role="status" style="color:#0d6664">{importInfo()}</p></Show>
              <Show when={isProcessing()}><p role="status">正在处理分片…</p></Show>
            </div>
          </div>
        </section>

        {/* 批次来源 */}
        <section class="card" aria-labelledby="batch-list-title" style="margin-top:18px">
          <h2 id="batch-list-title">批次来源</h2>
          <Show when={state.batches.length === 0}><p>暂无导入批次。</p></Show>
          <For each={state.batches}>{(batch) => (
            <article class="issue">
              <h3>{sourceLabel(batch.source)} · {batch.exportedBy}</h3>
              <div class="meta">
                <span class="badge">{batch.id}</span>
                <span>导出时间：{new Date(batch.exportedAt).toLocaleString()}</span>
                <span>问题数：{batch.issueCount}</span>
                <span>事件数：{batch.eventCount}</span>
                <Show when={batch.note}><span>备注：{batch.note}</span></Show>
              </div>
            </article>
          )}</For>
        </section>

        {/* 未完成导入会话 */}
        <section class="card" aria-labelledby="session-list-title" style="margin-top:18px">
          <h2 id="session-list-title">未完成导入入口 <small>{unfinishedSessions().length} 个待续接</small></h2>
          <Show when={unfinishedSessions().length === 0}><p>所有导入均已完成。</p></Show>
          <For each={unfinishedSessions()}>{(session) => (
            <article class="issue">
              <h3>{sourceLabel(session.source)} · {session.exportedBy} <span class="badge">{sessionStatusLabel(session.status)}</span></h3>
              <div class="meta">
                <span class="badge">{session.batchId}</span>
                <span>进度：{session.currentChunk}/{session.totalChunks} 分片</span>
                <Show when={session.error}><span class="error">{session.error}</span></Show>
              </div>
              <div role="group" aria-label="导入会话操作" style="margin-top:8px">
                <Show when={session.status === 'failed'}>
                  <button onClick={() => handleRetrySession(session.id)} disabled={isProcessing()}>重试</button>{' '}
                </Show>
                <Show when={session.status === 'paused' || session.status === 'pending'}>
                  <button onClick={() => handleContinueSession(session.id)} disabled={isProcessing()}>续接</button>{' '}
                </Show>
                <button class="secondary" onClick={() => handlePauseSession(session.id)} disabled={isProcessing()}>暂停</button>
              </div>
            </article>
          )}</For>
          <Show when={unfinishedSessions().length > 0}>
            <button onClick={handleContinueAll} disabled={isProcessing()} style="margin-top:12px">全部续接</button>
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
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div><Show when={event.conflictNote}><div class="error" style="font-size:13px;margin-top:4px">冲突说明：{event.conflictNote}</div></Show></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
