import { describe, expect, it } from 'vitest';

import {
  universalNode,
  validateUniversalNodeConfig,
} from '../../src/lib/nodes/universal/universalNode';

describe('universalNode config validation', () => {
  it('rejects nodeConfig.steps when it is not an array at runtime', async () => {
    await expect(
      universalNode({
        nodeConfig: {
          steps: { type: 'neuron', config: {} },
        } as any,
        nodeCounter: 1,
      }),
    ).rejects.toThrow('[UniversalNode] Invalid config: "steps" must be an array');
  });

  it('rejects nodeConfig.steps when it is not an array via validator', () => {
    expect(() =>
      validateUniversalNodeConfig({
        steps: { type: 'neuron', config: {} } as any,
      } as any),
    ).toThrow('Invalid universal node config: "steps" must be an array');
  });
});
