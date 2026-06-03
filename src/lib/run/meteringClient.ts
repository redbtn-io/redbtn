/**
 * Process-singleton redToken metering bundle.
 *
 * One `UsageEventPublisher` (XADD to `usage:events`) + the per-surface clients,
 * shared across every run in this worker process (publishing is stateless
 * fire-and-forget). Lazily built on first run via `getOrCreateMeteringClient`.
 *
 * Two access patterns:
 *  - Within a run, executors resolve the bundle off the run context via
 *    `getMeteringClient(state)` (see contextLookup.ts) — that path also carries
 *    the bundle for unit tests / direct callers.
 *  - Outside a run (environment sessions closing on idle/shutdown, etc.), use
 *    `getProcessMeteringClient()` — it returns the already-built bundle without
 *    needing run state or a redis handle. Returns null until the first run has
 *    initialised it; callers must treat it as optional + fail-safe.
 *
 * Metering is strictly optional: any failure here is swallowed and disables
 * metering for the process — it must never affect a run.
 */
let _meteringClient: any = null;
let _meteringInitTried = false;

export function getOrCreateMeteringClient(redis: any): any {
  if (_meteringInitTried) return _meteringClient;
  // Don't latch on a missing redis — a later run with a real handle should still
  // get to initialise (otherwise a single early run without redis permanently
  // disables metering for the process).
  if (!redis) return null;
  _meteringInitTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      UsageEventPublisher,
      NeuronMeteringClient,
      ToolMeteringClient,
      ResourceMeteringClient,
    } = require('@redbtn/redtoken');
    const publisher = new UsageEventPublisher(redis);
    publisher.on?.('error', (err: unknown) => console.warn('[metering] publish error (non-fatal):', err));
    // A bundle of per-surface clients sharing one publisher. Executors reach the
    // surface they emit for: neuron (LLM), tool (native/MCP incl. scrape/search/
    // tts/stt/storage ops), resource (compute per-node, stream/env sessions, …).
    _meteringClient = {
      publisher,
      neuron: new NeuronMeteringClient(publisher),
      tool: new ToolMeteringClient(publisher),
      resource: new ResourceMeteringClient(publisher),
    };
    console.log('[metering] redToken usage metering initialised (neuron + tool + compute + sessions)');
  } catch (err) {
    console.warn('[metering] init failed — usage metering disabled (non-fatal):', err);
    _meteringClient = null;
  }
  return _meteringClient;
}

/**
 * The already-built process metering bundle, or null if no run has initialised
 * it yet (or init failed). Does NOT build it — that's `getOrCreateMeteringClient`'s
 * job, called once per process at run start.
 */
export function getProcessMeteringClient(): any {
  return _meteringClient;
}
