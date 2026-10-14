/**
 * Prepare an image for a model's eyes.
 *
 * Tool results that carry pixels (`view_image`, screenshots) go to providers
 * with hard limits: Anthropic rejects an image over ~5 MB of base64 and
 * downsamples anything over ~1568 px on the long side anyway; the CLI bridge
 * caps a frame at 8 MB. A phone screenshot (1170x2532 PNG, 2-4 MB) is over
 * the first limit as-is.
 *
 * PNG and JPEG are decoded in pure JS (pngjs, jpeg-js — no native deps in the
 * worker image), box-downscaled to `maxDimension` on the long side and
 * re-encoded as JPEG (alpha flattened onto white). An image already within
 * both limits is passed through byte-for-byte. GIF and WebP are passed through
 * when small enough and refused otherwise (the caller says how to convert).
 */
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const DEFAULT_MAX_DIMENSION = 1568;
export const MIN_MAX_DIMENSION = 256;
export const MAX_MAX_DIMENSION = 4096;
/** Raw-byte budget for one image sent to a model (base64 is ~4/3 of this). */
export const DEFAULT_MAX_IMAGE_BYTES = 2_500_000;

export interface PreparedImage {
  /** base64, no data: prefix. */
  data: string;
  mimeType: ImageMime;
  bytes: number;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
  originalBytes: number;
  originalMimeType: ImageMime;
  resized: boolean;
}

export class ImagePrepError extends Error {
  constructor(message: string, public code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DECODE_FAILED') {
    super(message);
    this.name = 'ImagePrepError';
  }
}

/** Identify an image by its magic bytes (never trust a file extension or content-type). */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

function decode(buf: Buffer, mime: ImageMime): Rgba {
  try {
    if (mime === 'image/png') {
      const png = PNG.sync.read(buf);
      return { data: png.data, width: png.width, height: png.height };
    }
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 120, maxMemoryUsageInMB: 1024 });
    return { data: img.data, width: img.width, height: img.height };
  } catch (err) {
    throw new ImagePrepError(`could not decode ${mime}: ${err instanceof Error ? err.message : String(err)}`, 'DECODE_FAILED');
  }
}

/** Area-average downscale to (dw x dh), flattening alpha onto white. */
export function downscaleRgba(src: Rgba, dw: number, dh: number): Rgba {
  const { width: sw, height: sh, data: s } = src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        let i = (yy * sw + sx0) * 4;
        for (let xx = sx0; xx < sx1; xx++, i += 4) {
          const a = s[i + 3] / 255;
          r += s[i] * a + 255 * (1 - a);
          g += s[i + 1] * a + 255 * (1 - a);
          b += s[i + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= max) return { w, h };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function prepareImageForModel(
  buf: Buffer,
  opts: { maxDimension?: number; maxBytes?: number } = {},
): PreparedImage {
  const maxDimension = Math.min(
    MAX_MAX_DIMENSION,
    Math.max(MIN_MAX_DIMENSION, Math.floor(opts.maxDimension ?? DEFAULT_MAX_DIMENSION)),
  );
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const mime = sniffImageMime(buf);
  if (!mime) {
    throw new ImagePrepError('not a PNG, JPEG, GIF or WebP image (checked the file bytes, not the name)', 'UNSUPPORTED_FORMAT');
  }

  if (mime === 'image/gif' || mime === 'image/webp') {
    if (buf.length > maxBytes) {
      throw new ImagePrepError(
        `${mime} of ${buf.length} bytes is over the ${maxBytes}-byte limit and cannot be resized here; convert it to PNG first (e.g. ImageMagick: convert in.webp -resize ${maxDimension}x${maxDimension} out.png)`,
        'TOO_LARGE',
      );
    }
    return {
      data: buf.toString('base64'),
      mimeType: mime,
      bytes: buf.length,
      originalBytes: buf.length,
      originalMimeType: mime,
      resized: false,
    };
  }

  const img = decode(buf, mime);
  const target = fitWithin(img.width, img.height, maxDimension);
  if (target.w === img.width && target.h === img.height && buf.length <= maxBytes) {
    return {
      data: buf.toString('base64'),
      mimeType: mime,
      bytes: buf.length,
      width: img.width,
      height: img.height,
      originalWidth: img.width,
      originalHeight: img.height,
      originalBytes: buf.length,
      originalMimeType: mime,
      resized: false,
    };
  }

  // Shrink, then tighten quality / size until it fits the byte budget.
  let { w, h } = target;
  for (const quality of [85, 75, 65, 55, 45, 35]) {
    // Always through downscaleRgba, even at 1:1: it flattens alpha onto white
    // (JPEG has no alpha; jpeg-js would otherwise keep the raw RGB of
    // transparent pixels, often black).
    const small = downscaleRgba(img, w, h);
    const encoded = jpeg.encode({ data: small.data, width: w, height: h }, quality).data;
    const out = Buffer.from(encoded);
    if (out.length <= maxBytes) {
      return {
        data: out.toString('base64'),
        mimeType: 'image/jpeg',
        bytes: out.length,
        width: w,
        height: h,
        originalWidth: img.width,
        originalHeight: img.height,
        originalBytes: buf.length,
        originalMimeType: mime,
        resized: true,
      };
    }
    if (quality <= 55) {
      const next = fitWithin(w, h, Math.max(MIN_MAX_DIMENSION, Math.floor(Math.max(w, h) * 0.75)));
      w = next.w;
      h = next.h;
    }
  }
  throw new ImagePrepError(`could not fit the image into ${maxBytes} bytes`, 'TOO_LARGE');
}

/**
 * A copy of an MCP tool result safe to PUBLISH / PERSIST: every image block's
 * base64 replaced by a short marker. The model gets the real pixels; run state,
 * run events and archived messages must not carry megabytes of base64 per
 * screenshot (a conversation document is capped at 16 MB).
 */
export function stripImageDataForRecord<T>(result: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  if (!r || typeof r !== 'object' || !Array.isArray(r.content)) return result;
  if (!r.content.some((b: { type?: string; data?: unknown }) => b && b.type === 'image' && typeof b.data === 'string')) {
    return result;
  }
  return {
    ...r,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: r.content.map((b: any) =>
      b && b.type === 'image' && typeof b.data === 'string'
        ? { type: 'image', mimeType: b.mimeType, data: `<omitted: ${Math.round((b.data.length * 3) / 4)} bytes>` }
        : b,
    ),
  } as T;
}
