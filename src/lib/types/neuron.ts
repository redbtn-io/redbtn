/**
 * Neuron Type Definitions
 *
 * Defines the types and interfaces for the Neuron system.
 * Neurons are configurable LLM endpoints that can be dynamically loaded per-user.
 */

/**
 * Supported LLM providers
 */
export type NeuronProvider = 'ollama' | 'openai' | 'anthropic' | 'google' | 'custom';

/**
 * Neuron role categorization (for UI organization)
 */
export type NeuronRole = 'chat' | 'worker' | 'specialist';

/**
 * Runtime neuron configuration
 * Used internally by NeuronRegistry when creating model instances
 */
export interface NeuronConfig {
  id: string;
  name: string;
  description?: string;
  provider: NeuronProvider;
  endpoint: string;
  model: string;
  /** Resolved API key. Populated by NeuronRegistry from `secretName` (vault
   *  lookup) or, for legacy unmigrated neurons, from the document's
   *  encrypted `apiKey` field. Undefined → LangChain falls through to
   *  platform-level env vars (OPENAI_API_KEY etc.). */
  apiKey?: string;
  /** Name of an entry in the user's secrets vault (`@redbtn/redsecrets`).
   *  When set, NeuronRegistry resolves this at load time and populates
   *  `apiKey` from the resolved value. Preferred over inlined apiKey
   *  for new neurons. */
  secretName?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  role: NeuronRole;
  tier: number;
  userId?: string;
  /** When true, the worker generates TTS audio server-side during streaming */
  audioOptimized?: boolean;
}

/**
 * MongoDB document interface for neurons collection
 */
export interface NeuronDocument {
  _id?: any;
  neuronId: string;
  userId: string;
  creatorId?: string;
  status?: 'active' | 'abandoned' | 'deleted';
  abandonedAt?: Date | null;
  scheduledDeletionAt?: Date | null;
  isDefault: boolean;
  isSystem?: boolean;
  isImmutable?: boolean;
  parentNeuronId?: string;
  name: string;
  description?: string;
  provider: NeuronProvider;
  endpoint: string;
  model: string;
  /** @deprecated — new neurons should use `secretName` instead. Kept for
   *  backward read compatibility on neurons created before the secrets
   *  migration; NeuronRegistry decrypts and uses this if `secretName` is
   *  unset. The webapp API no longer accepts inlined `apiKey` writes. */
  apiKey?: string;
  /** Name of an entry in the user's secrets vault. Preferred over
   *  `apiKey`. NeuronRegistry resolves at load time via
   *  `@redbtn/redsecrets`. */
  secretName?: string;
  temperature: number;
  maxTokens?: number;
  topP?: number;
  role: NeuronRole;
  tier: number;
  createdAt: Date;
  updatedAt: Date;
  usageCount?: number;
  lastUsedAt?: Date;
  /** When true, the worker generates TTS audio server-side during streaming */
  audioOptimized?: boolean;
}
