/**
 * invoke_function — native tool for calling RedRun cloud functions
 *
 * Submits a job in async mode (?sync=false), then polls the execution
 * endpoint until it completes. Also streams function logs in real-time
 * by polling the execution logs endpoint and forwarding output chunks
 * via RunPublisher.toolProgress().
 */
import type { NativeToolDefinition } from '../native-registry.js';
declare const definition: NativeToolDefinition;
export default definition;
