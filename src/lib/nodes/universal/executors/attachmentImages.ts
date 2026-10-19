/**
 * Turn hub-stored image attachments into pixels a model can read.
 *
 * Chat attachments reach a run as refs like
 * `{ attachmentId, kind: 'image', url: '/api/v1/attachments/att_...' }`.
 * The url is RELATIVE to the hub and the route needs auth, so handing it to
 * a provider as an `image_url` part gives the model nothing to fetch: every
 * chat screenshot sent to an Op / chat graph was silently dropped.
 *
 * Here each such image is fetched from the hub with the worker's
 * INTERNAL_SERVICE_KEY, on behalf of the run's user (`x-on-behalf-of-user`:
 * the hub applies that user's attachment access check), prepared with the
 * same limits as tool-result images (lib/media/image-prep) and returned as a
 * `data:` url. Absolute http(s) and data: urls pass through unchanged. An
 * image that cannot be loaded is dropped with a warning; it never fails the
 * step.
 */
import type { AttachmentRef } from './multimodalMessage';
import { prepareImageForModel } from '../../../media/image-prep';

const HUB_ATTACHMENT_PATH = /^\/api\/v1\/attachments\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/;
/** Refuse bigger downloads before decoding (a 4K PNG screenshot is ~10 MB). */
const MAX_DOWNLOAD_BYTES = 25_000_000;
const FETCH_TIMEOUT_MS = 20_000;

export interface ResolveImageAttachmentsOptions {
  /** The run's user; the hub only serves attachments this user may read. */
  userId?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  serviceKey?: string;
}

function isImage(a: AttachmentRef): boolean {
  return a?.kind === 'image' || (a?.mimeType ?? '').startsWith('image/');
}

/** The hub attachment id behind a ref, or null when the url is already fetchable. */
export function hubAttachmentId(a: AttachmentRef): string | null {
  const url = typeof a.url === 'string' ? a.url.trim() : '';
  if (/^(https?:|data:)/i.test(url)) return null;
  const m = url.match(HUB_ATTACHMENT_PATH);
  if (m) return m[1];
  if (!url && typeof a.attachmentId === 'string' && /^[A-Za-z0-9_-]+$/.test(a.attachmentId)) return a.attachmentId;
  return null;
}

export async function resolveImageAttachments(
  attachments: AttachmentRef[],
  opts: ResolveImageAttachmentsOptions = {},
): Promise<AttachmentRef[]> {
  if (!attachments.some((a) => isImage(a) && hubAttachmentId(a))) return attachments;

  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = (opts.baseUrl || process.env.WEBAPP_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const serviceKey = opts.serviceKey ?? process.env.INTERNAL_SERVICE_KEY ?? '';

  const out: AttachmentRef[] = [];
  for (const a of attachments) {
    const id = isImage(a) ? hubAttachmentId(a) : null;
    if (!id) {
      out.push(a);
      continue;
    }
    if (!serviceKey) {
      console.warn(`[NeuronExecutor] image attachment ${id} dropped: INTERNAL_SERVICE_KEY is not set`);
      continue;
    }
    try {
      const headers: Record<string, string> = { 'x-internal-key': serviceKey };
      if (opts.userId) headers['x-on-behalf-of-user'] = String(opts.userId);
      const res = await fetchFn(`${baseUrl}/api/v1/attachments/${encodeURIComponent(id)}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`hub returned HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`${declared} bytes is over the ${MAX_DOWNLOAD_BYTES}-byte limit`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`${buf.length} bytes is over the ${MAX_DOWNLOAD_BYTES}-byte limit`);
      const img = prepareImageForModel(buf);
      out.push({ ...a, mimeType: img.mimeType, url: `data:${img.mimeType};base64,${img.data}` });
      console.log(
        `[NeuronExecutor] image attachment ${id} loaded from the hub (${buf.length} bytes -> ${img.bytes}${img.resized ? ', resized' : ''})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[NeuronExecutor] image attachment ${id} dropped: ${msg}`);
    }
  }
  return out;
}
