/**
 * Public surface of the chat-components module.
 *
 * The chat-interactive-widgets epic ships a frozen ChatComponentSpec contract.
 * This barrel re-exports the schema constants, TS types, and the
 * `validateChatComponentSpec` helper so both engine and webapp can import from
 * a single path.
 */

export {
  CHAT_COMPONENT_TYPES,
  CHAT_COMPONENT_INTERACTION_CHANNELS,
  CHAT_COMPONENT_SPEC_SCHEMA,
  chatComponentSpecZod,
  validateChatComponentSpec,
} from './component-spec-schema';

export type {
  ChatComponentType,
  ChatComponentInteractionChannel,
  ChatComponentBinding,
  ChatComponentInteraction,
  ChatComponentProvenance,
  ChatComponentResponded,
  ChatComponentSpec,
  ValidateResult,
} from './component-spec-schema';
