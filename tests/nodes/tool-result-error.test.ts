import { describe, expect, it } from 'vitest';
import { getToolResultErrorMessage } from '../../src/lib/nodes/universal/executors/toolResultError';

describe('MCP-compatible tool error formatting', () => {
  it('serializes structured payloads rather than calling string methods on objects', () => {
    const message = getToolResultErrorMessage(
      {
        content: [{ type: 'text', text: JSON.stringify({ error: { message: 'denied', code: 'DENIED' } }) }],
        isError: true,
      },
      'state_tool',
      'MCP',
    );

    expect(message).toBe('MCP tool "state_tool" returned error: {"message":"denied","code":"DENIED"}');
  });

  it('falls back safely when an error envelope cannot be JSON-serialized', () => {
    const envelope: Record<string, unknown> = { isError: true };
    envelope.self = envelope;

    expect(() => getToolResultErrorMessage(envelope, 'state_tool', 'Native')).not.toThrow();
    expect(getToolResultErrorMessage(envelope, 'state_tool', 'Native')).toContain('[object Object]');
  });

  it('formats the same structured payload for parser call sites', () => {
    const message = getToolResultErrorMessage(
      {
        content: [{ type: 'text', text: JSON.stringify({ message: { reason: 'denied' } }) }],
        isError: true,
      },
      'parser_error_tool',
      'Parser',
    );

    expect(message).toBe('Parser tool "parser_error_tool" returned error: {"reason":"denied"}');
  });
});
