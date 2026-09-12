/**
 * Desktop Held-Trigger-Key Boundary Test (Card 6aa1d9c408971669b4a25d1f).
 *
 * Enforces the desktop boundary security contract:
 * When a local command executes on a held trigger key, the desktop captures
 * the remainder as an ARGUMENT and strips it locally. Only the label
 * ('commandExecuted(label)', max 120 chars) may ride the wire frame.
 *
 * This test asserts that the session extraction writer produces ZERO memories
 * containing any part of the command's local argument.
 */

export interface HeldTriggerCommandSession {
  sessionId: string;
  triggerKey: string;
  configuredPhrase: string;
  localArgument: string;
  wireFrame: {
    type: 'command_executed';
    data: {
      label: string;
    };
  };
  sessionEvents: Array<{
    type: string;
    text?: string;
    label?: string;
  }>;
}

export interface BoundaryTestResult {
  sessionId: string;
  argumentTokens: string[];
  wireFrameSanitized: boolean;
  leakedTokens: string[];
  passed: boolean;
  extractedMemories: string[];
  details: string;
}

/**
 * Creates a simulated held-trigger-key session following the desktop protocol.
 */
export function createHeldTriggerSession(
  phrase = 'open visual studio',
  secretArgument = 'C:\\private\\client_merger_audit_2026.docx --token=red_sec_773322',
): HeldTriggerCommandSession {
  // Desktop wire protocol: trims label to 120 chars, argument never rides the frame
  const wireLabel = phrase.slice(0, 120);

  return {
    sessionId: `session-ht-${Date.now()}`,
    triggerKey: 'Trigger_Held',
    configuredPhrase: phrase,
    localArgument: secretArgument,
    wireFrame: {
      type: 'command_executed',
      data: {
        label: wireLabel,
      },
    },
    sessionEvents: [
      { type: 'turn_start' },
      { type: 'command_executed', label: wireLabel },
      { type: 'turn_complete' },
    ],
  };
}

/**
 * Simulates memory extraction on a session that included a held-trigger local command.
 * Strictly checks that the argument never crosses into the platform memory store.
 */
export function verifyNoCommandArgumentLeak(
  session: HeldTriggerCommandSession,
  extractedMemoryBodies: string[],
): BoundaryTestResult {
  // Extract sensitive argument tokens
  const argumentTokens = session.localArgument
    .split(/[\s\\/\.:=_-]+/)
    .filter((t) => t.length >= 3 && !session.configuredPhrase.toLowerCase().includes(t.toLowerCase()));

  // Verify wire frame sanitization
  const wireJson = JSON.stringify(session.wireFrame);
  const wireFrameSanitized = !argumentTokens.some((tok) => wireJson.toLowerCase().includes(tok.toLowerCase()));

  // Scan all extracted memories for argument tokens
  const leakedTokens: string[] = [];
  const combinedMemoryText = extractedMemoryBodies.join('\n').toLowerCase();

  for (const token of argumentTokens) {
    if (combinedMemoryText.includes(token.toLowerCase())) {
      leakedTokens.push(token);
    }
  }

  const passed = wireFrameSanitized && leakedTokens.length === 0;

  return {
    sessionId: session.sessionId,
    argumentTokens,
    wireFrameSanitized,
    leakedTokens,
    passed,
    extractedMemories: extractedMemoryBodies,
    details: passed
      ? `PASSED: Wire frame sanitized (${session.wireFrame.data.label}). 0 argument tokens found in ${extractedMemoryBodies.length} extracted memory cards.`
      : `FAILED: Found ${leakedTokens.length} leaked argument token(s) [${leakedTokens.join(', ')}] across extracted memories.`,
  };
}
