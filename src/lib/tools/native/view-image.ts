/**
 * View Image — Native FS Tool
 *
 * Lets a model SEE an image: a screenshot in the workspace, or an attachment
 * URL (a redBoard card image). Returns an MCP image block the model's vision
 * consumes, plus a small text block of facts:
 *
 *   { content: [ { type:'image', data, mimeType }, { type:'text', text } ] }
 *
 * Why a tool and not read_file: read_file returns UTF-8 text, so a PNG reached
 * the model as mojibake and card agents "read" screenshots they never saw
 * (2026-10-14, card 6acfa3feeabd988f96d40f83).
 *
 * How the pixels reach each kind of model:
 *   - API neurons: neuronExecutor turns tool-result image blocks into a vision
 *     `user` turn (formatToolResultForModel, engine 0.0.300).
 *   - CLI neurons: the run bridge passes the MCP result through unchanged;
 *     for a CLI that drops MCP image blocks the bridge swaps the image for a
 *     vision-model description (StartRunToolBridgeOptions.toolImages).
 *   - `describe: true` asks for that description explicitly, alongside the image.
 *
 * Authority: `exec:execute` on the environment, like read_file. A `url` is
 * downloaded INSIDE the environment with curl (the same thing the agent could
 * do with run_command), so the tool never fetches anything from the engine
 * host and needs no web grant.
 *
 * Images are downscaled to `maxDimension` (default 1568 px, long side) and a
 * ~2.5 MB budget so every provider accepts them (lib/media/image-prep).
 */

import * as path from 'path';
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';
import { resolveRunUserIdOrEmpty } from './_run-identity';
import {
  prepareImageForModel,
  ImagePrepError,
  DEFAULT_MAX_DIMENSION,
  MIN_MAX_DIMENSION,
  MAX_MAX_DIMENSION,
} from '../../media/image-prep';
import { describeImageWithGemini, type DescribeImageFn } from '../../media/describe-image';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_S = 60;
const DOWNLOAD_DIR = '/tmp/view-image';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function toolError(code: string, message: string, extra?: AnyObject): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code, isError: true, ...extra }) }],
    isError: true,
  };
}

/** A filename for a downloaded URL: its last path segment, sanitised, never empty. */
export function downloadNameFor(url: string): string {
  let base = 'image';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'image');
  } catch {
    /* keep default */
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'image';
  return `${Date.now().toString(36)}-${base}`;
}

/** Overridable for tests. */
export const viewImageDeps: { describe: DescribeImageFn } = { describe: describeImageWithGemini };

const viewImageTool: NativeToolDefinition = {
  description:
    'LOOK at an image: returns the picture itself so you can see it (screenshots, UI mockups, photos, diagrams). ' +
    'Use it for every image you need to understand, including card attachments: pass `url` to fetch an attachment ' +
    '(downloaded inside the environment) or `path` for an image file already in the environment. PNG, JPEG, GIF and WebP; ' +
    'large images are downscaled to fit. read_file cannot show you an image (it returns the bytes as text). ' +
    'Set describe=true to also get a written transcription of all visible text and details.',
  server: 'fs',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'ID of the managed Environment. Normally supplied for you.',
      },
      path: {
        type: 'string',
        description: 'Image file in the environment. Relative paths resolve against the working directory (/workspace).',
      },
      url: {
        type: 'string',
        description: 'http(s) URL of an image (e.g. a card attachment link). Downloaded inside the environment, then shown.',
      },
      maxDimension: {
        type: 'integer',
        description: `Longest side in pixels after downscaling. Default ${DEFAULT_MAX_DIMENSION}; raise it (max ${MAX_MAX_DIMENSION}) only to read very small text.`,
        minimum: MIN_MAX_DIMENSION,
        maximum: MAX_MAX_DIMENSION,
      },
      describe: {
        type: 'boolean',
        description: 'Also return a written description (all visible text verbatim, layout, colours) from a vision model.',
      },
    },
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs || {};
    const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
    const hasUrl = typeof args.url === 'string' && args.url.trim() !== '';
    if (hasPath === hasUrl) return toolError('VALIDATION', 'pass exactly one of `path` or `url`');
    if (hasUrl && !/^https?:\/\//i.test(args.url.trim())) {
      return toolError('VALIDATION', '`url` must be an http(s) URL');
    }
    let maxDimension = DEFAULT_MAX_DIMENSION;
    if (args.maxDimension !== undefined) {
      const m = Number(args.maxDimension);
      if (!Number.isFinite(m)) return toolError('VALIDATION', 'maxDimension must be a number');
      maxDimension = Math.min(MAX_MAX_DIMENSION, Math.max(MIN_MAX_DIMENSION, Math.floor(m)));
    }

    const environmentId: string =
      (typeof args.environmentId === 'string' && args.environmentId) ||
      context?.state?.data?.environmentId ||
      context?.state?.parameters?.environmentId ||
      '';
    if (!environmentId) {
      return toolError('VALIDATION', 'no environment: view_image needs the environment the image lives in (environmentId)');
    }
    const userId = resolveRunUserIdOrEmpty(context);
    if (!userId) return toolError('NO_USER', 'view_image requires a userId in graph state (called outside a run?)');

    let env: AnyObject, sshKey: AnyObject;
    try {
      const resolved = await loadAndResolveEnvironment(environmentId, userId);
      env = resolved.env as AnyObject;
      sshKey = resolved.sshKey as unknown as AnyObject;
    } catch (err) {
      const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
      return toolError(code, err instanceof Error ? err.message : String(err), { environmentId });
    }
    let session: AnyObject;
    try {
      session = await environmentManager.acquire(env as never, sshKey as never, userId);
    } catch (err) {
      return toolError('ENV_ACQUIRE_FAILED', `Failed to acquire environment session: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Locate the bytes ────────────────────────────────────────────────────
    let filePath: string;
    let source: string;
    if (hasUrl) {
      const url = args.url.trim();
      filePath = `${DOWNLOAD_DIR}/${downloadNameFor(url)}`;
      source = url;
      const cmd =
        `mkdir -p ${DOWNLOAD_DIR} && ` +
        `curl -fsSL --max-time ${DOWNLOAD_TIMEOUT_S} --max-filesize ${MAX_DOWNLOAD_BYTES} -o ${shellQuote(filePath)} ${shellQuote(url)}`;
      try {
        const r = await session.exec(cmd, {
          timeout: (DOWNLOAD_TIMEOUT_S + 15) * 1000,
          abortSignal: context?.abortSignal ?? undefined,
        });
        if (r.exitCode !== 0) {
          const why = String(r.stderr || r.stdout || '').trim().slice(-400);
          return toolError('DOWNLOAD_FAILED', `could not download the image (curl exit ${r.exitCode}): ${why || 'no output'}. Signed attachment links expire after 24 h.`, { url });
        }
      } catch (err) {
        return toolError('DOWNLOAD_FAILED', `could not download the image: ${err instanceof Error ? err.message : String(err)}`, { url });
      }
    } else {
      const p = args.path.trim();
      const base = (typeof env?.workingDir === 'string' && env.workingDir) || '/workspace';
      filePath = path.posix.isAbsolute(p) ? p : path.posix.join(base, p);
      source = filePath;
    }

    let buf: Buffer;
    try {
      const st = await session.sftpStat(filePath);
      if (st && typeof st.size === 'number' && st.size > MAX_DOWNLOAD_BYTES) {
        return toolError('TOO_LARGE', `${filePath} is ${st.size} bytes; the limit is ${MAX_DOWNLOAD_BYTES}`);
      }
      buf = await session.sftpRead(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(/ENOENT|No such file/i.test(msg) ? 'NOT_FOUND' : 'SFTP_READ_FAILED', `Failed to read ${filePath}: ${msg}`);
    }

    let img;
    try {
      img = prepareImageForModel(buf, { maxDimension });
    } catch (err) {
      if (err instanceof ImagePrepError) return toolError(err.code, `${source}: ${err.message}`);
      return toolError('IMAGE_FAILED', `${source}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const facts: AnyObject = {
      source,
      ...(hasUrl ? { savedTo: filePath } : {}),
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
      ...(img.resized
        ? { resizedFrom: { width: img.originalWidth, height: img.originalHeight, bytes: img.originalBytes, mimeType: img.originalMimeType } }
        : {}),
      note: 'The image is attached to this result. Look at it.',
    };

    const content: AnyObject[] = [{ type: 'image', data: img.data, mimeType: img.mimeType }];
    if (args.describe === true) {
      try {
        facts.description = await viewImageDeps.describe({ data: img.data, mimeType: img.mimeType });
      } catch (err) {
        facts.descriptionError = err instanceof Error ? err.message : String(err);
      }
    }
    content.push({ type: 'text', text: JSON.stringify(facts) });
    return { content } as NativeMcpResult;
  },
};

export default viewImageTool;
module.exports = viewImageTool;
