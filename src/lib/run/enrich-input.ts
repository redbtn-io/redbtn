/**
 * Unified Input Enrichment Pipeline
 *
 * Transforms a raw TriggeredRun input into a fully-enriched graph input by:
 *
 *   1. Loading the automation document (if automationId is set)
 *      → resolves graphId, configOverrides, secretNames, inputMapping
 *   2. Loading the conversation document (if conversationId is set)
 *      → merges graphInputs + inputSchema defaults
 *   3. Resolving {{secret:NAME}} placeholders + injecting _secrets map
 *   4. Resolving {{state:namespace.key}} refs + injecting _state map
 *   5. Injecting _configOverrides (automation + conversation merged)
 *   6. Injecting _automation metadata when automationId is present
 *   7. Injecting _trigger with the canonical Trigger descriptor
 *
 * Both the graph processor and the automation processor can call this helper.
 * It preserves ALL existing enrichment logic from the automation processor
 * and extends it with conversation-level enrichment previously done inline
 * in the chat completions API route.
 *
 * Phase 1 of the Unified Run/Trigger architecture.
 * See: explanations/UNIFIED-RUN-TRIGGERS.md
 *
 * @module lib/run/enrich-input
 */

import type { TriggeredRun, EnrichedInput, EnrichmentResult, Trigger } from './trigger-types';

// =============================================================================
// Types for lazy-loaded DB dependencies
// =============================================================================

/** Minimal automation document shape needed for enrichment */
interface AutomationDoc {
  automationId: string;
  graphId?: string;
  userId: string;
  inputMapping?: Record<string, unknown>;
  configOverrides?: Record<string, unknown>;
  secretNames?: string[];
  concurrency?: 'allow' | 'skip' | 'queue';
  scheduleMode?: 'cron' | 'interval';
}

/** Minimal conversation document shape */
interface ConversationDoc {
  graphInputs?: Record<string, unknown>;
  graphId?: string;
}

/** Minimal graph document shape (for inputSchema defaults) */
interface GraphDoc {
  graphId: string;
  inputSchema?: Array<{ key: string; default?: unknown }>;
}

// =============================================================================
// Secret-placeholder regex constants (mirrors automation processor)
// =============================================================================

const PLACEHOLDER_RE = /^\{\{secret:([^}]+)\}\}$/;
const STATE_INLINE_RE = /\{\{state:([^.}]+)\.([^}]+)\}\}/g;
const STATE_EXACT_RE = /^\{\{state:([^.}]+)\.([^}]+)\}\}$/;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Detect {{secret:NAME}} placeholder names in a flat input object.
 * Scans string values at the top level (nested objects are not scanned —
 * same behaviour as the existing automation processor).
 */
function detectSecretPlaceholders(input: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === 'string') {
      const m = v.match(PLACEHOLDER_RE);
      if (m) names.push(m[1]!);
    }
  }
  return names;
}

/**
 * Replace {{secret:NAME}} placeholders in top-level string values.
 * Returns a new object; does not mutate the original.
 */
function replacePlaceholders(
  input: Record<string, unknown>,
  resolved: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    const m = v.match(PLACEHOLDER_RE);
    if (!m) continue;
    const secretName = m[1]!;
    const secretValue = resolved[secretName];
    if (secretValue !== undefined) {
      out[k] = secretValue;
    }
  }
  return out;
}

/**
 * Collect all unique {{state:namespace.key}} references in top-level string values.
 */
function detectStateRefs(
  input: Record<string, unknown>,
): Map<string, { namespace: string; key: string }> {
  const refs = new Map<string, { namespace: string; key: string }>();
  for (const v of Object.values(input)) {
    if (typeof v !== 'string') continue;
    for (const match of v.matchAll(STATE_INLINE_RE)) {
      const refKey = `${match[1]}.${match[2]}`;
      if (!refs.has(refKey)) {
        refs.set(refKey, { namespace: match[1]!, key: match[2]! });
      }
    }
  }
  return refs;
}

/**
 * Replace {{state:namespace.key}} inline and exact placeholders with resolved values.
 * Returns a new object; does not mutate the original.
 */
function replaceStateRefs(
  input: Record<string, unknown>,
  resolved: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };

  // 1. Inline substitution: replace occurrences within larger strings
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    const replaced = v.replace(STATE_INLINE_RE, (_match, ns, key) => {
      const refKey = `${ns}.${key}`;
      const val = resolved[refKey];
      if (val === undefined) return _match; // leave unresolved refs intact
      return typeof val === 'string' ? val : JSON.stringify(val);
    });
    if (replaced !== v) out[k] = replaced;
  }

  // 2. Exact match: preserve native type (number, boolean, object)
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    const exactMatch = v.match(STATE_EXACT_RE);
    if (!exactMatch) continue;
    const refKey = `${exactMatch[1]}.${exactMatch[2]}`;
    const val = resolved[refKey];
    if (val !== undefined) out[k] = val;
  }

  return out;
}

// =============================================================================
// Lazy DB helpers (dynamic-import pattern to avoid circular dependencies)
// =============================================================================

/**
 * Load (or lazily register) the Automation mongoose model.
 * Mirrors the pattern used in the automation processor.
 */
async function getAutomationModel(): Promise<import('mongoose').Model<any>> {
  const mongoose = (await import('mongoose')).default;
  try {
    return mongoose.model('Automation');
  } catch {
    const s = new mongoose.Schema({}, { collection: 'automations', strict: false });
    return mongoose.model('Automation', s);
  }
}

/**
 * Load (or lazily register) the Conversation mongoose model.
 */
async function getConversationModel(): Promise<import('mongoose').Model<any>> {
  const mongoose = (await import('mongoose')).default;
  try {
    return mongoose.model('Conversation');
  } catch {
    const s = new mongoose.Schema({}, { collection: 'user_conversations', strict: false });
    return mongoose.model('Conversation', s);
  }
}

/**
 * Load (or lazily register) the GlobalStateNamespace model with a getValue static.
 * Mirrors the pattern used in the automation processor.
 */
async function getGlobalStateModel(): Promise<import('mongoose').Model<any>> {
  const mongoose = (await import('mongoose')).default;
  try {
    return mongoose.model('GlobalStateNamespace');
  } catch {
    const stateSchema = new mongoose.Schema({}, {
      collection: 'globalstatenamespaces',
      strict: false,
    });
    stateSchema.statics.getValue = async function (
      uid: string,
      ns: string,
      k: string,
    ): Promise<unknown> {
      const doc = await this.findOne(
        { userId: uid, namespace: ns },
        { entries: { $elemMatch: { key: k } } },
      ).lean() as any;
      if (!doc?.entries?.length) return undefined;
      const entry = doc.entries[0];
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return undefined;
      return entry.value;
    };
    return mongoose.model('GlobalStateNamespace', stateSchema);
  }
}

// =============================================================================
// Step 1: Load automation document
// =============================================================================

async function loadAutomationDoc(
  automationId: string,
): Promise<AutomationDoc | null> {
  try {
    const AutomationModel = await getAutomationModel();
    const doc = await AutomationModel.findOne({ automationId }).lean() as any;
    return doc ?? null;
  } catch (err) {
    console.warn(`[enrich-input] Failed to load automation ${automationId}:`, err);
    return null;
  }
}

// =============================================================================
// Step 2: Load conversation document + inputSchema defaults
// =============================================================================

async function loadConversationEnrichment(
  conversationId: string,
  graphId: string | undefined,
): Promise<{ graphInputs: Record<string, unknown>; schemaDefaults: Record<string, unknown> }> {
  const graphInputs: Record<string, unknown> = {};
  const schemaDefaults: Record<string, unknown> = {};

  try {
    const mongoose = (await import('mongoose')).default;
    const MongooseObjectId = mongoose.Types.ObjectId;

    if (MongooseObjectId.isValid(conversationId)) {
      const ConvModel = await getConversationModel();
      const conv = await ConvModel.findById(new MongooseObjectId(conversationId)).lean() as ConversationDoc | null;
      if (conv?.graphInputs && typeof conv.graphInputs === 'object') {
        Object.assign(graphInputs, conv.graphInputs);
      }
    }
  } catch (err) {
    console.warn(`[enrich-input] Failed to load conversation ${conversationId}:`, err);
  }

  // Load inputSchema defaults for fields not already in graphInputs
  if (graphId) {
    try {
      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (db) {
        const graph = await db.collection('graphs').findOne(
          { graphId },
          { projection: { inputSchema: 1 } },
        ) as GraphDoc | null;
        if (graph?.inputSchema && Array.isArray(graph.inputSchema)) {
          for (const field of graph.inputSchema) {
            if (field.default !== undefined && graphInputs[field.key] === undefined) {
              schemaDefaults[field.key] = field.default;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[enrich-input] Failed to load inputSchema defaults for ${graphId}:`, err);
    }
  }

  return { graphInputs, schemaDefaults };
}

// =============================================================================
// Step 3: Resolve secrets
// =============================================================================

async function resolveSecrets(
  input: Record<string, unknown>,
  userId: string,
  automationDoc: AutomationDoc | null,
  runId: string,
): Promise<{ resolvedSecrets: Record<string, string>; enriched: Record<string, unknown> }> {
  const resolvedSecrets: Record<string, string> = {};

  // Collect secret names: explicit list from automation + auto-detected placeholders
  const detectedNames = detectSecretPlaceholders(input);
  const secretNames = [
    ...new Set([
      ...(automationDoc?.secretNames ?? []),
      ...detectedNames,
    ]),
  ];

  if (secretNames.length === 0) {
    return { resolvedSecrets, enriched: input };
  }

  try {
    // We use redsecrets repository directly, same as the automation processor.
    // Dynamic import so the engine does not take a hard compile-time dep on redsecrets
    // (it may not be installed in all consumers).
    const { repository: secretsRepo } = await import('@redbtn/redsecrets' as any);
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) {
      console.warn(`[enrich-input] MongoDB not connected — cannot resolve secrets for run ${runId}`);
      return { resolvedSecrets, enriched: input };
    }

    const scopeId = automationDoc?.automationId ?? userId;
    const scope = automationDoc ? 'automation' : 'user';

    const batch = await secretsRepo.resolve(db, {
      names: secretNames,
      appName: 'redbtn',
      scope,
      scopeId,
    }, 'secrets');

    Object.assign(resolvedSecrets, batch);

    if (Object.keys(resolvedSecrets).length > 0) {
      console.log(`[enrich-input] Resolved ${Object.keys(resolvedSecrets).length} secret(s) for run ${runId}`);
    }
  } catch (err) {
    console.error(`[enrich-input] Failed to resolve secrets for run ${runId}:`, err);
  }

  // Replace placeholders in input values
  const enriched = replacePlaceholders(input, resolvedSecrets);

  return { resolvedSecrets, enriched };
}

// =============================================================================
// Step 4: Resolve global-state refs
// =============================================================================

async function resolveStateRefs(
  input: Record<string, unknown>,
  userId: string,
  runId: string,
): Promise<{ resolvedState: Record<string, unknown>; enriched: Record<string, unknown> }> {
  const resolvedState: Record<string, unknown> = {};

  const stateRefs = detectStateRefs(input);
  if (stateRefs.size === 0) {
    return { resolvedState, enriched: input };
  }

  try {
    const GlobalStateModel = await getGlobalStateModel();

    for (const [refKey, { namespace, key }] of stateRefs) {
      try {
        const value = await (GlobalStateModel as any).getValue(userId, namespace, key);
        if (value !== undefined && value !== null) {
          resolvedState[refKey] = value;
          console.log(`[enrich-input] Resolved state ref {{state:${refKey}}} for run ${runId}`);
        } else {
          console.warn(`[enrich-input] State ref {{state:${refKey}}} not found or expired — leaving unresolved`);
        }
      } catch (err) {
        console.warn(`[enrich-input] Failed to resolve state ref {{state:${refKey}}}:`, err);
      }
    }
  } catch (err) {
    console.error(`[enrich-input] Failed to access global state model for run ${runId}:`, err);
    return { resolvedState, enriched: input };
  }

  if (Object.keys(resolvedState).length === 0) {
    return { resolvedState, enriched: input };
  }

  const enriched = replaceStateRefs(input, resolvedState);
  return { resolvedState, enriched };
}

// =============================================================================
// Main export: enrichInput()
// =============================================================================

/**
 * Options for enrichInput(). All optional fields follow the TriggeredRun shape.
 */
export interface EnrichInputOptions {
  /** Resolved or generated run ID (for logging) */
  runId: string;
  /** User ID (required for secret scoping + state lookups) */
  userId: string;
  /** Graph ID — may be resolved from automationDoc if omitted */
  graphId?: string;
  /** Raw input from the trigger source */
  input: Record<string, unknown>;
  /** Trigger descriptor forwarded into _trigger */
  trigger: Trigger;
  /** Automation ID — enables automation-specific enrichment */
  automationId?: string;
  /** Conversation ID — enables conversation graphInputs + schema defaults */
  conversationId?: string;
}

/**
 * Enrich a raw graph input with secrets, global-state values, configOverrides,
 * automation metadata, and trigger information.
 *
 * This is the single source of truth for input enrichment. Both the graph
 * processor (chat path) and the automation processor call this function
 * instead of duplicating enrichment logic.
 *
 * @returns EnrichmentResult containing the fully enriched input and derived metadata
 */
export async function enrichInput(options: EnrichInputOptions): Promise<EnrichmentResult> {
  const {
    runId,
    userId,
    trigger,
    automationId,
    conversationId,
  } = options;

  let { graphId, input } = options;

  // ── Step 1: Load automation document ────────────────────────────────────────
  let automationDoc: AutomationDoc | null = null;
  if (automationId) {
    automationDoc = await loadAutomationDoc(automationId);

    // Resolve graphId from automation if not explicitly provided
    if (!graphId && automationDoc?.graphId) {
      graphId = automationDoc.graphId;
      console.log(`[enrich-input] Resolved graphId from automation ${automationId}: ${graphId}`);
    }

    // Merge inputMapping (automation defaults) under raw input (raw values take precedence)
    if (automationDoc?.inputMapping && typeof automationDoc.inputMapping === 'object') {
      input = { ...automationDoc.inputMapping, ...input };
    }
  }

  // ── Step 2: Load conversation graphInputs + schema defaults ─────────────────
  if (conversationId) {
    const { graphInputs, schemaDefaults } = await loadConversationEnrichment(conversationId, graphId);

    // Merge order: schemaDefaults < graphInputs < raw input
    input = { ...schemaDefaults, ...graphInputs, ...input };
  }

  // ── Step 3: Inject webhook/event-specific data (passed as part of input) ───
  // No-op: callers are responsible for merging webhookPayload / eventData
  // into the raw input before calling enrichInput(). The automation processor
  // already does this in its fullInput construction step.

  // ── Step 4: Resolve secrets ─────────────────────────────────────────────────
  const { resolvedSecrets, enriched: afterSecrets } =
    await resolveSecrets(input, userId, automationDoc, runId);
  input = afterSecrets;

  // ── Step 5: Resolve global-state refs ───────────────────────────────────────
  const { resolvedState, enriched: afterState } =
    await resolveStateRefs(input, userId, runId);
  input = afterState;

  // ── Step 6: Build enriched input with system fields ──────────────────────────
  const enriched: EnrichedInput = { ...input };

  // _secrets — only inject when at least one was resolved
  if (Object.keys(resolvedSecrets).length > 0) {
    enriched._secrets = resolvedSecrets;
  }

  // _state — only inject when at least one was resolved
  if (Object.keys(resolvedState).length > 0) {
    enriched._state = resolvedState;
  }

  // _configOverrides — merge automation overrides (automation wins over nothing;
  // future: conversation-level overrides would be merged here too)
  const configOverrides: Record<string, unknown> = {};
  if (automationDoc?.configOverrides && typeof automationDoc.configOverrides === 'object') {
    Object.assign(configOverrides, automationDoc.configOverrides);
  }
  if (Object.keys(configOverrides).length > 0) {
    enriched._configOverrides = configOverrides;
  }

  // _automation — metadata for graph nodes that need to know they're in an automation
  if (automationId) {
    enriched._automation = {
      automationId,
      triggeredBy: trigger.type,
      runId,
    };
  }

  // _trigger — canonical trigger descriptor (replaces ad-hoc state.data.triggerType)
  enriched._trigger = trigger;

  // ── Derive execution timeout from input (automation pattern) ─────────────────
  const timeoutMs = Number(enriched.timeout) || 0;

  return {
    input: enriched,
    graphId: graphId ?? '',
    timeoutMs,
    secretsInjected: Object.keys(resolvedSecrets).length,
    stateValuesInjected: Object.keys(resolvedState).length,
  };
}
