/** Sanitizers for tool event data persisted in run and conversation telemetry. */

import { GEORGE_EMAIL_RECIPIENT } from './agent-email-policy';

/** Email subjects and bodies are content, not observability metadata. */
export function sanitizeToolInputForTelemetry(toolName: string, input: unknown): unknown {
  if (toolName === 'send_email') {
    return { recipient: GEORGE_EMAIL_RECIPIENT, content: 'redacted' };
  }
  return input;
}
