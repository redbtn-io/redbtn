/**
 * Run System
 *
 * Unified run execution system providing:
 * - RunPublisher: State management and event publishing
 * - RunLock: Distributed locking for concurrent execution control
 *
 * @module lib/run
 */

export {
  type RunState,
  type RunStatus,
  type RunOutput,
  type CurrentStatus,
  type GraphTrace,
  type NodeProgress,
  type NodeStatus,
  type ToolExecution,
  type ToolStatus,
  type ProgressStep,
  type TokenMetadata,
  type RunEvent,
  type RunEventType,
  type RunStartEvent,
  type RunCompleteEvent,
  type RunErrorEvent,
  type RunInterruptedEvent,
  type StatusEvent,
  type GraphStartEvent,
  type GraphCompleteEvent,
  type GraphErrorEvent,
  type NodeStartEvent,
  type NodeProgressEvent,
  type NodeCompleteEvent,
  type NodeErrorEvent,
  type ChunkEvent,
  type ThinkingCompleteEvent,
  type ToolStartEvent,
  type ToolProgressEvent,
  type ToolOutputEvent,
  type ToolCompleteEvent,
  type ToolErrorEvent,
  type AudioChunkEvent,
  type InitEvent,
  type AttachmentEvent,
  type AttachmentKind,
  RunKeys,
  RunConfig,
  createInitialRunState,
  createNodeProgress,
  createToolExecution,
} from './types';

export {
  RunPublisher,
  type RunPublisherOptions,
  type RunSubscription,
  createRunPublisher,
  getRunState,
  getActiveRunForConversation,
  publishRunError,
  publishRunInterrupt,
  ARCHIVE_QUEUE_NAMES,
} from './run-publisher';

export {
  RunLock,
  type LockResult,
  type AcquireLockOptions,
  type RunLockHandle,
  createRunLock,
  acquireRunLock,
  isConversationLocked,
  isGraphLocked,
} from './run-lock';

export {
  type TriggerType,
  type TriggerSource,
  type TriggerMetadata,
  type Trigger,
  type TriggeredRun,
  type EnrichedInput,
  type EnrichmentResult,
  type AutomationTriggeredBy,
  type AttachmentRef,
  LEGACY_TRIGGER_MAP,
  toTriggerType,
} from './trigger-types';

export {
  enrichInput,
  type EnrichInputOptions,
} from './enrich-input';

export {
  RunControlRegistry,
  NeuronCall,
  runControlRegistry,
  type RunControlContext,
  type CancelAck,
  type CancelNoAck,
  type CancelResult,
} from './RunControlRegistry';

export {
  readRunProgress,
  isRunProgressStale,
  touchRunProgress,
  type AutomationRunsCollection,
  type GenerationsCollection,
  type ReadRunProgressOptions,
  type RunProgressSnapshot,
  type TouchRunProgressOptions,
  type TouchRunProgressResult,
} from './progress-heartbeat';

export {
  classifyRunProgressStaleness,
  normalizeLastProgressAt,
  type AutomationRunProgressRecord,
  type GenerationProgressRecord,
  type RedisRunProgressRecord,
  type RunProgressHeartbeat,
  type RunProgressReadableRecord,
  type RunProgressStalenessOptions,
  type RunProgressStalenessResult,
} from './progress-contract';

export {
  AutomationConcurrencyLimiter,
  AUTOMATION_CONCURRENCY_MODES,
  DEFAULT_TRIGGER_ID,
  ACQUIRE_LUA,
  normalizeAutomationConcurrency,
  resolveEffectiveConcurrency,
  effectiveCap,
  tryAcquireAutomationSlot,
  heartbeatAutomationSlot,
  releaseAutomationSlot,
  type AutomationConcurrencyMode,
  type AutomationConcurrencyConfig,
  type AutomationTriggerConcurrency,
  type RawAutomationConcurrency,
  type ResolvedConcurrency,
  type AutomationConcurrencySlot,
  type AdmissionDecision,
  type TryAcquireOptions,
} from './automation-concurrency';
