/**
 * Interrupt CONTINUATION for neuron steps.
 *
 * George's definition of an interrupt: "it should basically be 'continuing'
 * the turn just with the new context... the run stops and saves states and
 * appends that message and reruns."
 *
 * The interrupted run (A) keeps a per-step record of its in-flight work in
 * Redis (`run:step-resume:{runA}`, field = step key):
 *   - API neurons: the tool-loop transcript (system/user/assistant tool_calls/
 *     tool results), written after every iteration and on abort, with a
 *     synthetic "interrupted before completion" result for any call that never
 *     returned.
 *   - CLI neurons (claude-code, agy-cli): the session/conversation id (known
 *     before or captured the moment the CLI emits it) and, on abort, the CLI's
 *     own transcript files, so the session can be resumed on any worker.
 * A completed step deletes its record.
 *
 * The continuing run (B) is started with `resumeFromRunId = A`, which the
 * engine surfaces as `state.data.previousRun`. When B executes the SAME step
 * (same graph node id + step index) it consumes A's record: the API loop is
 * seeded with A's messages and the CLI `--resume`s A's session, then the new
 * prompt is appended behind an [INTERRUPT NOTICE]. Nothing per graph beyond
 * passing `resumeFromRunId`. A step opts out with `continueInterrupted: false`.
 *
 * Not checkpoint-based on purpose: LangGraph only checkpoints at node
 * boundaries, and an interrupted node never reaches one.
 */
import * as zlib from 'zlib';
import { RunKeys } from './types';
import { getRunPublisher } from './contextLookup';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export interface StepResumeRedis {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Serialisable message, provider-neutral (LangChain message fields). */
export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: Array<{ id?: string; name: string; args: AnyObject; type?: string }>;
  tool_call_id?: string;
  name?: string;
  additional_kwargs?: AnyObject;
}

export interface StepResumeRecord {
  v: 1;
  stepKey: string;
  kind: 'api' | 'cli';
  status: 'in-progress' | 'interrupted';
  neuronId?: string;
  updatedAt: number;
  /** API: the loop transcript. */
  messages?: StoredMessage[];
  /** CLI: 'claude-code' | 'agy-cli' | … */
  cli?: string;
  /** CLI: session (claude) or conversation (agy) id. */
  sessionId?: string;
  /** CLI: transcript files (relative path -> base64 gzip). */
  files?: Record<string, string>;
}

export const STEP_RESUME_TTL_SECONDS_DEFAULT = 24 * 60 * 60;
export const MAX_TOOL_RESULT_CHARS = 40_000;
export const MAX_RECORD_BYTES = 6 * 1024 * 1024;
export const INTERRUPTED_TOOL_RESULT =
  'Interrupted before completion: the run was stopped while this tool call was running, so its result is unknown. ' +
  'Re-run it only if you still need it.';
export const INTERRUPT_NOTICE_TAG = '[INTERRUPT NOTICE]';
/** Minimum spacing of the periodic API transcript copy (see StepResumeTracker.checkpoint). */
export const CHECKPOINT_MIN_INTERVAL_MS = 60_000;

export function stepResumeTtlSeconds(): number {
  const raw = Number(process.env.STEP_RESUME_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : STEP_RESUME_TTL_SECONDS_DEFAULT;
}

/**
 * Stable identity of "this step" across two runs of the same graph:
 * graph node id + step index (set by universalNode), falling back to the
 * step's outputField.
 */
export function stepResumeKey(state: AnyObject, config: AnyObject): string {
  const node = typeof state?._currentGraphNodeId === 'string' ? state._currentGraphNodeId : '';
  const idx = typeof state?._currentStepIndex === 'number' ? state._currentStepIndex : undefined;
  if (node && idx !== undefined) return `${node}#${idx}`;
  return `out:${String(config?.outputField || 'neuron')}`;
}

/** The interrupted run this run continues, if any (and the step allows it). */
export function previousRunIdFor(state: AnyObject, config: AnyObject): string | undefined {
  if (config?.continueInterrupted === false) return undefined;
  const pr = state?.data?.previousRun ?? state?.previousRun;
  const id = pr?.runId;
  return typeof id === 'string' && id ? id : undefined;
}

export async function saveStepResume(
  redis: StepResumeRedis,
  runId: string,
  record: StepResumeRecord,
): Promise<void> {
  const key = RunKeys.stepResume(runId);
  let body = JSON.stringify(record);
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES && record.messages) {
    body = JSON.stringify({ ...record, messages: shrinkMessages(record.messages, MAX_RECORD_BYTES) });
  }
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) {
    // Still too big (CLI transcript): keep the id, drop the files. A CLI
    // resume then starts a fresh session with the notice (logged by caller).
    body = JSON.stringify({ ...record, files: undefined, messages: undefined, tooLarge: true });
  }
  await redis.hset(key, record.stepKey, body);
  await redis.expire(key, stepResumeTtlSeconds());
}

export async function deleteStepResume(redis: StepResumeRedis, runId: string, stepKey: string): Promise<void> {
  await redis.hdel(RunKeys.stepResume(runId), stepKey);
}

export async function loadStepResume(
  redis: StepResumeRedis,
  runId: string,
  stepKey: string,
): Promise<StepResumeRecord | null> {
  const raw = await redis.hget(RunKeys.stepResume(runId), stepKey);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as StepResumeRecord;
    return rec && rec.v === 1 ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Load the interrupted run's record for this step, waiting briefly while the
 * interrupted step is still writing its final state (`in-progress`): the
 * continuing run is queued ~2 s after the interrupt, and a CLI step needs a
 * moment to copy its transcript after the child is killed.
 */
export async function awaitStepResume(
  redis: StepResumeRedis,
  runId: string,
  stepKey: string,
  opts: { kind?: 'api' | 'cli'; maxWaitMs?: number; pollMs?: number } = {},
): Promise<StepResumeRecord | null> {
  const maxWait = opts.maxWaitMs ?? 15_000;
  const poll = opts.pollMs ?? 500;
  const deadline = Date.now() + maxWait;
  let rec = await loadStepResume(redis, runId, stepKey);
  while (rec && rec.status === 'in-progress' && (opts.kind ?? rec.kind) === 'cli' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, poll));
    rec = await loadStepResume(redis, runId, stepKey);
  }
  return rec;
}

// ─── Messages ────────────────────────────────────────────────────────────────

function messageType(m: AnyObject): string {
  if (m && typeof m._getType === 'function') {
    try {
      return m._getType();
    } catch {
      /* fall through */
    }
  }
  if (m && typeof m.getType === 'function') {
    try {
      return m.getType();
    } catch {
      /* fall through */
    }
  }
  const r = String(m?.role || m?.type || '');
  // A provider response handed back as a plain object (tests, some adapters).
  if (!r && m && Array.isArray(m.tool_calls)) return 'ai';
  return r;
}

const DATA_URL_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

function slimContent(content: unknown, isToolResult: boolean): unknown {
  if (typeof content === 'string') {
    const s = content.replace(DATA_URL_RE, '[image omitted on resume]');
    return isToolResult && s.length > MAX_TOOL_RESULT_CHARS
      ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated on resume: ${s.length} chars]`
      : s;
  }
  if (Array.isArray(content)) {
    return content.map((part: AnyObject) => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'image_url' || part.type === 'image' || part.type === 'media') {
        return { type: 'text', text: '[image omitted on resume]' };
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: slimContent(part.text, isToolResult) };
      }
      return part;
    });
  }
  return content;
}

/** Any LangChain message / plain {role} object -> StoredMessage. */
export function toStoredMessage(m: AnyObject): StoredMessage | null {
  const t = messageType(m);
  const role: StoredMessage['role'] | null =
    t === 'system' ? 'system'
    : t === 'human' || t === 'user' ? 'user'
    : t === 'ai' || t === 'assistant' ? 'assistant'
    : t === 'tool' ? 'tool'
    : null;
  if (!role) return null;
  const out: StoredMessage = { role, content: slimContent(m.content, role === 'tool') };
  if (role === 'assistant') {
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c: AnyObject) => ({
        id: c.id,
        name: c.name,
        args: c.args ?? {},
        type: 'tool_call',
      }));
    }
    if (m.additional_kwargs && typeof m.additional_kwargs === 'object' && Object.keys(m.additional_kwargs).length) {
      try {
        out.additional_kwargs = JSON.parse(JSON.stringify(m.additional_kwargs));
      } catch {
        /* non-serialisable extras are dropped */
      }
    }
  }
  if (role === 'tool') {
    out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
  }
  return out;
}

/**
 * Every assistant tool_call must be answered by a tool message before the
 * next non-tool message (Anthropic, OpenAI and Gemini all reject a dangling
 * call). Inserts a synthetic "interrupted before completion" result for each
 * call that never got one.
 */
export function closeDanglingToolCalls(messages: StoredMessage[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      if (messages[j].tool_call_id) answered.add(String(messages[j].tool_call_id));
      out.push(messages[j]);
      j++;
    }
    for (const c of m.tool_calls) {
      if (c.id && !answered.has(String(c.id))) {
        out.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: INTERRUPTED_TOOL_RESULT });
      }
    }
    i = j - 1;
  }
  return out;
}

export function toStoredTranscript(messages: AnyObject[]): StoredMessage[] {
  return closeDanglingToolCalls(messages.map(toStoredMessage).filter((m): m is StoredMessage => !!m));
}

/** Shrink tool results (oldest first) until the transcript fits `maxBytes`. */
export function shrinkMessages(messages: StoredMessage[], maxBytes: number): StoredMessage[] {
  const out = messages.map((m) => ({ ...m }));
  for (let i = 0; i < out.length && Buffer.byteLength(JSON.stringify(out)) > maxBytes; i++) {
    if (out[i].role === 'tool') out[i].content = '[tool result dropped on resume to save space]';
  }
  return out;
}

export function noticeFor(newPrompt: string): string {
  if (newPrompt.includes(INTERRUPT_NOTICE_TAG)) return newPrompt;
  return (
    `${INTERRUPT_NOTICE_TAG} You were interrupted mid-turn. Everything above is your own work so far, exactly as ` +
    `you left it; a tool call that was still running did not finish. A new message has arrived. Decide from it ` +
    `whether to continue the interrupted work or pivot: do not redo work you already did, and if the new message ` +
    `is about something else, answer it and say what is left of the earlier task.\n\nNew message:\n${newPrompt}`
  );
}

/** Text of a user message's content (string or parts). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: AnyObject) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

// ─── CLI transcript files ────────────────────────────────────────────────────

export function packFile(buf: Buffer): string {
  return zlib.gzipSync(buf).toString('base64');
}

export function unpackFile(b64: string): Buffer {
  return zlib.gunzipSync(Buffer.from(b64, 'base64'));
}

/** Claude Code's transcript directory slug for a cwd (`/a/b c` -> `-a-b-c`). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// ─── Restore + the per-step tracker ──────────────────────────────────────────

/** StoredMessage -> LangChain message (lazy import keeps this module light for tests). */
export function fromStoredMessage(m: StoredMessage): AnyObject {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lc = require('@langchain/core/messages');
  switch (m.role) {
    case 'system':
      return new lc.SystemMessage({ content: m.content as never });
    case 'user':
      return new lc.HumanMessage({ content: m.content as never });
    case 'assistant':
      return new lc.AIMessage({
        content: (m.content ?? '') as never,
        tool_calls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args ?? {}, type: 'tool_call' })),
        additional_kwargs: m.additional_kwargs ?? {},
      });
    case 'tool':
    default:
      return new lc.ToolMessage({
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        tool_call_id: String(m.tool_call_id ?? ''),
        ...(m.name ? { name: m.name } : {}),
      });
  }
}

/**
 * The continuing run's opening: FRESH system message(s) from this run, the
 * interrupted run's transcript (its own system dropped), then this run's new
 * user turn behind the interrupt notice.
 */
export function buildContinuedMessages(baseMessages: AnyObject[], resumed: StoredMessage[]): AnyObject[] {
  const freshSystem = baseMessages.filter((m) => messageType(m) === 'system');
  let lastUser = -1;
  for (let i = baseMessages.length - 1; i >= 0; i--) {
    const t = messageType(baseMessages[i]);
    if (t === 'human' || t === 'user') {
      lastUser = i;
      break;
    }
  }
  const history = closeDanglingToolCalls(resumed.filter((m) => m.role !== 'system')).map(fromStoredMessage);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lc = require('@langchain/core/messages');
  const newUser = lastUser >= 0 ? baseMessages[lastUser] : null;
  const newContent = newUser?.content;
  let continued: AnyObject;
  if (Array.isArray(newContent)) {
    const text = contentText(newContent);
    const rest = newContent.filter((p: AnyObject) => !(p && p.type === 'text'));
    continued = new lc.HumanMessage({ content: [{ type: 'text', text: noticeFor(text) }, ...rest] as never });
  } else {
    continued = new lc.HumanMessage({ content: noticeFor(contentText(newContent ?? '')) });
  }
  return [...freshSystem, ...history, continued];
}

/**
 * One neuron step's continuation bookkeeping. Never throws: every Redis
 * failure degrades to "no continuation", exactly today's behaviour.
 */
export class StepResumeTracker {
  /** The interrupted run's record this step continues (consumed). */
  resumed: StepResumeRecord | null = null;
  private lastSavedCount = -1;
  private lastSavedAt = 0;
  private messagesRef: AnyObject[] | null = null;

  private constructor(
    private readonly redis: StepResumeRedis | null,
    readonly runId: string | null,
    readonly stepKey: string,
    readonly kind: 'api' | 'cli',
    readonly neuronId: string | undefined,
    readonly previousRunId: string | undefined,
  ) {}

  static async create(
    state: AnyObject,
    config: AnyObject,
    kind: 'api' | 'cli',
    neuronId?: string,
    deps?: { redis?: StepResumeRedis | null; log?: (msg: string) => void },
  ): Promise<StepResumeTracker> {
    let redis: StepResumeRedis | null = deps?.redis ?? null;
    if (!deps || deps.redis === undefined) {
      try {
        redis = getRunPublisher(state)?.getRedisClient?.() ?? null;
      } catch {
        redis = null;
      }
    }
    const runId = (state?.runId || state?.data?.runId || null) as string | null;
    const tracker = new StepResumeTracker(
      redis,
      runId,
      stepResumeKey(state, config),
      kind,
      neuronId,
      previousRunIdFor(state, config),
    );
    if (redis && tracker.previousRunId && tracker.previousRunId !== runId) {
      try {
        const rec = await awaitStepResume(redis, tracker.previousRunId, tracker.stepKey, { kind });
        if (rec && rec.kind === kind) {
          tracker.resumed = rec;
          // Consumed: a second execution of this step in THIS run (a loop)
          // must not be seeded again.
          await deleteStepResume(redis, tracker.previousRunId, tracker.stepKey);
          (deps?.log ?? console.log)(
            `[StepResume] ${tracker.stepKey}: continuing interrupted run ${tracker.previousRunId} ` +
              `(${kind}${rec.messages ? `, ${rec.messages.length} messages` : ''}${rec.sessionId ? `, session ${rec.sessionId}` : ''})`,
          );
        }
      } catch (err) {
        (deps?.log ?? console.warn)(`[StepResume] load failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return tracker;
  }

  get enabled(): boolean {
    return !!this.redis && !!this.runId;
  }

  /** API: the opening messages for this step (seeded when continuing). */
  seed(baseMessages: AnyObject[]): AnyObject[] {
    const msgs = this.resumed?.messages?.length
      ? buildContinuedMessages(baseMessages, this.resumed.messages)
      : [...baseMessages];
    this.messagesRef = msgs;
    return msgs;
  }

  /**
   * API: persist the transcript so far (call at each iteration boundary).
   * Throttled: an interrupt saves the exact transcript in onError() anyway;
   * this periodic copy only covers a process that dies outright.
   */
  async checkpoint(messages: AnyObject[] = this.messagesRef ?? []): Promise<void> {
    if (!this.enabled || messages.length === this.lastSavedCount) return;
    const now = Date.now();
    if (now - this.lastSavedAt < CHECKPOINT_MIN_INTERVAL_MS) return;
    this.lastSavedAt = now;
    this.lastSavedCount = messages.length;
    await this.save({ status: 'in-progress', messages: toStoredTranscript(messages) });
  }

  /** CLI: record the session id the moment it is known. */
  async recordSession(cli: string, sessionId: string): Promise<void> {
    if (!this.enabled || !sessionId) return;
    await this.save({ status: 'in-progress', cli, sessionId });
  }

  /** CLI: the step ended without completing — keep the transcript files. */
  async recordInterruptedCli(cli: string, sessionId: string, files: Record<string, string>): Promise<void> {
    if (!this.enabled || !sessionId) return;
    await this.save({ status: 'interrupted', cli, sessionId, files });
  }

  /** The step finished: nothing to continue. */
  async complete(): Promise<void> {
    if (!this.enabled) return;
    try {
      await deleteStepResume(this.redis!, this.runId!, this.stepKey);
    } catch {
      /* best-effort */
    }
  }

  /** API: the step threw. Interrupt => keep a well-formed transcript; else drop it. */
  async onError(err: unknown, aborted: boolean): Promise<void> {
    if (!this.enabled) return;
    if (aborted && this.kind === 'api' && this.messagesRef) {
      await this.save({ status: 'interrupted', messages: toStoredTranscript(this.messagesRef) });
      return;
    }
    if (!aborted) await this.complete();
    void err;
  }

  private async save(partial: Partial<StepResumeRecord>): Promise<void> {
    try {
      await saveStepResume(this.redis!, this.runId!, {
        v: 1,
        stepKey: this.stepKey,
        kind: this.kind,
        status: 'in-progress',
        neuronId: this.neuronId,
        updatedAt: Date.now(),
        ...partial,
      } as StepResumeRecord);
    } catch (err) {
      console.warn(`[StepResume] save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
