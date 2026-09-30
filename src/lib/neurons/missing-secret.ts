/**
 * Name the real cause when a model call is rejected for want of a key.
 *
 * A neuron that names a vault secret (`secretName`) resolves it under the
 * CALLER's user id (system neurons) or the owner's (private ones). When the
 * lookup misses, `NeuronRegistry.getConfig` leaves `apiKey` undefined and the
 * provider client is built without credentials. LangChain then surfaces the
 * provider's bare rejection ("401 Missing Authentication header", "Incorrect
 * API key provided"), which says nothing about which secret is missing or
 * whose vault it is missing from. A local hub with two admin identities hit
 * exactly this: the OpenRouter key was vaulted for one user and the CLI was
 * signed in as the other.
 *
 * `missingSecretMessage` only rewrites an error that (a) looks like a provider
 * auth rejection and (b) came from a neuron whose `secretName` did not
 * resolve. Everything else passes through untouched, so no working
 * configuration changes behaviour.
 */
import type { NeuronConfig } from '../types/neuron';

/** HTTP status on a provider SDK error, when it carries one. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  const raw = e?.status ?? e?.statusCode ?? e?.response?.status;
  return typeof raw === 'number' ? raw : undefined;
}

/** The error plus its `.cause` chain (bounded), so wrapped errors still match. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 5; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

const AUTH_TEXT =
  /\b401\b|\b403\b|missing authentication|unauthori[sz]ed|incorrect api key|invalid[ _-]?(api[ _-]?)?key|no api key|api key (is )?(missing|required|not (set|provided))|MODEL_AUTHENTICATION|authentication(_error| failed)/i;

/** True when the error (or anything in its cause chain) is a provider auth rejection. */
export function looksLikeProviderAuthError(err: unknown): boolean {
  for (const e of chain(err)) {
    const s = statusOf(e);
    if (s === 401 || s === 403) return true;
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    if (msg && AUTH_TEXT.test(msg)) return true;
  }
  return false;
}

/**
 * The replacement message, or null when this error is not a missing-secret
 * failure. `cfg` is the neuron config the call ran with.
 */
export function missingSecretMessage(
  err: unknown,
  cfg: Pick<NeuronConfig, 'id' | 'secretName' | 'apiKey' | 'provider'> | null | undefined,
  userId?: string,
): string | null {
  if (!cfg || !cfg.secretName) return null;
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) return null;
  if (!looksLikeProviderAuthError(err)) return null;
  const who = userId ? ` (user ${userId})` : '';
  return (
    `secret '${cfg.secretName}' is not set for this account${who}. Neuron '${cfg.id}' ` +
    `(${cfg.provider}) uses it as its API key, so the provider rejected the call. ` +
    `Add ${cfg.secretName} to this account's secrets (Settings -> Secrets, or POST /api/secrets) ` +
    `and try again.`
  );
}
