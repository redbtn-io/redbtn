/**
 * Internal access-control helper shared by the conversation-memory native
 * tools (`store_message`, `get_context_history`) that call `MemoryManager`
 * directly against `user_conversations` instead of proxying through the
 * webapp REST API.
 *
 * Sibling tools like `get_messages` / `add_participant` get their ownership
 * check "for free" from the webapp route they proxy to. These two skip that
 * route entirely for latency (in-process, no HTTP hop), which also means
 * they skip the ownership check — any caller who can reach the tool could
 * read or write any conversation by ID, not just its own. This mirrors the
 * `resolveRole` access model used by get-recent-runs.ts, applied to the
 * `user_conversations` collection's `{ userId, participants[] }` shape.
 *
 * Filename is prefixed with `_` — see _task-helpers.ts for the convention.
 */

import mongoose from 'mongoose';
import type { NativeToolContext } from '../native-registry';
import { isSystemResource } from '../../system-resource';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export type ConversationRole = 'owner' | 'member' | 'viewer';

export interface ConversationAccessResult {
  ok: boolean;
  role: ConversationRole | null;
  error: string | null;
}

/**
 * Resolve the caller's trusted user id. Prefers `context.publisher.user`
 * (set server-side from the authenticated run) over the mutable
 * `state.userId` / `state.data.userId`, which a malicious/compromised
 * graph could otherwise set to impersonate another user. Same precedence
 * as get-recent-runs.ts.
 */
export function resolveCallerUserId(context: NativeToolContext): string | null {
  const publisherUserId =
    typeof (context?.publisher as AnyObject | undefined)?.user === 'string'
      ? ((context?.publisher as AnyObject).user as string).trim()
      : '';
  const stateUserId =
    typeof context?.state?.userId === 'string' ? context.state.userId.trim() : '';
  const stateDataUserId =
    typeof context?.state?.data?.userId === 'string' ? context.state.data.userId.trim() : '';
  return publisherUserId || stateUserId || stateDataUserId || null;
}

/**
 * Build a MongoDB filter to match the conversation document in
 * `user_conversations`. Mirrors MemoryManager.buildConversationFilter.
 */
function buildConversationFilter(conversationId: string): AnyObject {
  const { ObjectId } = mongoose.Types;
  return ObjectId.isValid(conversationId)
    ? { _id: new ObjectId(conversationId) }
    : { conversationId };
}

/**
 * Resolve the caller's role on a conversation document:
 *   1. participants[].userId === userId → that role
 *   2. doc.userId === userId            → owner
 *   3. doc is system-owned              → viewer
 *   4. otherwise → null (forbidden)
 */
function resolveRole(doc: AnyObject, userId: string): ConversationRole | null {
  const participants = doc?.participants as Array<{ userId: string; role: string }> | undefined;
  if (Array.isArray(participants) && participants.length > 0) {
    const p = participants.find((x) => x?.userId === userId);
    if (p?.role === 'owner' || p?.role === 'member' || p?.role === 'viewer') {
      return p.role;
    }
  }
  if (doc?.userId && String(doc.userId) === userId) {
    return 'owner';
  }
  if (isSystemResource(doc)) {
    return 'viewer';
  }
  return null;
}

/**
 * Verify the caller may access `conversationId` at the given role level.
 * Fails closed: no Mongo connection, no matching document, or no
 * resolvable role are all denied.
 *
 * @param allowRoles Roles that satisfy the check. Defaults to any role
 *   (read access). Pass `['owner', 'member']` for write operations —
 *   `viewer` mirrors add-participant.ts's "viewer can only read" semantics.
 */
export async function checkConversationAccess(
  conversationId: string,
  callerUserId: string,
  opts: { allowRoles?: ConversationRole[] } = {},
): Promise<ConversationAccessResult> {
  const allowRoles = opts.allowRoles ?? ['owner', 'member', 'viewer'];

  const db = mongoose.connection.db;
  if (!db) {
    return { ok: false, role: null, error: 'MongoDB connection not available' };
  }

  const filter = buildConversationFilter(conversationId);
  const doc = await db.collection('user_conversations').findOne(filter, {
    projection: { userId: 1, participants: 1, isSystem: 1 },
  });

  if (!doc) {
    return { ok: false, role: null, error: `Conversation not found: ${conversationId}` };
  }

  const role = resolveRole(doc, callerUserId);
  if (!role || !allowRoles.includes(role)) {
    return {
      ok: false,
      role: role ?? null,
      error: `Forbidden: caller does not have access to conversation ${conversationId}`,
    };
  }

  return { ok: true, role, error: null };
}
