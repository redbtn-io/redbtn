/**
 * resolveImageAttachments: hub-stored chat images (relative, auth-gated urls)
 * become data: urls the model can read; everything else passes through.
 */
import { describe, it, expect, vi } from 'vitest';
import { PNG } from 'pngjs';
import { resolveImageAttachments, hubAttachmentId } from '../../src/lib/nodes/universal/executors/attachmentImages';

function tinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(200);
  return PNG.sync.write(png);
}

function okResponse(buf: Buffer) {
  return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-type': 'image/png' } });
}

const hubRef = { attachmentId: 'att_abc-1', kind: 'image' as const, mimeType: 'image/png', url: '/api/v1/attachments/att_abc-1' };

describe('hubAttachmentId', () => {
  it('reads the id from a relative hub url', () => {
    expect(hubAttachmentId(hubRef)).toBe('att_abc-1');
  });
  it('leaves absolute and data urls alone', () => {
    expect(hubAttachmentId({ kind: 'image', url: 'https://cdn.example.com/x.png' })).toBeNull();
    expect(hubAttachmentId({ kind: 'image', url: 'data:image/png;base64,AAAA' })).toBeNull();
  });
  it('falls back to attachmentId when there is no url', () => {
    expect(hubAttachmentId({ kind: 'image', attachmentId: 'att_x' })).toBe('att_x');
  });
  it('refuses other relative paths', () => {
    expect(hubAttachmentId({ kind: 'image', url: '/api/v1/secrets/foo' })).toBeNull();
  });
});

describe('resolveImageAttachments', () => {
  it('fetches a hub image with the service key on behalf of the user and returns a data url', async () => {
    const fetchFn = vi.fn(async () => okResponse(tinyPng()));
    const out = await resolveImageAttachments([hubRef], {
      fetchFn: fetchFn as any, baseUrl: 'http://hub:3000/', serviceKey: 'k', userId: 'u1',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as any;
    expect(url).toBe('http://hub:3000/api/v1/attachments/att_abc-1');
    expect(init.headers).toEqual({ 'x-internal-key': 'k', 'x-on-behalf-of-user': 'u1' });
    expect(out).toHaveLength(1);
    expect(out[0].url).toMatch(/^data:image\/png;base64,/);
    expect(out[0].attachmentId).toBe('att_abc-1');
  });

  it('does not fetch when nothing needs resolving', async () => {
    const fetchFn = vi.fn();
    const list = [{ kind: 'image' as const, url: 'https://cdn.example.com/x.png' }, { kind: 'document' as const, url: '/api/v1/attachments/att_doc' }];
    const out = await resolveImageAttachments(list, { fetchFn: fetchFn as any, serviceKey: 'k' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toBe(list);
  });

  it('drops an image the hub refuses, keeps the rest', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 404 }));
    const other = { kind: 'image' as const, url: 'https://cdn.example.com/x.png' };
    const out = await resolveImageAttachments([hubRef, other], { fetchFn: fetchFn as any, serviceKey: 'k' });
    expect(out).toEqual([other]);
  });

  it('drops hub images when no service key is configured', async () => {
    const fetchFn = vi.fn();
    const out = await resolveImageAttachments([hubRef], { fetchFn: fetchFn as any, serviceKey: '' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('drops bytes that are not an image', async () => {
    const fetchFn = vi.fn(async () => okResponse(Buffer.from('<html>nope</html>')));
    const out = await resolveImageAttachments([hubRef], { fetchFn: fetchFn as any, serviceKey: 'k' });
    expect(out).toEqual([]);
  });
});
