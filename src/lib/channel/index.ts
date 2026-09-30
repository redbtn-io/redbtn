/**
 * Release channel namespacing for shared Redis.
 *
 * prod and beta run separate webapps + workers against separate Mongo
 * databases but ONE Redis. Every Redis key / channel / stream whose meaning is
 * tied to a channel's database (billing stream + dedupe, daily cron locks,
 * state-trigger bus, archive queues, automation concurrency, env job indexes,
 * redlog) goes through `channelKey()` so the two channels never see each
 * other's traffic.
 *
 * `REDBTN_CHANNEL` unset (or `prod`) returns every key UNCHANGED — prod key
 * names are exactly what they were before this helper existed. Any other value
 * prefixes keys with `<channel>:` (e.g. `beta:usage:events`).
 *
 * Keep in sync with the copies in redbtn-io/redworker `src/lib/channel.ts` and
 * redbtn-io/webapp `src/lib/channel.ts` (same env var, same semantics).
 */

export const DEFAULT_REDBTN_CHANNEL = 'prod';

const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The configured release channel (`prod` when `REDBTN_CHANNEL` is unset/blank). */
export function redbtnChannel(): string {
  const raw = (process.env.REDBTN_CHANNEL ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_REDBTN_CHANNEL;
  if (!CHANNEL_RE.test(raw)) {
    throw new Error(
      `REDBTN_CHANNEL must match ${CHANNEL_RE} (got ${JSON.stringify(process.env.REDBTN_CHANNEL)})`,
    );
  }
  return raw;
}

/** True for the default (prod) channel, whose keys are never prefixed. */
export function isDefaultRedbtnChannel(): boolean {
  return redbtnChannel() === DEFAULT_REDBTN_CHANNEL;
}

/** Namespace a Redis key / pub-sub channel / stream name for this channel. */
export function channelKey(key: string): string {
  const channel = redbtnChannel();
  return channel === DEFAULT_REDBTN_CHANNEL ? key : `${channel}:${key}`;
}

/**
 * BullMQ prefix for this channel's OWN queues (run/conversation/stream
 * archive). An explicit `BULLMQ_PREFIX` wins (the beta webapp already sets it);
 * otherwise prod keeps BullMQ's default `bull` and any other channel uses its
 * channel name — so a beta worker with only `REDBTN_CHANNEL=beta` produces to
 * the same `beta:*-archive` queues the beta webapp consumes.
 */
export function bullmqPrefix(): string {
  const explicit = (process.env.BULLMQ_PREFIX ?? '').trim();
  if (explicit) return explicit;
  const channel = redbtnChannel();
  return channel === DEFAULT_REDBTN_CHANNEL ? 'bull' : channel;
}
