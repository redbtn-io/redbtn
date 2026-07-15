/**
 * Red Ops Reviewer node — result parser + merge-guard behaviour.
 *
 * # What's under test
 *
 * `ops/red-ops/red-ops-reviewer.node.json` is the config deployed to the LIVE
 * `red-ops-reviewer` MCP node — the INDEPENDENT last gate before prod. It reviews
 * a PR, runs CI, squash-merges, promotes beta->main, verifies the deploy, and
 * flags @george on failure.
 *
 * The node is entirely `{{...}}` templates, so its logic lives in strings and
 * cannot be type-checked. These tests drive the ACTUAL committed step
 * expressions through the engine's OWN evaluator (`resolveValue`) — so they
 * validate the SHIPPING logic, not a hand-written copy. (The earlier version of
 * this file re-implemented the parser inline; that copy could pass while the real
 * reviewer drifted. This one loads the real JSON.) The live MCP node embeds the
 * same JS as template strings in Mongo; the JSON here is the source of truth and
 * the two are kept in sync — see `ops/red-ops/README.md`.
 *
 * Two load-bearing contracts:
 *
 *  1. FALSE-NEGATIVE GUARD — the result parser (step `data.result`) must prefer
 *     the LAST in-run verdict JSON over a narrative final message, so a run that
 *     verifiably merged is not mis-reported because the closing prose lacked a
 *     JSON block.
 *
 *  2. NO REASON-OVERWRITE (George, 2026-07-15) — when the merge guard blocks a
 *     real failure it must PRESERVE the model's own `reason` verbatim and record
 *     its own decision in SEPARATE fields (`guardVerdict` / `guardReason`), never
 *     masking the actionable reason (e.g. "promotion PR conflicting") with a
 *     generic guard label. And any AUTO-MERGE block that is not a clean
 *     merged/pending state must flag @george.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const NODE = JSON.parse(
  readFileSync(resolve(__dirname, '../../ops/red-ops/red-ops-reviewer.node.json'), 'utf8'),
);
const STEPS: Any[] = NODE.config.steps;
const PARAM_DEFAULTS: Record<string, Any> = Object.fromEntries(
  Object.entries(NODE.config.parameters as Record<string, Any>).map(([k, v]) => [k, (v as Any).default]),
);

// Steps are located by their outputField, not a hard-coded index, so a reorder of
// the node's step array does not silently retarget a test at the wrong step.
const transformsWriting = (field: string): Any[] =>
  STEPS.filter((s) => s.type === 'transform' && s.config?.outputField === field);
const only = (field: string): Any => {
  const hits = transformsWriting(field);
  if (hits.length !== 1) throw new Error(`expected exactly one transform writing ${field}, got ${hits.length}`);
  return hits[0];
};

// `data.result` is written three times: the parser, then the merge guard, then
// the branch-protection guard (which self-heals a permanent branch a promote
// merge would otherwise have deleted).
const RESULT_WRITERS = transformsWriting('data.result');
if (RESULT_WRITERS.length !== 3) {
  throw new Error(
    `expected 3 data.result writers (parse + merge-guard + branch-guard), got ${RESULT_WRITERS.length}`,
  );
}
const PARSE_STEP = RESULT_WRITERS[0];
const GUARD_STEP = RESULT_WRITERS[1];
const BETA_FOLD_STEP = RESULT_WRITERS[2];
const MERGE_GUARD_CMD_STEP = only('data.mergeGuardCommand');
const BETA_GUARD_CMD_STEP = only('data.betaGuardCommand');
const PROMPT_STEP = only('data.cliPrompt');
const RESPONSE_STEP = only('data.response');

function setPath(state: Any, path: string, value: Any): void {
  const parts = path.split('.');
  let cur = state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Run one `set` transform exactly as the transform executor does (throwOnError). */
function evalSet(step: Any, state: Any): void {
  setPath(state, step.config.outputField, resolveValue(step.config.value, state, { throwOnError: true }));
}

function baseState(rev: Any): Any {
  return {
    data: { rev, runId: 'run_test_reviewer', result: undefined },
    parameters: PARAM_DEFAULTS,
  };
}

const PR = 'https://github.com/redbtn-io/redbtn/pull/9';

/** Drive the real parser step over a CLI result + final message. */
function parse(cliResult: Any, finalText: string, rev: Any): Any {
  const state = baseState(rev);
  state.data.cliResult = cliResult;
  state.data.finalText = finalText;
  evalSet(PARSE_STEP, state);
  return state.data.result;
}

/** Drive the real merge-guard step over an already-parsed result + a guard status. */
function guard(result: Any, status: string, rev: Any = { prUrl: PR, reviewOnly: false }): Any {
  const state = baseState(rev);
  // The parser (step `data.result`) always hands the guard a boolean needsGeorge
  // (`if (typeof r.needsGeorge !== 'boolean') r.needsGeorge = false`). Mirror that
  // contract so a guard path that intentionally leaves the flag alone reads as
  // false, not undefined.
  if (typeof result.needsGeorge !== 'boolean') result.needsGeorge = false;
  state.data.result = result;
  state.data.finalText = String(result.reason || '');
  // The guard step decodes either the {content:[{text}]} envelope or a decoded
  // {stdout} object — mirror the decoded form the tool executor writes.
  state.data.mergeGuard = { stdout: `MERGE_GUARD:${status}` };
  evalSet(GUARD_STEP, state);
  return state.data.result;
}

/** Render the real CLI prompt (step `data.cliPrompt`) for a given input. */
function promptFor(rev: Any): string {
  const state = baseState(rev);
  evalSet(PROMPT_STEP, state);
  return String(state.data.cliPrompt);
}

/** Render the real branch-guard command (step `data.betaGuardCommand`). */
function betaCmd(rev: Any, result: Any): string {
  const state = baseState(rev);
  state.data.result = result;
  evalSet(BETA_GUARD_CMD_STEP, state);
  return String(state.data.betaGuardCommand);
}

/** Drive the real branch-guard fold (step 3 of `data.result`) over a guard line. */
function betaFold(result: Any, stdout: string, rev: Any = { prUrl: PR, repo: 'redbtn-io/redrun', reviewOnly: false }): Any {
  const state = baseState(rev);
  if (typeof result.needsGeorge !== 'boolean') result.needsGeorge = false;
  state.data.result = result;
  state.data.betaGuard = { stdout };
  evalSet(BETA_FOLD_STEP, state);
  return state.data.result;
}

describe('red-ops-reviewer — result parser (false-negative guard)', () => {
  it('uses the latest in-run verdict JSON when the final message lacks one', () => {
    const cliResult = {
      content: [{
        text:
          'some chatter\n' +
          '{"verdict":"merged-verify-pending","merged":false,"promoted":false,"deployed":false,"reason":"deploy still running"}\n',
      }],
    };
    const result = parse(cliResult, 'Review complete; awaiting background deploy completion ...', {
      prUrl: 'https://github.com/redbtn-io/redbtn/pull/1',
      reviewOnly: false,
    });

    expect(result.verdict).toBe('merged-verify-pending');
    expect(result.reason).toBe('deploy still running');
  });

  it('falls back to the scrubbed narrative when no verdict JSON was emitted', () => {
    const result = parse(
      { content: [{ text: 'CI gate failed\nNo JSON payload here\n' }] },
      'Review ended with a narrative summary only.',
      { prUrl: PR, reviewOnly: false },
    );

    expect(result.verdict).toBe('unknown');
    expect(result.reason).toBe('Review ended with a narrative summary only.');
  });
});

describe('red-ops-reviewer — merge guard preserves the model reason (no overwrite)', () => {
  it('classifies a real failure path as blocked and flags @george when no in-run verdict confirms merge', () => {
    // Narrative-only run, PR still OPEN — the exact "real failure path" case.
    const parsed = parse(
      { content: [{ text: 'CI gate failed\nNo JSON payload here\n' }] },
      'Review ended with a narrative summary only.',
      { prUrl: PR, reviewOnly: false },
    );
    const final = guard(parsed, 'OPEN');

    expect(final.verdict).toBe('blocked');
    expect(final.merged).toBe(false);
    expect(final.needsGeorge).toBe(true);
    // The guard's own signal lives in separate fields...
    expect(final.guardVerdict).toBe('model-not-approved');
    expect(final.guardReason).toMatch(/no in-run verdict/i);
    // ...and it did NOT overwrite the model's reason with a generic guard label.
    expect(final.reason).toBe('Review ended with a narrative summary only.');
  });

  it("keeps the model's actionable reason verbatim while a legitimate block occurs (George's refinement)", () => {
    // The model DID end with a verdict JSON — a real, actionable blocked reason.
    const parsed = parse(
      {
        content: [{
          text:
            'Promotion could not proceed.\n' +
            '```json\n{"verdict":"blocked","merged":false,"reason":"promotion PR conflicting"}\n```\n',
        }],
      },
      'Blocked: the promotion PR has conflicts against main.',
      { prUrl: PR, reviewOnly: false },
    );
    expect(parsed.reason).toBe('promotion PR conflicting');

    const final = guard(parsed, 'OPEN');

    // reason is the MODEL's, untouched — the coordinator/board see the actionable
    // reason, not the generic guard label. This is the whole point of the fix.
    expect(final.reason).toBe('promotion PR conflicting');
    expect(final.modelVerdict).toBe('blocked');
    // guard signal is a SEPARATE field, never smashed into reason.
    expect(final.guardReason).not.toBe(final.reason);
    expect(final.guardReason).toBeTruthy();
    expect(final.verdict).toBe('blocked');
    expect(final.needsGeorge).toBe(true);
  });

  it('marks a PR that closed without merging as blocked + needs-george, reason intact', () => {
    const final = guard({ verdict: 'approved', reason: 'approved after review', needsGeorge: false }, 'NOT_OPEN');

    expect(final.verdict).toBe('blocked');
    expect(final.merged).toBe(false);
    expect(final.needsGeorge).toBe(true);
    expect(final.guardVerdict).toBe('closed-unmerged');
    expect(final.reason).toBe('approved after review');
  });
});

describe('red-ops-reviewer — merge guard clean paths', () => {
  it('confirms a merge and does not flag george when GitHub shows MERGED', () => {
    const final = guard({ verdict: 'unknown', merged: false, reason: 'model said stale' }, 'MERGED');

    expect(final.verdict).toBe('merged');
    expect(final.merged).toBe(true);
    expect(final.needsGeorge).toBe(false);
    expect(final.guardVerdict).toBe('merged');
    expect(final.reason).toBe('model said stale'); // still not overwritten
  });

  it('downgrades a merge the model claimed but GitHub still shows OPEN to verify-pending (no george ping)', () => {
    const final = guard({ verdict: 'merged', merged: true, reason: 'I squash-merged it' }, 'OPEN');

    expect(final.verdict).toBe('merged-verify-pending');
    expect(final.merged).toBe(false);
    expect(final.needsGeorge).toBe(false);
    expect(final.guardVerdict).toBe('merge-not-confirmed');
    expect(final.reason).toBe('I squash-merged it');
  });

  it('leaves a review-only run untouched (guard not applied)', () => {
    const final = guard(
      { verdict: 'approved', reason: 'ready to merge', reviewOnly: true, needsGeorge: false },
      'OPEN',
      { prUrl: PR, reviewOnly: true },
    );

    expect(final.verdict).toBe('approved');
    expect(final.needsGeorge).toBe(false);
    expect(final.guardVerdict).toBe('review-only');
  });
});

// Regression for the 2026-07-15 incident: red-by-redbtn[bot] deleted refs/heads/beta
// twice while merging promote (beta->main) PRs, because the AUTO-MERGE instruction
// ran `gh pr merge <pr> --squash --delete-branch` unconditionally — and a promote
// PR's HEAD ref IS `beta`. Promotion must never delete the base branch it merged from.
describe('red-ops-reviewer — promotion never deletes the base branch (prompt guard)', () => {
  const REPO = 'redbtn-io/redrun';

  it('AUTO-MERGE prompt forbids --delete-branch on permanent branches', () => {
    const p = promptFor({ prUrl: PR, repo: REPO, base: 'main', reviewOnly: false });
    expect(p).toContain('NEVER pass --delete-branch when the head ref is a PERMANENT branch');
    expect(p).toMatch(/beta, main, master, prod/);
    expect(p).toContain('Promotion must NEVER delete the base branch it just merged from');
    // The permanent-head merge uses the no-delete form of the command.
    expect(p).toContain('--squash --match-head-commit <headRefOid>');
    // The promote sub-step is explicitly called out as head=beta, merged WITHOUT delete.
    expect(p).toContain('promote beta->main (its head IS beta, so merge it WITHOUT --delete-branch)');
    // headRefName is captured so the agent can tell whether the head is permanent.
    expect(p).toContain('--json headRefName,headRefOid,baseRefName');
  });

  it('REVIEW-ONLY prompt never merges or deletes anything', () => {
    const p = promptFor({ prUrl: PR, repo: REPO, base: 'beta', reviewOnly: true });
    expect(p).toContain('REVIEW-ONLY: do NOT merge/promote/deploy');
    expect(p).not.toContain('--delete-branch');
  });
});

describe('red-ops-reviewer — branch-protection guard command', () => {
  const REPO = 'redbtn-io/redrun';

  it('is a no-op on a review-only run', () => {
    expect(betaCmd({ prUrl: PR, repo: REPO, reviewOnly: true }, { merged: false }))
      .toBe('echo BETA_GUARD:REVIEW_ONLY');
  });

  it('is a no-op when nothing merged', () => {
    expect(betaCmd({ prUrl: PR, repo: REPO, reviewOnly: false }, { merged: false }))
      .toBe('echo BETA_GUARD:NOT_MERGED');
  });

  it('recreates a missing permanent head branch from the base tip, and NEVER deletes', () => {
    const cmd = betaCmd({ prUrl: PR, repo: REPO, reviewOnly: false }, { merged: true });
    // Only permanent heads are eligible for recreation.
    expect(cmd).toContain('case "$H" in beta|main|master|prod)');
    expect(cmd).toContain('HEAD_NOT_PERMANENT');
    // Present branch → confirmed, no mutation.
    expect(cmd).toContain('BETA_GUARD:PRESENT');
    // Missing branch → recreate at the base branch tip via a create-ref (idempotent).
    expect(cmd).toContain('gh api "repos/$REPO/branches/$B"');
    expect(cmd).toContain('gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$H"');
    expect(cmd).toContain('BETA_GUARD:RECREATED');
    // Hard invariant: the guard must never delete a ref.
    expect(cmd).not.toMatch(/--delete-branch/);
    expect(cmd).not.toMatch(/-X DELETE/);
    expect(cmd).not.toMatch(/git push[^\n]*--delete/);
  });
});

describe('red-ops-reviewer — branch-protection guard fold', () => {
  it('flags @george and records recovery when a permanent branch was recreated', () => {
    const final = betaFold(
      { verdict: 'merged', merged: true, needsGeorge: false, reviewOnly: false, reason: 'promoted' },
      'BETA_GUARD:RECREATED:beta@482989127e34895e4660513ff385d8c249b5e2f3',
    );
    expect(final.betaGuardStatus).toBe('RECREATED');
    expect(final.betaGuardDetail).toBe('beta@482989127e34895e4660513ff385d8c249b5e2f3');
    expect(final.needsGeorge).toBe(true);
    expect(final.guardReason).toMatch(/auto-recreated/i);
    // Never clobbers the merge verdict or the model's reason.
    expect(final.verdict).toBe('merged');
    expect(final.reason).toBe('promoted');
  });

  it('leaves a clean run untouched when the permanent branch is still present', () => {
    const final = betaFold(
      { verdict: 'merged', merged: true, needsGeorge: false, reviewOnly: false },
      'BETA_GUARD:PRESENT:beta',
    );
    expect(final.betaGuardStatus).toBe('PRESENT');
    expect(final.needsGeorge).toBe(false);
  });

  it('does nothing on a disposable (feature) head', () => {
    const final = betaFold(
      { verdict: 'merged', merged: true, needsGeorge: false, reviewOnly: false },
      'BETA_GUARD:HEAD_NOT_PERMANENT:agent/foo',
    );
    expect(final.betaGuardStatus).toBe('HEAD_NOT_PERMANENT');
    expect(final.needsGeorge).toBe(false);
  });

  it('escalates when a permanent branch could not be restored', () => {
    const final = betaFold(
      { verdict: 'merged', merged: true, needsGeorge: false, reviewOnly: false },
      'BETA_GUARD:RECREATE_FAILED:beta',
    );
    expect(final.needsGeorge).toBe(true);
    expect(final.guardReason).toMatch(/restore it immediately/i);
  });

  it('is a no-op for review-only runs', () => {
    const final = betaFold(
      { verdict: 'approved', reviewOnly: true, needsGeorge: false },
      'BETA_GUARD:REVIEW_ONLY',
    );
    expect(final.betaGuardStatus).toBeUndefined();
  });
});

describe('red-ops-reviewer — response surfacing', () => {
  it('appends the guard signal AND the model reason to the response, without mutating result.reason', () => {
    const state = baseState({ prUrl: PR, reviewOnly: false });
    state.data.result = { verdict: 'blocked', reason: 'promotion PR conflicting', needsGeorge: false };
    state.data.finalText = 'Blocked: the promotion PR has conflicts.';
    state.data.mergeGuard = { stdout: 'MERGE_GUARD:OPEN' };
    evalSet(GUARD_STEP, state);
    evalSet(RESPONSE_STEP, state);

    expect(state.data.response).toContain('AUTO-MERGE GUARD blocked');
    expect(state.data.response).toContain('promotion PR conflicting'); // model reason still visible
    expect(state.data.result.reason).toBe('promotion PR conflicting'); // stored reason untouched
  });
});

describe('red-ops-reviewer — merge guard command', () => {
  it('short-circuits to REVIEW_ONLY for a review-only run', () => {
    const state = baseState({ prUrl: PR, repo: 'redbtn-io/redbtn', reviewOnly: true });
    evalSet(MERGE_GUARD_CMD_STEP, state);
    expect(state.data.mergeGuardCommand).toContain('MERGE_GUARD:REVIEW_ONLY');
  });

  it('queries real GitHub PR state for an auto-merge run', () => {
    const state = baseState({ prUrl: PR, repo: 'redbtn-io/redbtn', reviewOnly: false });
    evalSet(MERGE_GUARD_CMD_STEP, state);
    expect(state.data.mergeGuardCommand).toContain('gh pr view');
    expect(state.data.mergeGuardCommand).toContain('MERGE_GUARD:MERGED');
  });
});
