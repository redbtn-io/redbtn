/**
 * Capability model for the data-permissions layer.
 *
 * # What this is
 *
 * A small, fail-closed capability model that lets an agent (graph config) be
 * *jailed* to a subset of a user's DATA — currently State (global-state
 * namespaces) and Knowledge (libraries). Enforcement happens at the native-tool
 * execution layer (see `enforce.ts` + the hook in `native-registry.ts`), never
 * via prompt text.
 *
 * # The shape
 *
 * A capability is `{ resource, action, selector }`:
 *   - `resource` — which data domain the grant covers (`state` | `knowledge`).
 *       The union is intentionally open-ended in spirit: automations / graphs /
 *       nodes can be added as resources later WITHOUT touching the enforcement
 *       core. They are deliberately NOT implemented now.
 *   - `action`   — `read` | `write` | `create` | `delete`. Every data tool is
 *       mapped to exactly one action in `tool-map.ts`.
 *   - `selector` — a glob/prefix string matched against the resource address
 *       (the State namespace, or the Knowledge library name/id). Supported
 *       forms: exact (`coder`), prefix-glob (`coder/*` or `coder*`), wildcard
 *       (`*`), and the explicit deny token (`none`).
 *
 * A `CapabilityProfile` is a named bundle of grants attached to an agent.
 *
 * # The backward-compat contract (THE most important rule)
 *
 * A run with NO capability profile is UNRESTRICTED — today's behavior. Existing
 * worker automations, chat agents, and graphs that never declare a profile are
 * completely unaffected. Only a run whose graph config carries a
 * `CapabilityProfile` is enforced, and then strictly + fail-closed: a data tool
 * whose address has no matching grant is DENIED.
 *
 * @module lib/permissions/types
 */

/** Data domains a capability can cover. Extend (automations/graphs/nodes) later. */
export type CapabilityResource = 'state' | 'knowledge';

/** Verbs. Every data tool maps to exactly one of these. */
export type CapabilityAction = 'read' | 'write' | 'create' | 'delete';

/**
 * A single grant: "this resource + action is allowed for addresses matching
 * `selector`". A profiled run is the UNION of its grants — an address is
 * allowed for an action if ANY grant matches.
 */
export interface Capability {
  resource: CapabilityResource;
  /**
   * The actions this grant covers. An array so one selector can grant several
   * verbs at once (e.g. `['read','write','create','delete']` for full control
   * of a prefix). Must be non-empty.
   */
  actions: CapabilityAction[];
  /**
   * Glob/prefix matched against the resource address.
   *   - `'*'`          → matches everything in this resource
   *   - `'none'`       → matches nothing (explicit, readable deny placeholder)
   *   - `'coder/*'`    → prefix jail: matches `coder/anything` (and `coder` itself)
   *   - `'coder*'`     → bare-prefix glob: matches anything starting with `coder`
   *   - `'coder'`      → exact match only
   */
  selector: string;
}

/**
 * A named bundle of capabilities attached to an agent/graph config. The
 * presence of a profile flips a run from unrestricted → enforced.
 */
export interface CapabilityProfile {
  /** Human-readable id for diagnostics + audit (e.g. `red-coder-jail`). */
  name: string;
  /**
   * The grants. An EMPTY array means "profiled but nothing granted" → every
   * data tool is denied (fail-closed). This is a valid, intentional lockdown
   * state, NOT the same as "no profile".
   */
  capabilities: Capability[];
  /**
   * Optional human note explaining why this jail exists. Surfaced in the
   * denial error so an operator reading logs understands the intent.
   */
  description?: string;
}

/**
 * The result of a capability check. `allowed: false` carries a model-readable
 * `reason` string so the LLM can adapt (e.g. "I can't write outside coder/*").
 */
export interface CapabilityDecision {
  allowed: boolean;
  /** Populated when `allowed` is false. Safe to surface to the model. */
  reason?: string;
  /** The resource the check was against (diagnostic). */
  resource?: CapabilityResource;
  /** The action the check was against (diagnostic). */
  action?: CapabilityAction;
  /** The address the check was against (diagnostic). */
  address?: string;
}

/**
 * Error thrown by the enforcement layer when a profiled run attempts a denied
 * data operation. Carries structured fields so callers can render a clean,
 * model-readable tool error rather than a stack trace.
 */
export class CapabilityDeniedError extends Error {
  readonly resource: CapabilityResource;
  readonly action: CapabilityAction;
  readonly address: string;
  readonly profileName: string;

  constructor(args: {
    resource: CapabilityResource;
    action: CapabilityAction;
    address: string;
    profileName: string;
    message: string;
  }) {
    super(args.message);
    this.name = 'CapabilityDeniedError';
    this.resource = args.resource;
    this.action = args.action;
    this.address = args.address;
    this.profileName = args.profileName;
  }
}
