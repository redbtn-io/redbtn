/**
 * Graph secret discovery must reach parser nodes.
 *
 * `collectGraphReferencedSecretNames` is what decides which secrets a run
 * resolves. Two blind spots made a parser's credentials unresolvable, so the
 * only way to make one work was to write the plaintext value into the node
 * document:
 *
 *   1. `parserConfig` sits OUTSIDE the step array, and the scan read `steps`.
 *   2. A parser node is loaded by id at run time (parserRegistry) and is not a
 *      member of `graph.nodes`, so it was never fetched at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const collections: Record<string, any> = {};

vi.mock('mongoose', () => ({
  default: {
    connection: {
      get db() {
        return {
          collection: (name: string) => collections[name],
        };
      },
    },
  },
}));

function seed(graph: any, nodes: any[]) {
  collections['graphs'] = {
    findOne: async () => graph,
  };
  collections['nodes'] = {
    find: (filter: any, options: any) => ({
      toArray: async () => {
        const wanted: string[] = filter.nodeId.$in;
        const projection = options?.projection ?? {};
        return nodes
          .filter((n) => wanted.includes(n.nodeId))
          .map((n) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(projection)) {
              if (n[key] !== undefined) out[key] = n[key];
            }
            return out;
          });
      },
    }),
  };
}

let collectGraphReferencedSecretNames: (graphId?: string) => Promise<string[]>;

beforeEach(async () => {
  vi.resetModules();
  ({ collectGraphReferencedSecretNames } = await import('../../src/lib/run/enrich-input'));
});

describe('collectGraphReferencedSecretNames', () => {
  it('finds {{secret:NAME}} in a parser node\'s parserConfig outputs', async () => {
    seed(
      { nodes: [{ config: { nodeId: 'chat-node' } }] },
      [
        {
          nodeId: 'chat-node',
          steps: [{ type: 'neuron', config: { streamParser: 'claude-stream-json' } }],
        },
        {
          nodeId: 'claude-stream-json',
          steps: [],
          parserConfig: {
            outputs: [
              {
                type: 'tts_http',
                ttsHeaders: { 'x-goog-api-key': '{{secret:GOOGLE_API_KEY}}' },
                deliveryHeaders: { 'x-api-key': '{{secret:REDRUN_SEND_VOICE_KEY}}' },
              },
            ],
          },
        },
      ],
    );

    const names = await collectGraphReferencedSecretNames('g-parser-outputs');
    expect(names.sort()).toEqual(['GOOGLE_API_KEY', 'REDRUN_SEND_VOICE_KEY']);
  });

  it('finds _secrets.NAME in a parser node\'s own tool steps', async () => {
    seed(
      { nodes: [{ config: { nodeId: 'chat-node' } }] },
      [
        { nodeId: 'chat-node', steps: [{ type: 'tool', config: { streamParser: 'claude-stream-json' } }] },
        {
          nodeId: 'claude-stream-json',
          steps: [
            {
              type: 'tool',
              config: { parameters: { headers: { 'x-api-key': '{{state._secrets.REDRUN_SEND_VOICE_KEY}}' } } },
            },
          ],
        },
      ],
    );

    const names = await collectGraphReferencedSecretNames('g-parser-steps');
    expect(names).toEqual(['REDRUN_SEND_VOICE_KEY']);
  });

  it('still finds references in the graph\'s own node steps', async () => {
    seed(
      { nodes: [{ config: { nodeId: 'ssh-node' } }] },
      [{ nodeId: 'ssh-node', steps: [{ config: { sshKey: '{{state.data.input._secrets.SSH_KEY}}' } }] }],
    );

    const names = await collectGraphReferencedSecretNames('g-plain-steps');
    expect(names).toEqual(['SSH_KEY']);
  });

  it('makes no second lookup when no step names a stream parser', async () => {
    seed({ nodes: [{ config: { nodeId: 'plain' } }] }, [{ nodeId: 'plain', steps: [{ config: {} }] }]);
    const findSpy = vi.spyOn(collections['nodes'], 'find');

    await collectGraphReferencedSecretNames('g-no-parser');
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for a graph that references no secrets (least-privilege)', async () => {
    seed(
      { nodes: [{ config: { nodeId: 'chat-node' } }] },
      [
        { nodeId: 'chat-node', steps: [{ config: { streamParser: 'plain-parser' } }] },
        { nodeId: 'plain-parser', steps: [], parserConfig: { outputs: [{ type: 'conversation' }] } },
      ],
    );

    expect(await collectGraphReferencedSecretNames('g-clean')).toEqual([]);
  });
});
