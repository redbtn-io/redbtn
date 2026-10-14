import { describe, test, expect } from 'vitest';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import {
  prepareImageForModel,
  sniffImageMime,
  downscaleRgba,
  ImagePrepError,
} from '../../src/lib/media/image-prep';
import { describeToolResultImages } from '../../src/lib/media/describe-image';

function png(w: number, h: number, rgba: [number, number, number, number] = [10, 200, 30, 255]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set(rgba, i * 4);
  return PNG.sync.write(p);
}

describe('image-prep', () => {
  test('sniffs by magic bytes, not by name', () => {
    expect(sniffImageMime(png(2, 2))).toBe('image/png');
    const j = Buffer.from(jpeg.encode({ data: new Uint8Array(4 * 4 * 4).fill(128), width: 4, height: 4 }, 80).data);
    expect(sniffImageMime(j)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('hello world'))).toBeNull();
  });

  test('a small image passes through byte-for-byte', () => {
    const b = png(100, 50);
    const out = prepareImageForModel(b);
    expect(out.resized).toBe(false);
    expect(out.mimeType).toBe('image/png');
    expect(Buffer.from(out.data, 'base64').equals(b)).toBe(true);
    expect([out.width, out.height]).toEqual([100, 50]);
  });

  test('a phone screenshot is downscaled to 1568 on the long side, as JPEG', () => {
    const out = prepareImageForModel(png(1170, 2532));
    expect(out.resized).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.height).toBe(1568);
    expect(out.width).toBe(Math.round(1170 * (1568 / 2532)));
    expect([out.originalWidth, out.originalHeight]).toEqual([1170, 2532]);
    const decoded = jpeg.decode(Buffer.from(out.data, 'base64'), { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([out.width, out.height]);
    // colour survives the round trip
    expect(Math.abs(decoded.data[0] - 10)).toBeLessThan(12);
    expect(Math.abs(decoded.data[1] - 200)).toBeLessThan(12);
  });

  test('an over-budget image is re-encoded until it fits', () => {
    // Noise does not compress, so this PNG is ~2.5 MB at a size that needs no resize.
    const p = new PNG({ width: 800, height: 800 });
    let seed = 7;
    for (let i = 0; i < p.data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      p.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
    }
    const noisy = PNG.sync.write(p);
    expect(noisy.length).toBeGreaterThan(20_000);
    const out = prepareImageForModel(noisy, { maxBytes: 200_000 });
    expect(out.bytes).toBeLessThanOrEqual(200_000);
    expect(out.resized).toBe(true);
  });

  test('transparent pixels are flattened onto white', () => {
    const small = downscaleRgba({ data: new Uint8Array([0, 0, 0, 0]), width: 1, height: 1 }, 1, 1);
    expect(Array.from(small.data)).toEqual([255, 255, 255, 255]);
  });

  test('rejects non-images and oversized gif/webp', () => {
    expect(() => prepareImageForModel(Buffer.from('not an image'))).toThrow(ImagePrepError);
    const bigGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(3_000_000)]);
    expect(() => prepareImageForModel(bigGif)).toThrow(/convert it to PNG/);
  });
});

describe('describeToolResultImages', () => {
  const result = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'facts' }] };

  test('replace: pixels swapped for the description', async () => {
    const out = await describeToolResultImages(result, 'replace', async () => 'a green card that says PELICAN-42');
    expect(out.content.map((b: { type: string }) => b.type)).toEqual(['text', 'text']);
    expect(out.content[0].text).toContain('PELICAN-42');
  });

  test('append keeps the image; a failing describer becomes an honest note', async () => {
    const out = await describeToolResultImages(result, 'append', async () => { throw new Error('quota'); });
    expect(out.content[0].type).toBe('image');
    expect(out.content[1].text).toMatch(/could not describe it \(quota\)/);
  });

  test('no image: returned unchanged', async () => {
    const plain = { content: [{ type: 'text', text: 'x' }] };
    expect(await describeToolResultImages(plain, 'replace', async () => 'never')).toBe(plain);
  });
});

describe('stripImageDataForRecord', () => {
  test('replaces image base64 with a marker, leaves text alone, does not mutate', async () => {
    const { stripImageDataForRecord } = await import('../../src/lib/media/image-prep');
    const r = { content: [{ type: 'image', data: 'A'.repeat(4000), mimeType: 'image/jpeg' }, { type: 'text', text: 'facts' }] };
    const out = stripImageDataForRecord(r);
    expect(out.content[0]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '<omitted: 3000 bytes>' });
    expect(out.content[1]).toBe(r.content[1]);
    expect(r.content[0].data).toHaveLength(4000);
    const plain = { content: [{ type: 'text', text: 'x' }] };
    expect(stripImageDataForRecord(plain)).toBe(plain);
  });
});
