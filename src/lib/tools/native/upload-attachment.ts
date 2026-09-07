/**
 * Native tool: upload_attachment
 *
 * Uploads a file to the redbtn attachment store (webapp GridFS bucket) and
 * publishes an `attachment` event to the run stream so the UI can display it.
 *
 * Input accepts one of three source modes:
 *   - filePath   — read a local file from disk (worker side only)
 *   - base64     — inline base64-encoded data (any environment)
 *   - url        — download from a remote URL and re-upload
 *
 * Returns: { attachmentId, fileId, url, kind, mimeType, size }
 *
 * The tool calls the webapp's POST /api/v1/attachments endpoint using the
 * INTERNAL_SERVICE_KEY env var for auth, so it works in the worker process
 * without needing a user session token.
 *
 * The `caption` field (optional) is forwarded to the attachment event.
 *
 * # Security
 *
 * There are two outbound requests here and they are NOT the same kind of thing:
 *
 *   - the caller-supplied `url` source download — model-chosen, and therefore
 *     guarded. It goes through `safeFetch` (`lib/net/ssrf-guard`), which
 *     refuses a host resolving to a private / loopback / link-local address AT
 *     REQUEST TIME and re-checks every redirect hop (max 5). Without it,
 *     `upload_attachment({ url: 'http://10.100.0.10:9000/...' })` copied any
 *     internal endpoint's response into the attachment store, where the model
 *     can read it straight back.
 *   - the upload POST to `${BASE_URL}/api/v1/attachments` with
 *     `x-internal-key` — the deployment's OWN endpoint, from an env var, not
 *     from the caller. It is deliberately NOT guarded: `BASE_URL` is routinely
 *     `http://localhost:3000` or a fleet LAN address, and guarding it would
 *     break every worker. The service key travels only on this fixed URL and
 *     never on the caller's.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import * as fs from 'fs';
import * as path from 'path';
import { safeFetch, SsrfBlockedError } from '../../net/ssrf-guard';
import { callerIsTrusted, ssrfBlockedResult, PUBLIC_HOSTS_ONLY_NOTE } from './_outbound-url';

type AnyObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guessMimeType(filename: string, hint?: string): string {
  if (hint) return hint;
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function guessKind(mimeType: string): 'image' | 'video' | 'audio' | 'document' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('spreadsheet') ||
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/json'
  ) {
    return 'document';
  }
  return 'file';
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const uploadAttachmentTool: NativeToolDefinition = {
  description:
    'Upload a file to the redbtn attachment store and publish it to the run stream. ' +
    'Accepts a local file path, base64-encoded data, or a remote URL to download. ' +
    'Returns attachmentId, fileId, and a download URL. ' +
    `When downloading from a URL: ${PUBLIC_HOSTS_ONLY_NOTE}`,
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to a local file to upload (worker-side only)',
      },
      base64: {
        type: 'string',
        description: 'Base64-encoded file content',
      },
      url: {
        type: 'string',
        description:
          'Remote URL to download and re-upload. Refused when the host ' +
          'resolves to a private, loopback or link-local address at the time ' +
          'of the request.',
      },
      filename: {
        type: 'string',
        description: 'Original filename including extension (required when using base64 or url)',
      },
      mimeType: {
        type: 'string',
        description: 'MIME type override (auto-detected from filename if omitted)',
      },
      caption: {
        type: 'string',
        description: 'Optional human-readable caption shown in the UI',
      },
    },
    // At least one source is required; enforced in handler
  },

  async handler(args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const { filePath, base64: base64Data, url: sourceUrl, mimeType: mimeTypeHint, caption } = args as {
      filePath?: string;
      base64?: string;
      url?: string;
      filename?: string;
      mimeType?: string;
      caption?: string;
    };

    let filename = (args.filename as string | undefined) || '';

    // ── Resolve internal service key ─────────────────────────────────────────
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
    if (!serviceKey) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'INTERNAL_SERVICE_KEY env var is not set' }) }],
        isError: true,
      };
    }

    const baseUrl =
      process.env.BASE_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    const uploadUrl = `${baseUrl}/api/v1/attachments`;

    let buffer: Buffer;
    let resolvedMimeType: string;

    // ── Source: local file ───────────────────────────────────────────────────
    if (filePath) {
      try {
        buffer = fs.readFileSync(filePath as string);
        if (!filename) filename = path.basename(filePath as string);
        resolvedMimeType = guessMimeType(filename, mimeTypeHint);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to read file: ${msg}` }) }],
          isError: true,
        };
      }
    }
    // ── Source: base64 ───────────────────────────────────────────────────────
    else if (base64Data) {
      if (!filename) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'filename is required when using base64 input' }) }],
          isError: true,
        };
      }
      try {
        buffer = Buffer.from(base64Data as string, 'base64');
        resolvedMimeType = guessMimeType(filename, mimeTypeHint);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to decode base64: ${msg}` }) }],
          isError: true,
        };
      }
    }
    // ── Source: remote URL ───────────────────────────────────────────────────
    else if (sourceUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        // SSRF guard on the CALLER's url — see the security note in the module
        // header for why the upload target below is deliberately exempt.
        const resp = await safeFetch(
          sourceUrl as string,
          { signal: controller.signal },
          { trusted: callerIsTrusted(context) },
        );
        clearTimeout(timer);
        if (!resp.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Failed to fetch URL: ${resp.status} ${resp.statusText}` }) }],
            isError: true,
          };
        }
        const arrayBuffer = await resp.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
        // Try to detect filename from URL if not provided
        if (!filename) {
          const urlPath = new URL(sourceUrl as string).pathname;
          filename = path.basename(urlPath) || 'attachment';
        }
        // Prefer Content-Type from response, fall back to hint or extension
        const ctHeader = resp.headers.get('content-type')?.split(';')[0]?.trim();
        resolvedMimeType = mimeTypeHint || ctHeader || guessMimeType(filename);
      } catch (err: unknown) {
        if (err instanceof SsrfBlockedError) {
          return ssrfBlockedResult(err, 'upload_attachment', { url: sourceUrl });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to download URL: ${msg}` }) }],
          isError: true,
        };
      }
    } else {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Provide one of: filePath, base64, or url' }) }],
        isError: true,
      };
    }

    const kind = guessKind(resolvedMimeType);

    // ── Upload to webapp attachment store ────────────────────────────────────
    let attachmentId: string;
    let fileId: string;
    let downloadUrl: string;

    try {
      // Build multipart form data
      const formData = new FormData();
      // Convert Buffer to Uint8Array to satisfy strict BlobPart types
      const blob = new Blob([new Uint8Array(buffer)], { type: resolvedMimeType });
      formData.append('file', blob, filename);
      if (caption) formData.append('caption', caption as string);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);

      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'x-internal-key': serviceKey },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Upload failed: ${resp.status} ${body.substring(0, 200)}` }) }],
          isError: true,
        };
      }

      const data = await resp.json() as {
        attachmentId: string;
        fileId: string;
        url: string;
        kind: string;
        mimeType: string;
        size: number;
      };

      attachmentId = data.attachmentId;
      fileId = data.fileId;
      downloadUrl = data.url;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Upload request failed: ${msg}` }) }],
        isError: true,
      };
    }

    // ── Publish attachment event to run stream ───────────────────────────────
    const { publisher } = context;
    if (publisher && typeof publisher.attachment === 'function') {
      try {
        await publisher.attachment({
          attachmentId,
          kind,
          mimeType: resolvedMimeType,
          filename,
          size: buffer.length,
          fileId,
          url: downloadUrl,
          caption: caption as string | undefined,
        });
      } catch (pubErr: unknown) {
        // Non-fatal — the upload already succeeded
        const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
        console.warn('[upload_attachment] Failed to publish attachment event:', msg);
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          attachmentId,
          fileId,
          url: downloadUrl,
          kind,
          mimeType: resolvedMimeType,
          size: buffer.length,
          filename,
        }),
      }],
    };
  },
};

export default uploadAttachmentTool;
module.exports = uploadAttachmentTool;
