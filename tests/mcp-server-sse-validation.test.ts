import { McpServerSSE } from '../src/lib/mcp/server-sse';
import type { CallToolResult } from '../src/lib/mcp/types';

class ValidationTestServer extends McpServerSSE {
  constructor() {
    super('validation-test', '1.0.0', 0);
  }

  protected async setup(): Promise<void> {}

  protected async executeTool(
    _name: string,
    _args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return { content: [] };
  }

  getListeningPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server is not listening');
    }
    return address.port;
  }
}

describe('McpServerSSE request validation', () => {
  let server: ValidationTestServer;

  beforeEach(async () => {
    server = new ValidationTestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns a JSON-RPC invalid-request response for an empty POST body', async () => {
    const response = await fetch(`http://localhost:${server.getListeningPort()}/mcp/message`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Invalid Request',
      },
      id: null,
    });
  });
});
