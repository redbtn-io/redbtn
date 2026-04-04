/**
 * SSH Shell — Native System Tool
 *
 * Opens an SSH connection, runs a command, streams stdout/stderr back through
 * the RunPublisher in real-time. Returns the full output and exit code when
 * the command completes.
 *
 * Key characteristics vs. MCP stdio path:
 * - No JSON-RPC serialization overhead
 * - No hard 90-second timeout (configurable per call, default unlimited)
 * - RunPublisher access for live UI streaming
 * - Large output support (truncated at 100KB in return value, full output
 *   is available as the streaming feed)
 */
import type { NativeToolDefinition } from '../native-registry';
declare const sshShell: NativeToolDefinition;
export default sshShell;
