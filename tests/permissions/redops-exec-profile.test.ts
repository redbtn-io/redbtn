/**
 * The Red Ops exec profile — end-to-end regression coverage for the P0 time bomb.
 *
 * The three Red Ops graphs (Coordinator `tHXXSTFtOuM9`, Worker `eCrxF8-glwgW`,
 * Reviewer `red-reviewer`) run every fleet job over SSH, declare NO capability
 * profile, and survive only because `PERMISSIONS_SHADOW=true` downgrades the
 * fail-closed exec denial to a logged shadow-block. These tests pin every link
 * in the chain that has to hold for the committed profile to actually fix that:
 *
 *   graph doc in Mongo → GraphRegistry.getConfig → compiledGraph.config
 *     → resolveCapabilityProfile → enforceToolCapability(ssh_shell)
 *
 * Each `describe` below owns one link. They are deliberately written against
 * the SHIPPING artifact (`ops/red-ops/red-ops-capability-profile.json` and the
 * typed const it is generated from) rather than a local fixture, so a drifted
 * profile fails the suite instead of passing a copy of itself.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceToolCapability } from '../../src/lib/permissions/enforce';
import { resolveCapabilityProfile } from '../../src/lib/permissions/resolve';
import {
  RED_OPS_CAPABILITY_PROFILE,
  RED_OPS_GRAPH_IDS,
  type GraphCapabilityProfile,
} from '../../src/lib/permissions/redops-profile';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';

/**
 * The three `ssh_shell` calls `red-ops-pipeline-executor` actually makes (step
 * indices 5, 9, 12). Reproduced from the deployed node config: inline
 * host/port/user/sshKey, and critically NO `environmentId`.
 */
const RED_OPS_SSH_ARGS = {
  host: 'server.georgeanthony.net',
  port: 2222,
  user: 'alpha',
  command: 'curl -sS -X POST https://atlas.redbtn.io/api/pipeline/jobs/claim',
  workingDir: '/home/alpha/code',
  timeout: 120000,
  sshKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
} as const;

const committedProfileJson = JSON.parse(
  readFileSync(join(__dirname, '../../ops/red-ops/red-ops-capability-profile.json'), 'utf8'),
) as GraphCapabilityProfile;

describe('the committed profile artifact', () => {
  it('matches the typed source exactly (JSON cannot drift from src/)', () => {
    expect(committedProfileJson).toEqual(RED_OPS_CAPABILITY_PROFILE);
  });

  it('grants exec:execute with the wildcard selector', () => {
    const exec = committedProfileJson.capabilities.filter((c) => c.resource === 'exec');
    expect(exec).toHaveLength(1);
    expect(exec[0].actions).toEqual(['execute']);
    expect(exec[0].selector).toBe('*');
  });

  it('carries a name and a description citing the tool-map evidence', () => {
    expect(committedProfileJson.name).toBe('red-ops-fleet-exec');
    expect(committedProfileJson.description).toContain('tool-map.ts:107-111');
    expect(committedProfileJson.description).toContain('environmentId');
  });

  // computer:control is fail-closed and unused by these graphs, so omitting it
  // takes nothing away. If someone adds it, that is a real widening of the
  // fleet's authority and should be a deliberate, reviewed change.
  it('does NOT grant computer:control', () => {
    expect(committedProfileJson.capabilities.some((c) => c.resource === 'computer')).toBe(false);
  });
});

// An exec grant must be expressible as a GraphConfig capability profile. Before
// the type widening in `types/graph.ts`, `resource: 'exec'` did not typecheck
// against `GraphConfig['capabilities']` at all — the union admitted only
// state|knowledge — so the profile could not be authored in typed code. This
// annotation is the compile-time half of that proof (the load-bearing half runs
// in `tsc` over src/, via redops-profile.ts).
describe('GraphConfig accepts an exec capability entry', () => {
  it('typechecks an exec:execute grant as a graph-declared profile', () => {
    const profile: GraphCapabilityProfile = {
      name: 'exec-typecheck',
      capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }],
    };
    expect(profile.capabilities[0].resource).toBe('exec');
  });
});

describe('resolveCapabilityProfile — normalizes an exec grant', () => {
  // A malformed profile silently degrades to null = UNPROFILED. For a
  // fail-closed resource that means every exec call is denied, so "the profile
  // parsed" is itself load-bearing and must be pinned, not assumed.
  it('returns a NON-NULL normalized profile for the committed Red Ops profile', () => {
    const resolved = resolveCapabilityProfile({
      graphId: RED_OPS_GRAPH_IDS.worker,
      capabilities: committedProfileJson,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('red-ops-fleet-exec');
    const exec = resolved!.capabilities.find((c) => c.resource === 'exec');
    expect(exec).toBeDefined();
    expect(exec!.actions).toContain('execute');
    expect(exec!.selector).toBe('*');
  });

  it('returns null when the graph declares no profile (today: UNPROFILED)', () => {
    expect(resolveCapabilityProfile({ graphId: RED_OPS_GRAPH_IDS.worker })).toBeNull();
  });

  // The degradation path that makes a typo dangerous for exec: it does NOT
  // throw, it returns null, and null means fail-closed exec is denied.
  it('degrades a malformed profile to null rather than throwing', () => {
    expect(resolveCapabilityProfile({ capabilities: 'exec:execute' })).toBeNull();
    expect(resolveCapabilityProfile({ capabilities: { name: 'x' } })).toBeNull();
  });
});

describe('enforceToolCapability — the unscoped ssh_shell path Red Ops takes', () => {
  const resolved = resolveCapabilityProfile({ capabilities: committedProfileJson })!;

  it('ALLOWS ssh_shell with no environmentId under the committed profile', () => {
    expect(() => enforceToolCapability(resolved, 'ssh_shell', { ...RED_OPS_SSH_ARGS })).not.toThrow();
  });

  // The whole point of the wildcard. `tool-map.ts:107-111` keys the exec
  // address on `environmentId`; with none supplied the call is unscoped, and
  // `enforce.ts` step 3 requires a true '*' grant. A per-host selector is the
  // intuitive-but-wrong authoring choice and would deny 100% of Red Ops SSH.
  it('DENIES the same call under a non-wildcard selector such as "alphaSystem"', () => {
    const perHost: CapabilityProfile = {
      name: 'red-ops-per-host',
      capabilities: [{ resource: 'exec', actions: ['execute'], selector: 'alphaSystem' }],
    };
    expect(() => enforceToolCapability(perHost, 'ssh_shell', { ...RED_OPS_SSH_ARGS })).toThrow(
      CapabilityDeniedError,
    );
  });

  it('DENIES ssh_shell when the graph is UNPROFILED (the live time bomb)', () => {
    expect(() => enforceToolCapability(null, 'ssh_shell', { ...RED_OPS_SSH_ARGS })).toThrow(
      CapabilityDeniedError,
    );
  });

  it('allows all three executor ssh_shell steps (claim, CLI session, completion)', () => {
    const commands = [
      'curl -sS -X POST https://atlas.redbtn.io/api/pipeline/jobs/claim',
      'export PATH=... && claude -p "$(echo ... | base64 -d)" --dangerously-skip-permissions',
      'echo "$C" | base64 -d | curl -sS --fail-with-body -X POST .../complete',
    ];
    for (const command of commands) {
      expect(() =>
        enforceToolCapability(resolved, 'ssh_shell', { ...RED_OPS_SSH_ARGS, command }),
      ).not.toThrow();
    }
  });
});

// The blast radius an author of this profile must understand: state/knowledge
// are fail-OPEN, so they are unrestricted ONLY while the graph is unprofiled.
// Attaching an exec-only profile REVOKES data access that works today. This is
// why the committed profile also carries wildcard state/knowledge grants.
describe('blast radius — an exec-only profile enforces state/knowledge', () => {
  const execOnly: CapabilityProfile = {
    name: 'exec-only',
    capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }],
  };

  it('unprofiled: state and knowledge are unrestricted', () => {
    expect(() => enforceToolCapability(null, 'set_global_state', { namespace: 'red-ops/state' })).not.toThrow();
    expect(() => enforceToolCapability(null, 'search_all_libraries', {})).not.toThrow();
  });

  it('exec-only profile: the SAME state/knowledge calls are now DENIED', () => {
    expect(() => enforceToolCapability(execOnly, 'set_global_state', { namespace: 'red-ops/state' })).toThrow(
      CapabilityDeniedError,
    );
    expect(() => enforceToolCapability(execOnly, 'get_global_state', { namespace: 'red-ops/triage' })).toThrow(
      CapabilityDeniedError,
    );
    expect(() => enforceToolCapability(execOnly, 'search_all_libraries', {})).toThrow(
      CapabilityDeniedError,
    );
  });

  it('the COMMITTED profile keeps those calls working (pure addition of exec)', () => {
    const resolved = resolveCapabilityProfile({ capabilities: committedProfileJson })!;
    expect(() => enforceToolCapability(resolved, 'set_global_state', { namespace: 'red-ops/state' })).not.toThrow();
    expect(() => enforceToolCapability(resolved, 'get_global_state', { namespace: 'red-ops/triage' })).not.toThrow();
    expect(() => enforceToolCapability(resolved, 'search_all_libraries', {})).not.toThrow();
  });
});

// ── GraphRegistry.getConfig ──────────────────────────────────────────────────
// All three Red Ops graphs are PUBLISHED (`published.nodes` / `published.edges`
// present, `draft: null`). getConfig overrides ONLY nodes+edges from the
// published sub-document and spreads everything else from the top level. If it
// instead returned the published sub-document, or dropped unknown top-level
// fields, an attached `capabilities` field would never reach the run and the
// profile would be a no-op. That is the load-bearing behavior pinned here.
const graphFindOne = vi.fn();
vi.mock('../../src/lib/models/Graph', () => ({
  Graph: {
    findOne: (...args: unknown[]) => graphFindOne(...args),
  },
}));
vi.mock('../../src/lib/memory/database', () => ({
  getDatabase: () => ({ connect: vi.fn(), close: vi.fn() }),
}));
// getConfig never compiles — it only reads + shapes the document. The compiler
// is stubbed because importing it pulls in `./nodeRegistry`, a hand-maintained
// JS module with no source counterpart in src/ (see compiler.ts:14-18).
vi.mock('../../src/lib/graphs/compiler', () => ({
  compileGraphFromConfig: vi.fn(),
  GraphCompilationError: class GraphCompilationError extends Error {},
}));

describe('GraphRegistry.getConfig — preserves a top-level capabilities field', () => {
  beforeEach(() => {
    graphFindOne.mockReset();
  });

  /** A published Red Ops graph doc, shaped exactly like the live documents. */
  function redOpsGraphDoc(graphId: string, capabilities?: unknown) {
    const doc = {
      graphId,
      userId: '69a0b790a0ae8660290a78da',
      name: 'Red Worker',
      tier: 0,
      nodes: [{ id: 'draft-only', neuronId: null, config: {} }],
      edges: [{ from: '__start__', to: 'draft-only' }],
      published: {
        nodes: [{ id: 'executor', neuronId: null, config: { nodeId: 'red-ops-pipeline-executor' } }],
        edges: [{ from: '__start__', to: 'executor' }],
        version: 3,
      },
      ...(capabilities === undefined ? {} : { capabilities }),
    };
    return { toObject: () => doc };
  }

  async function getConfig(graphId: string, capabilities?: unknown) {
    const { GraphRegistry } = await import('../../src/lib/graphs/GraphRegistry');
    graphFindOne.mockResolvedValue(redOpsGraphDoc(graphId, capabilities));
    const registry = new GraphRegistry({ databaseUrl: 'mongodb://placeholder/test' });
    return registry.getConfig(graphId, '69a0b790a0ae8660290a78da');
  }

  it('keeps `capabilities` alongside the published nodes/edges override', async () => {
    const config = await getConfig(RED_OPS_GRAPH_IDS.worker, committedProfileJson);

    // published wins for the execution source...
    expect(config.nodes.map((n) => n.id)).toEqual(['executor']);
    // ...and the top-level profile survives the spread.
    expect(config.capabilities).toEqual(committedProfileJson);
  });

  it('the surviving field resolves to an enforceable profile that allows ssh_shell', async () => {
    const config = await getConfig(RED_OPS_GRAPH_IDS.coordinator, committedProfileJson);
    const profile = resolveCapabilityProfile(config);

    expect(profile).not.toBeNull();
    expect(() => enforceToolCapability(profile, 'ssh_shell', { ...RED_OPS_SSH_ARGS })).not.toThrow();
  });

  it('without the field the published graph stays UNPROFILED → exec denied', async () => {
    const config = await getConfig(RED_OPS_GRAPH_IDS.reviewer);

    expect(config.capabilities).toBeUndefined();
    expect(resolveCapabilityProfile(config)).toBeNull();
    expect(() =>
      enforceToolCapability(resolveCapabilityProfile(config), 'ssh_shell', { ...RED_OPS_SSH_ARGS }),
    ).toThrow(CapabilityDeniedError);
  });
});

// The engine's own Mongoose schema (`models/Graph.ts`) declares neither
// `published` nor `capabilities`, and is `strict: true`. Strict mode governs
// WRITES, not hydration — non-schema fields present in the stored document
// still survive `toObject()`. If that were not true, the whole approach would
// be dead on arrival: the engine would never see an attached profile. Pinned
// here because it is an implicit dependency on Mongoose behavior, and because
// it is exactly why the profile must be written by the webapp (whose Graph
// model is `strict: false`) rather than by the engine.
describe('mongoose strict:true does not strip the capabilities field on read', () => {
  it('hydrates a doc carrying non-schema capabilities + published fields', async () => {
    const { Graph } = await vi.importActual<typeof import('../../src/lib/models/Graph')>(
      '../../src/lib/models/Graph',
    );
    const hydrated = (Graph as any).hydrate({
      _id: '000000000000000000000001',
      graphId: RED_OPS_GRAPH_IDS.worker,
      userId: '69a0b790a0ae8660290a78da',
      name: 'Red Worker',
      tier: 0,
      nodes: [{ id: 'executor', config: {} }],
      edges: [{ from: '__start__', to: 'executor' }],
      capabilities: committedProfileJson,
      published: { nodes: [{ id: 'executor', config: {} }], edges: [{ from: '__start__', to: 'executor' }] },
    });

    expect((Graph as any).schema.options.strict).toBe(true);
    expect(hydrated.toObject().capabilities).toEqual(committedProfileJson);
    expect(hydrated.toObject().published).toBeDefined();
  });
});
