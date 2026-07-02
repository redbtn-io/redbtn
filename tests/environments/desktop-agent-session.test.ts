/**
 * DesktopAgentSession — exec-binding Goal 4 P4b. Verifies the push session maps
 * the relay reply onto the IEnvironmentSession surface. Mocks requestDesktopRaw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const raw = vi.fn();
vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktopRaw: (...a: unknown[]) => raw(...a),
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
