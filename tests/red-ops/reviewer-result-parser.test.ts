import { describe, expect, it } from 'vitest';

type Verdict = {
  verdict?: string;
  merged?: boolean;
  promoted?: boolean;
  deployed?: boolean;
  reason?: string;
  needsGeorge?: boolean;
  reviewOnly?: boolean;
  prUrl?: string;
  runId?: string;
  [key: string]: unknown;
};

function scrub(s: string): string {
  return String(s ?? '')
    .split('')
    .filter((c) => {
      const n = c.charCodeAt(0);
      return !((n <= 8) || (n >= 11 && n <= 31) || n === 127);
    })
    .join('')
    .trim();
}

function parseVerdictText(s: unknown): Verdict | null {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;

  try {
    const p = JSON.parse(t) as Verdict;
    if (p && typeof p === 'object' && typeof p.verdict === 'string') return p;
  } catch {
    // ignored
  }

  const blockRegex = /```(?:json|JSON)?\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(t)) !== null) {
    const body = String(match[1] ?? '').trim();
    try {
      const p = JSON.parse(body) as Verdict;
      if (p && typeof p === 'object' && typeof p.verdict === 'string') return p;
    } catch {
      // ignored
    }
  }

  for (const line of t.split(String.fromCharCode(10))) {
    try {
      const p = JSON.parse(line) as Verdict;
      if (p && typeof p === 'object' && typeof p.verdict === 'string') return p;
    } catch {
      // ignored
    }
  }

  return null;
}

function collectVerdicts(sources: unknown[]): Verdict[] {
  const out: Verdict[] = [];
  for (const source of sources) {
    if (!source) continue;

    if (typeof source === 'string') {
      const p = parseVerdictText(source);
      if (p) out.push(p);
      continue;
    }

    if (Array.isArray(source)) {
      out.push(...collectVerdicts(source));
      continue;
    }

    if (typeof source === 'object') {
      const obj = source as Record<string, unknown>;
      const maybe = [obj.text, obj.content, obj.stdout, obj.stderr];
      out.push(...collectVerdicts(maybe.filter((x) => x !== undefined)));
    }
  }
  return out;
}

function extractResult(cliResult: unknown, finalText: unknown, baseline: Verdict = {}): Verdict {
  const verdictSources: unknown[] = [];
  if (cliResult) verdictSources.push(cliResult);
  if (finalText) verdictSources.push(finalText);

  const base = baseline;
  const result: Verdict = {
    verdict: 'unknown',
    merged: false,
    promoted: false,
    deployed: false,
    prUrl: '',
    reason: '',
    needsGeorge: false,
    ...base,
  };

  const candidates = collectVerdicts(verdictSources);
  const last = candidates[candidates.length - 1] ?? null;
  if (last) {
    Object.assign(result, last);
  }

  if (typeof result.reason !== 'string' || !result.reason) {
    result.reason = scrub(String(finalText || '')).slice(-400);
  }
  if ((result.reason || '').length > 400) result.reason = result.reason!.slice(-400);
  if (typeof result.needsGeorge !== 'boolean') result.needsGeorge = false;
  if (typeof result.verdict !== 'string') result.verdict = 'unknown';

  return result;
}

function applyMergeGuard(result: Verdict, mergeGuardStatus: string): Verdict {
  const out = { ...result };
  if (out.reviewOnly === true) return out;

  const status = String(mergeGuardStatus || 'ERROR');
  if (status === 'MERGED') {
    out.merged = true;
    if (out.verdict !== 'promoted' && out.verdict !== 'deployed') out.verdict = 'merged';
    out.needsGeorge = false;
    return out;
  }

  if (status === 'MERGE_NOT_CONFIRMED' || status === 'VERIFICATION_PENDING') {
    out.verdict = 'merged-verify-pending';
    out.merged = false;
    out.reason = out.reason || 'Verification incomplete after merge attempt.';
    return out;
  }

  out.verdict = 'blocked';
  out.merged = false;
  out.promoted = false;
  out.deployed = false;
  out.reason = `AUTO-MERGE guard blocked: ${status}`;
  out.needsGeorge = status === 'NOT_OPEN' || status === 'ERROR';
  return out;
}

describe('reviewer parser hardening', () => {
  it('uses the latest in-run verdict JSON when the final message lacks one (false-negative)', () => {
    const cliResult = {
      content: [{
        text:
          'some chatter\n' +
          '{"verdict":"merged-verify-pending","merged":false,"promoted":false,"deployed":false,"reason":"deploy still running"}\n',
      }],
    } as const;

    const finalText = 'Review complete; awaiting background deploy completion ...';

    const result = extractResult(cliResult, finalText, {
      verdict: 'unknown',
      merged: false,
      promoted: false,
      deployed: false,
      reason: '',
      prUrl: 'https://github.com/redbtn-io/redbtn/pull/1',
    });

    expect(result.verdict).toBe('merged-verify-pending');
    expect(result.reason).toBe('deploy still running');
  });

  it('classifies a real failure path as blocked when no in-run verdict confirms merge', () => {
    const cliResult = {
      content: [{ text: 'CI gate failed\nNo JSON payload here\n' }],
    } as const;

    const result = extractResult(cliResult, 'Review ended with a narrative summary only.', {
      verdict: 'unknown',
      merged: false,
      promoted: false,
      deployed: false,
      reason: '',
      prUrl: 'https://github.com/redbtn-io/redbtn/pull/2',
    });

    const final = applyMergeGuard(result, 'REVIEW_NOT_APPROVED');

    expect(final.verdict).toBe('blocked');
    expect(final.merged).toBe(false);
    expect(final.needsGeorge).toBe(true);
    expect(final.reason).toMatch(/REVIEW_NOT_APPROVED/);
  });

  it('never returns blocked when merge is already true in guard status', () => {
    const result = applyMergeGuard({ verdict: 'unknown', merged: false, reason: 'stale model output' }, 'MERGED');
    expect(result.verdict).toBe('merged');
    expect(result.merged).toBe(true);
    expect(result.needsGeorge).toBe(false);
  });
});
