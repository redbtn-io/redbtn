/**
 * Environments — public re-exports.
 *
 * Phase A (this PR) ships:
 *   - Types (`IEnvironment`, lifecycle states, errors, defaults).
 *   - `EnvironmentSession` — per-session SSH/SFTP wrapper.
 *   - `EnvironmentManager` — per-process pool of sessions.
 *   - The `environmentManager` singleton.
 *
 * Phase B will add the Mongo schema, REST API routes, secret-store
 * integration, and the `ssh_shell` / `ssh_copy` `environmentId` arg.
 *
 * @module lib/environments
 */

export {
  EnvironmentManager,
  environmentManager,
  type EnvironmentManagerOptions,
} from './EnvironmentManager';

export {
  EnvironmentSession,
  type EnvironmentSessionOptions,
  type SshClientFactory,
  type OnExecCompleteHandler,
} from './EnvironmentSession';

export {
  loadAndResolveEnvironment,
  EnvironmentNotFoundError,
  EnvironmentAccessDeniedError,
  EnvironmentSecretMissingError,
  type LoadEnvironmentDeps,
} from './loadAndResolveEnvironment';

export {
  // Lifecycle
  type EnvironmentLifecycleState,
  type EnvironmentLifecycleEvent,
  type EnvironmentExecCompletedEvent,

  // Config doc
  type IEnvironment,
  type EnvironmentReconnectPolicy,

  // Exec / SFTP
  type ExecOptions,
  type ExecResult,
  type SftpStatResult,
  type SftpDirEntry,
  type SftpReadOptions,
  type SftpWriteOptions,
  EXEC_MAX_OUTPUT_BYTES,

  // Pending buffer
  type PendingCommand,
  BUFFER_MAX_COMMANDS,
  BUFFER_MAX_BYTES,

  // Status snapshot
  type EnvironmentStatus,

  // Archive log shape
  type IEnvironmentLog,

  // Errors
  EnvironmentClosedError,
  EnvironmentTimeoutError,
  EnvironmentBufferOverflowError,

  // Defaults
  ENV_DEFAULTS,
} from './types';
