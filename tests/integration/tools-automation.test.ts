/**
 * Integration test for the native automation pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a small
 * graph using the new tools end-to-end."
 *
 * The five tools in this pack form a coherent agent lifecycle:
 *
 *    list_automations    — discover what automations exist
 *    get_automation      — inspect a specific automation
 *    enable_automation   — re-activate one if it's paused
 *    trigger_automation  — kick off a run (optionally wait for it)
 *    disable_automation  — pause one when an error condition is detected
 *
 * All five tools are plain HTTP API proxies, so we mock at the fetch layer
 * with a single shared mock that routes by URL pattern. This validates:
 *   1. NativeToolRegistry singleton has all 5 tools registered.
 *   2. A simulated agent flow chains them together end-to-end:
 *      list → get → enable → trigger (wait) → disable.
 *   3. The shared `automation` server label is consistent.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Re-import each tool by path. In production, native-registry.ts loads each
// via require('./native/foo.js'); when running TS sources under vitest those
// .js paths don't exist next to the .ts module, so the catch block silently
// swallows the failure. We work around it by importing the TS modules and
// explicitly re-registering them with the singleton.
import triggerAutomationTool from '../../src/lib/tools/native/trigger-automation';
import listAutomationsTool from '../../src/lib/tools/native/list-automations';
import getAutomationTool from '../../src/lib/tools/native/get-automation';
import enableAutomationTool from '../../src/lib/tools/native/enable-automation';
import disableAutomationTool from '../../src/lib/tools/native/disable-automation';

const WEBAPP = 'http://test-webapp.example';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-int', authToken: 'tok-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('automation pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('trigger_automation'))
      registry.register('trigger_automation', triggerAutomationTool);
    if (!registry.has('list_automations'))
      registry.register('list_automations', listAutomationsTool);
    if (!registry.has('get_automation'))
      registry.register('get_automation', getAutomationTool);
    if (!registry.has('enable_automation'))
      registry.register('enable_automation', enableAutomationTool);
    if (!registry.has('disable_automation'))
      registry.register('disable_automation', disableAutomationTool);
  });

  test('NativeToolRegistry has all 5 automation-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'trigger_automation',
      'list_automations',
      'get_automation',
      'enable_automation',
      'disable_automation',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    // All five share the 'automation' server label
    for (const name of [
      'trigger_automation',
      'list_automations',
      'get_automation',
      'enable_automation',
      'disable_automation',
    ]) {
      expect(registry.get(name)?.server).toBe('automation');
    }
  });

  describe('end-to-end agent flow: list → get → enable → trigger → disable', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.WEBAPP_URL = WEBAPP;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent lists automations, picks one, enables, triggers, then disables', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // Track which endpoints have been hit so we can mutate state to simulate
      // the automation actually transitioning enabled/disabled across calls.
      let enabledFlag = false; // initial: paused
      let runStatus: 'queued' | 'running' | 'completed' = 'queued';
      let runPolls = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const method = init?.method ?? 'GET';

        // 1. list_automations → GET /api/v1/automations
        if (method === 'GET' && url.includes('/api/v1/automations?')) {
          return new Response(
            JSON.stringify({
              success: true,
              automations: [
                {
                  automationId: 'auto_briefing',
                  name: 'Daily Briefing',
                  description: 'Send morning summary',
                  graphId: 'graph_briefing',
                  triggers: [{ type: 'manual', config: {} }],
                  isEnabled: enabledFlag,
                  status: enabledFlag ? 'active' : 'paused',
                  stats: { runCount: 5 },
                  isOwned: true,
                },
                {
                  automationId: 'auto_other',
                  name: 'Something Else',
                  isEnabled: true,
                  isOwned: true,
                },
              ],
            }),
            { status: 200 },
          );
        }

        // 2. get_automation → GET /api/v1/automations/:id (no trailing parts)
        if (
          method === 'GET' &&
          /\/api\/v1\/automations\/auto_briefing$/.test(url)
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              automation: {
                automationId: 'auto_briefing',
                name: 'Daily Briefing',
                description: 'Send morning summary',
                graphId: 'graph_briefing',
                triggers: [{ type: 'manual', config: {} }],
                inputMapping: {},
                defaultInput: { topic: 'news' },
                secretNames: ['OPENAI_API_KEY'],
                isEnabled: enabledFlag,
                status: enabledFlag ? 'active' : 'paused',
                stats: { runCount: 5 },
              },
            }),
            { status: 200 },
          );
        }

        // 3. enable_automation → POST /api/v1/automations/:id/enable
        if (method === 'POST' && url.endsWith('/auto_briefing/enable')) {
          enabledFlag = true;
          return new Response(
            JSON.stringify({
              success: true,
              automation: {
                automationId: 'auto_briefing',
                isEnabled: true,
                status: 'active',
              },
            }),
            { status: 200 },
          );
        }

        // 4. trigger_automation → POST /api/v1/automations/:id/trigger
        if (method === 'POST' && url.endsWith('/auto_briefing/trigger')) {
          return new Response(
            JSON.stringify({
              success: true,
              mode: 'graph',
              runId: 'run_int_42',
              streamUrl: '/api/v1/runs/run_int_42/stream',
              run: {
                runId: 'run_int_42',
                automationId: 'auto_briefing',
                graphId: 'graph_briefing',
                status: 'queued',
                startedAt: '2026-04-27T00:00:00.000Z',
              },
            }),
            { status: 200 },
          );
        }

        // 4b. trigger_automation polling → GET /api/v1/automations/:id/runs/:runId
        if (
          method === 'GET' &&
          url.includes('/auto_briefing/runs/run_int_42')
        ) {
          runPolls += 1;
          if (runPolls === 1) {
            runStatus = 'running';
          } else {
            runStatus = 'completed';
          }
          return new Response(
            JSON.stringify({
              run: {
                runId: 'run_int_42',
                automationId: 'auto_briefing',
                status: runStatus,
                output:
                  runStatus === 'completed'
                    ? { summary: 'Today is sunny.' }
                    : null,
                durationMs: runStatus === 'completed' ? 950 : undefined,
                startedAt: '2026-04-27T00:00:00.000Z',
                completedAt:
                  runStatus === 'completed'
                    ? '2026-04-27T00:00:00.950Z'
                    : null,
              },
            }),
            { status: 200 },
          );
        }

        // 5. disable_automation → POST /api/v1/automations/:id/disable
        if (method === 'POST' && url.endsWith('/auto_briefing/disable')) {
          enabledFlag = false;
          return new Response(
            JSON.stringify({
              success: true,
              automation: {
                automationId: 'auto_briefing',
                isEnabled: false,
                status: 'paused',
              },
            }),
            { status: 200 },
          );
        }

        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;

      // ── 1. list_automations ──────────────────────────────────────────────
      const listResult = await registry.callTool('list_automations', {}, ctx);
      expect(listResult.isError).toBeFalsy();
      const listBody = JSON.parse(listResult.content[0].text);
      expect(listBody.automations).toHaveLength(2);
      const chosen = listBody.automations.find(
        (a: { automationId: string }) => a.automationId === 'auto_briefing',
      );
      expect(chosen).toBeDefined();
      expect(chosen.isEnabled).toBe(false); // initially paused

      // ── 2. get_automation — inspect details before deciding ──────────────
      const getResult = await registry.callTool(
        'get_automation',
        { automationId: chosen.automationId },
        ctx,
      );
      expect(getResult.isError).toBeFalsy();
      const getBody = JSON.parse(getResult.content[0].text);
      expect(getBody.automation.automationId).toBe('auto_briefing');
      expect(getBody.automation.defaultInput).toEqual({ topic: 'news' });
      expect(getBody.automation.secretNames).toEqual(['OPENAI_API_KEY']);

      // ── 3. enable_automation — re-activate it ────────────────────────────
      const enableResult = await registry.callTool(
        'enable_automation',
        { automationId: chosen.automationId },
        ctx,
      );
      expect(enableResult.isError).toBeFalsy();
      const enableBody = JSON.parse(enableResult.content[0].text);
      expect(enableBody.ok).toBe(true);
      expect(enableBody.isEnabled).toBe(true);

      // ── 4. trigger_automation with wait:true — block until completed ─────
      const triggerResult = await registry.callTool(
        'trigger_automation',
        {
          automationId: chosen.automationId,
          input: { topic: 'today' },
          wait: true,
          pollIntervalMs: 250,
          timeoutMs: 10_000,
        },
        ctx,
      );
      expect(triggerResult.isError).toBeFalsy();
      const triggerBody = JSON.parse(triggerResult.content[0].text);
      expect(triggerBody.runId).toBe('run_int_42');
      expect(triggerBody.status).toBe('completed');
      expect(triggerBody.output).toEqual({ summary: 'Today is sunny.' });
      expect(triggerBody.runDurationMs).toBe(950);
      expect(runPolls).toBeGreaterThanOrEqual(2);

      // ── 5. disable_automation — pause it again ───────────────────────────
      const disableResult = await registry.callTool(
        'disable_automation',
        { automationId: chosen.automationId },
        ctx,
      );
      expect(disableResult.isError).toBeFalsy();
      const disableBody = JSON.parse(disableResult.content[0].text);
      expect(disableBody.ok).toBe(true);
      expect(disableBody.isEnabled).toBe(false);

      // Final state check: a fresh list reflects the new disabled state.
      const finalList = await registry.callTool('list_automations', {}, ctx);
      const finalBody = JSON.parse(finalList.content[0].text);
      const finalChosen = finalBody.automations.find(
        (a: { automationId: string }) => a.automationId === 'auto_briefing',
      );
      expect(finalChosen.isEnabled).toBe(false);
      expect(finalChosen.status).toBe('paused');
    });

    test('agent flow handles 403 forbidden on enable (member, not owner)', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          return new Response(
            JSON.stringify({ error: 'Forbidden — owner only' }),
            { status: 403, statusText: 'Forbidden' },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;

      const r = await registry.callTool(
        'enable_automation',
        { automationId: 'someones_automation' },
        ctx,
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.status).toBe(403);
      expect(body.automationId).toBe('someones_automation');
    });

    test('trigger with stream-mode automation returns session info immediately', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            mode: 'stream',
            sessionId: 'sess_int',
            streamId: 'stream_meet',
            wsUrl: 'wss://example.com/ws',
            session: {
              sessionId: 'sess_int',
              automationId: 'auto_meet',
              streamId: 'stream_meet',
              status: 'queued',
              input: {},
              startedAt: '2026-04-27T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const r = await registry.callTool(
        'trigger_automation',
        { automationId: 'auto_meet', wait: true },
        ctx,
      );
      expect(r.isError).toBeFalsy();
      const body = JSON.parse(r.content[0].text);
      expect(body.mode).toBe('stream');
      expect(body.sessionId).toBe('sess_int');
      expect(body.streamId).toBe('stream_meet');
      expect(body.status).toBe('queued');
    });
  });
});
