/**
 * DesktopAgentSession — exec-binding Goal 4 P4b. Verifies the push session maps
 * the relay reply onto the IEnvironmentSession surface. Mocks requestDesktopRaw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const raw = vi.fn();
vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktopRaw: (...a: unknown[]) => raw(...a),
}));

// The push session fences every relay op behind the hub's presence key. Stub the
// probe to `unknown` (= "cannot tell", treated as online) so these tests keep
// asserting relay behaviour without opening a Redis connection.
vi.mock('../../src/lib/environments/desktop-presence', () => ({
  probeDesktopPresence: async () => ({ verdict: 'unknown', source: 'unavailable' }),
}));

import { DesktopAgentSession, DesktopAgentError } from '../../src/lib/environments/DesktopAgentSession';

const env: any = { environmentId: 'env_ABC', kind: 'cli', userId: 'u1', installId: 'cli-1' };
function session() { return new DesktopAgentSession(env, 'u1', 'cli-1'); }

beforeEach(() => raw.mockReset());

describe('DesktopAgentSession — exec', () => {
  it('maps a successful exec_result to ExecResult', async () => {
    raw.mockResolvedValue({ ok: true, result: { stdout: 'hi', stderr: 'e', exitCode: 0, durationMs: 5, truncated: false } });
    const s = session();
    const r = await s.exec('ls', { cwd: '/tmp' });
    expect(r).toEqual({ stdout: 'hi', stderr: 'e', exitCode: 0, durationMs: 5, truncated: false });
    // targeted the right connector + carried the command/cwd
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', installId: 'cli-1', kind: 'exec',
      payload: expect.objectContaining({ command: 'ls', cwd: '/tmp' }),
    }));
  });
  it('throws DesktopAgentError with the connector error on failure', async () => {
    raw.mockResolvedValue({ ok: false, error: { code: 'capability_disabled', message: 'exec is not enabled' } });
    await expect(session().exec('ls')).rejects.toMatchObject({ name: 'DesktopAgentError', code: 'capability_disabled' });
  });
  it('propagates a non-zero exitCode', async () => {
    raw.mockResolvedValue({ ok: true, result: { stdout: '', stderr: 'boom', exitCode: 127, durationMs: 1, truncated: false } });
    const r = await session().exec('nope');
    expect(r.exitCode).toBe(127);
  });
  it('surfaces stream chunks to opts.onChunk and emits exec_chunk events', async () => {
    raw.mockImplementation(async (...allArgs: any[]) => {
      if (allArgs.length === 0) return { ok: true };
      const args = allArgs[0];
      args.onChunk?.({ stream: 'stdout', chunk: 'hello ', seq: 0 });
      args.onChunk?.({ stream: 'stderr', chunk: 'err ', seq: 1 });
      args.onChunk?.({ stream: 'stdout', chunk: 'world', seq: 2 });
      return { ok: true, result: { stdout: 'hello world', stderr: 'err ', exitCode: 0, durationMs: 10, truncated: false } };
    });
    const s = session();
    const emittedEvents: any[] = [];
    s.on('exec_chunk', (e) => emittedEvents.push(e));
    const capturedChunks: any[] = [];
    const r = await s.exec('echo hi', {
      onChunk: (c) => capturedChunks.push(c),
    });
    expect(r.exitCode).toBe(0);
    expect(capturedChunks).toEqual([
      { stream: 'stdout', chunk: 'hello ', seq: 0 },
      { stream: 'stderr', chunk: 'err ', seq: 1 },
      { stream: 'stdout', chunk: 'world', seq: 2 },
    ]);
    expect(emittedEvents.length).toBe(3);
    expect(emittedEvents[0]).toEqual({
      environmentId: 'env_ABC',
      command: 'echo hi',
      stream: 'stdout',
      chunk: 'hello ',
      seq: 0,
    });
  });
  it('falls back to buffered output on opts.onChunk if no chunks were streamed', async () => {
    raw.mockResolvedValue({
      ok: true,
      result: { stdout: 'buffered out', stderr: 'buffered err', exitCode: 0, durationMs: 5, truncated: false },
    });
    const s = session();
    const capturedChunks: any[] = [];
    const r = await s.exec('legacy-cmd', {
      onChunk: (c) => capturedChunks.push(c),
    });
    expect(r.stdout).toBe('buffered out');
    expect(capturedChunks).toEqual([
      { stream: 'stdout', chunk: 'buffered out', seq: 0 },
      { stream: 'stderr', chunk: 'buffered err', seq: 1 },
    ]);
  });
  it('forwards abortSignal to requestDesktopRaw', async () => {
    raw.mockResolvedValue({ ok: true, result: { exitCode: 0 } });
    const ac = new AbortController();
    await session().exec('sleep 10', { abortSignal: ac.signal });
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: ac.signal,
    }));
  });
});

describe('DesktopAgentSession — sftp', () => {
  it('sftpRead decodes base64 content', async () => {
    raw.mockResolvedValue({ ok: true, result: { contentB64: Buffer.from('file-data').toString('base64') } });
    const buf = await session().sftpRead('/x');
    expect(buf.toString()).toBe('file-data');
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sftp_read', payload: expect.objectContaining({ path: '/x' }) }));
  });
  it('sftpWrite base64-encodes content + targets sftp_write', async () => {
    raw.mockResolvedValue({ ok: true });
    await session().sftpWrite('/x', 'hello');
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sftp_write',
      payload: expect.objectContaining({ path: '/x', contentB64: Buffer.from('hello').toString('base64') }),
    }));
  });
  it('sftpReaddir maps entries', async () => {
    raw.mockResolvedValue({ ok: true, result: { entries: [{ name: 'a', type: 'file', size: 3 }, { name: 'd', type: 'dir' }] } });
    const list = await session().sftpReaddir('/');
    expect(list.map((e) => e.name)).toEqual(['a', 'd']);
    expect(list[1].type).toBe('dir');
  });
  it('sftpStat maps fields', async () => {
    raw.mockResolvedValue({ ok: true, result: { size: 10, isFile: true } });
    const st = await session().sftpStat('/x');
    expect(st.size).toBe(10); expect(st.isFile).toBe(true); expect(st.isDirectory).toBe(false);
  });
});

describe('DesktopAgentSession — lifecycle + serialization', () => {
  it('open/close transition state + emit lifecycle', async () => {
    const s = session();
    const events: string[] = [];
    s.on('lifecycle', (e: any) => events.push(e.to));
    expect(s.state).toBe('closed');
    await s.open(); expect(s.state).toBe('open');
    await s.close(); expect(s.state).toBe('closed');
    expect(events).toEqual(['open', 'closed']);
  });
  it('serializes ops in order (opChain)', async () => {
    // serialize() only invokes the next op after the prior op's promise settles,
    // so the relay is called strictly 1→2→3 even under Promise.all.
    raw.mockResolvedValue({ ok: true, result: { exitCode: 0 } });
    const s = session();
    await Promise.all([s.exec('1'), s.exec('2'), s.exec('3')]);
    const invokedOrder = raw.mock.calls.map((c: any[]) => c[0].payload.command);
    expect(invokedOrder).toEqual(['1', '2', '3']);
  });
});
