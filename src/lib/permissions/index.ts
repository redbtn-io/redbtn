/**
 * Data-permissions layer — public surface.
 *
 * A fail-closed capability layer that jails an agent (graph config) to a subset
 * of a user's State + Knowledge data, enforced at the native-tool execution
 * layer. See `types.ts` for the model and `enforce.ts` for the gate.
 *
 * @module lib/permissions
 */

export * from './types';
export { selectorMatches, decide, buildDenialReason } from './matcher';
export { isDataTool, getDataToolRule, DATA_TOOL_RULES } from './tool-map';
export { enforceToolCapability, normalizeProfile } from './enforce';
export { resolveCapabilityProfile, GRAPH_CAPABILITIES_FIELD } from './resolve';
