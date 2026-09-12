import type { GraphConfig } from '../types/graph';
import type { Capability } from './types';
import type { GraphCapabilityProfile } from './redops-profile';

export const RED_MEMORY_WRITER_GRAPH_IDS = {
  writer: 'red-memory-writer',
  subgraph: 'red-memory-writer-subgraph',
  teardownHook: 'red-stream-teardown-hook',
} as const;

/**
 * The canonical capability profile for the red-memory-writer subgraph.
 *
 * Scoped strictly to the subgraph invocation (never attached to the stream or
 * top-level graph). Grants read, write, and create on State selector 'Red_Memory*' and
 * Knowledge selector 'red-memory*'.
 *
 * Omits all delete actions, exec, computer, and invoke_tool.
 */
export const RED_MEMORY_WRITER_CAPABILITY_PROFILE: GraphCapabilityProfile & {
  capabilities: Capability[];
} = {
  name: 'red-memory-writer-jailed',
  description:
    'Jailed memory extraction profile for red-memory-writer-subgraph. ' +
    'Strictly limits state and knowledge access to Red_Memory* and red-memory*. ' +
    'Omits all delete actions, exec, computer, and invoke_tool.',
  capabilities: [
    { resource: 'state', actions: ['read', 'write', 'create'], selector: 'Red_Memory*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create'], selector: 'red-memory*' },
  ],
};
