/**
 * @deprecated respond() was removed in v0.0.51-alpha.
 *
 * Migrate to run() from '@redbtn/redbtn':
 *
 *   import { run, isStreamingResult } from '@redbtn/redbtn';
 *
 *   const result = await run(red, { message: query.message }, {
 *     userId,
 *     conversationId,
 *     stream: true,
 *   });
 *
 *   if (isStreamingResult(result)) {
 *     const final = await result.completion;
 *   }
 *
 * The run() function uses RunPublisher for SSE event streaming and handles
 * all graph execution via the JIT compiler (MongoDB-backed graph configs).
 * Message storage, tool events, and conversation management are handled by
 * the caller (e.g. webapp graph processor + worker).
 *
 * @module functions/respond
 */

export function respond(): never {
  throw new Error(
    '[redbtn] Red.respond() was removed in v0.0.51-alpha. ' +
    'Migrate to run() — see src/functions/respond.ts for migration guide.'
  );
}
