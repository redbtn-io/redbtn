/**
 * Download File — Native Files Tool
 *
 * Downloads the contents of a remote URL into memory and returns the bytes
 * as base64 along with the detected MIME type and total byte size.
 *
 * Spec: TOOL-HANDOFF.md §4.14
 *   - inputs:  url (required), maxSizeBytes (default 10 * 1024 * 1024)
 *   - output:  { contentBase64, mimeType, size }
 *
 * Use this when an agent needs the raw bytes of a remote file (e.g. an image,
 * a PDF, or a CSV) so it can hand them to another tool (`parse_document`,
 * `upload_attachment`, `upload_to_library`, etc.) without writing to disk.
 *
 * The download is bounded:
 *   - Only http:// and https:// URLs are accepted (no file://, ftp://,
 *     javascript:, data:, etc).
 *   - The response is rejected if Content-Length is bigger than maxSizeBytes,
 *     and aborted mid-stream if the body grows past the cap.
 *   - A 60 second per-request timeout is enforced; the run-level abort signal
 *     is also honoured for early cancellation.
 *
 * MIME type resolution prefers the upstream Content-Type header (with any
 * `; charset=...` segment stripped). If that's missing or generic
 * (`application/octet-stream`), we fall back to a best-effort guess based on
 * the URL path's extension. The final value is never empty — defaults to
 * `application/octet-stream` when no signal is available.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const HARD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB absolute ceiling
const REQUEST_TIMEOUT_MS = 60_000;

interface DownloadFileArgs {
  url?: string;
  maxSizeBytes?: number;
}

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
};

function guessMimeFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    return EXTENSION_MIME[ext] || null;
  } catch {
    return null;
  }
}

function normalizeContentType(header: string | null): string | null {
  if (!header) return null;
  const cleaned = header.split(';')[0]?.trim().toLowerCase();
  if (!cleaned) return null;
  return cleaned;
}

const downloadFileTool: NativeToolDefinition = {
  description:
    'Download a remote file (HTTP/HTTPS only) and return its bytes as base64 along with the detected MIME type and size. ' +
    'Use to hand the raw file off to another tool (parse_document, upload_attachment, upload_to_library) without touching disk. ' +
    'Bounded by a configurable maxSizeBytes (default 10MB, hard ceiling 100MB) and a 60s timeout.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The http:// or https:// URL to download.',
      },
      maxSizeBytes: {
        type: 'integer',
        description:
          'Maximum response size in bytes. Default 10485760 (10 MB). Hard ceiling 104857600 (100 MB). The download is aborted mid-stream if the body grows past this cap.',
        minimum: 1,
        maximum: HARD_MAX_SIZE,
      },
    },
    required: ['url'],
  },

  async handler(
    rawArgs: AnyObject,
    context: NativeToolContext,
  ): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DownloadFileArgs>;
    const url = typeof args.url === 'string' ? args.url.trim() : '';

    // ── Validation ──────────────────────────────────────────────────────────
    if (!url) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'url is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Invalid URL: ${url}`,
              code: 'VALIDATION',
              url,
            }),
          },
        ],
        isError: true,
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Only http:// or https:// URLs are supported; got ${parsedUrl.protocol}`,
              code: 'VALIDATION',
              url,
            }),
          },
        ],
        isError: true,
      };
    }

    // Resolve maxSizeBytes — clamp to the hard ceiling, default if missing.
    let maxSizeBytes = DEFAULT_MAX_SIZE;
    if (typeof args.maxSizeBytes === 'number' && Number.isFinite(args.maxSizeBytes)) {
      const requested = Math.floor(args.maxSizeBytes);
      if (requested <= 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'maxSizeBytes must be a positive integer',
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }
      maxSizeBytes = Math.min(requested, HARD_MAX_SIZE);
    }

    // ── Request setup ───────────────────────────────────────────────────────
    const controller = new AbortController();
    const runAbortSignal = context?.abortSignal || null;
    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const runAbortListener = runAbortSignal
      ? () => controller.abort()
      : null;
    if (runAbortSignal && runAbortListener) {
      if (runAbortSignal.aborted) {
        clearTimeout(timer);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'download_file aborted before send',
                code: 'ABORTED',
                url,
              }),
            },
          ],
          isError: true,
        };
      }
      runAbortSignal.addEventListener('abort', runAbortListener, { once: true });
    }

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `HTTP ${response.status} ${response.statusText}`.trim(),
                status: response.status,
                url,
              }),
            },
          ],
          isError: true,
        };
      }

      // Reject up-front if Content-Length is over the cap.
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declared = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(declared) && declared > maxSizeBytes) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `File size ${declared} bytes exceeds maxSizeBytes ${maxSizeBytes}`,
                  code: 'TOO_LARGE',
                  declaredSize: declared,
                  maxSizeBytes,
                  url,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // Stream the body so we can stop early if it overflows.
      const chunks: Uint8Array[] = [];
      let received = 0;

      const body = response.body;
      if (body) {
        const reader = body.getReader();
        try {
          // Read until done or we exceed the cap.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              received += value.byteLength;
              if (received > maxSizeBytes) {
                try {
                  await reader.cancel();
                } catch {
                  /* ignore */
                }
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        error: `Response body exceeded maxSizeBytes ${maxSizeBytes} (read ${received} bytes before aborting)`,
                        code: 'TOO_LARGE',
                        maxSizeBytes,
                        url,
                      }),
                    },
                  ],
                  isError: true,
                };
              }
              chunks.push(value);
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
        }
      } else {
        // Some fetch implementations / mocks return no streamable body. Fall
        // back to the buffered path and re-check the size.
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        if (bytes.byteLength > maxSizeBytes) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Response body exceeded maxSizeBytes ${maxSizeBytes} (read ${bytes.byteLength} bytes)`,
                  code: 'TOO_LARGE',
                  maxSizeBytes,
                  url,
                }),
              },
            ],
            isError: true,
          };
        }
        chunks.push(bytes);
        received = bytes.byteLength;
      }

      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

      // Resolve MIME type. Prefer header when present and non-generic.
      const headerMime = normalizeContentType(response.headers.get('content-type'));
      const guessed = guessMimeFromUrl(url);
      let mimeType: string;
      if (headerMime && headerMime !== 'application/octet-stream') {
        mimeType = headerMime;
      } else if (guessed) {
        mimeType = guessed;
      } else if (headerMime) {
        mimeType = headerMime;
      } else {
        mimeType = 'application/octet-stream';
      }

      const contentBase64 = buffer.toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              contentBase64,
              mimeType,
              size: buffer.length,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      let message: string;
      if (error?.name === 'AbortError') {
        if (runAbortSignal?.aborted) {
          message = 'download_file aborted by caller';
        } else if (timeoutFired) {
          message = `download_file timed out after ${REQUEST_TIMEOUT_MS}ms`;
        } else {
          message = error?.message || 'download_file aborted (unknown source)';
        }
      } else {
        message = error?.message || 'Unknown error';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Download failed: ${message}`,
              url,
            }),
          },
        ],
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      if (runAbortSignal && runAbortListener) {
        runAbortSignal.removeEventListener('abort', runAbortListener);
      }
    }
  },
};

export default downloadFileTool;
module.exports = downloadFileTool;
