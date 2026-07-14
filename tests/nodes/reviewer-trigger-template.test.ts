import { describe, expect, it } from 'vitest';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';
import { executeTransform } from '../../src/lib/nodes/universal/executors/transformExecutor';
import type { TransformStepConfig } from '../../src/lib/nodes/universal/types';

const REVIEWER_INPUT = {
  prUrl: 'https://github.com/redbtn-io/redbtn/pull/255',
  repo: 'redbtn-io/redbtn',
  base: 'beta',
  project: 'redbtn-engine',
  slug: 'redbtn-engine',
  reviewOnly: true,
};

const REVIEW_INPUT_TEMPLATE = `{{(function(){
  var i = (state.data && state.data.input) || {};
  return {
    prUrl: i.prUrl || i.pr || '',
    repo: i.repo || '',
    base: i.base || 'beta',
    project: i.project || i.slug || '',
    slug: i.slug || i.project || '',
    reviewOnly: i.reviewOnly === true || i.reviewOnly === 'true',
  };
})()}}`;

const REVIEW_PROMPT_TEMPLATE = `{{(function(){
  var r = state.data.rev || {};
  var mode = r.reviewOnly === true ? 'REVIEW-ONLY' : 'AUTO-MERGE';
  return ['mode: ' + mode, 'PR: ' + r.prUrl, 'repo: ' + r.repo].join('\\n');
})()}}`;

/**
 * The exact failure shape that broke red-reviewer-auto: a ternary branch
 * followed by a stray `)` makes the IIFE invalid. Before this fix, the raw
 * {{...}} source was written to data.cliPrompt and handed to the reviewer CLI
 * as its prompt on every single run.
 */
const MALFORMED_PROMPT_TEMPLATE = `{{(function(){
  var r = state.data.rev || {};
  return [r.prUrl ? 'has-pr' : 'missing-pr'), 'continue'].join('\\n');
})()}}`;

describe('reviewer explicit-trigger input regression', () => {
  it('normalizes an explicit trigger_automation input into data.rev before rendering the prompt', async () => {
    const state: any = { data: { input: REVIEWER_INPUT } };

    const rev = resolveValue(REVIEW_INPUT_TEMPLATE, state, { throwOnError: true });

    expect(rev).toEqual(REVIEWER_INPUT);
    state.data.rev = rev;

    const prompt = resolveValue(REVIEW_PROMPT_TEMPLATE, state, { throwOnError: true });

    expect(prompt).toContain('mode: REVIEW-ONLY');
    expect(prompt).toContain(REVIEWER_INPUT.prUrl);
    expect(prompt).not.toContain('{{');
  });

  it('fails loudly instead of persisting an unrendered malformed prompt template', async () => {
    expect(() =>
      resolveValue(MALFORMED_PROMPT_TEMPLATE, { data: { rev: REVIEWER_INPUT } }, { throwOnError: true }),
    ).toThrow(/template expression failed to evaluate/i);
  });

  it('renders the AUTO-MERGE branch when reviewOnly is false', () => {
    // The bug was in the `reviewOnly ? ... : ...` ternary, so both branches of the
    // real template need pinning — a fix that only ever exercises REVIEW-ONLY would
    // not notice the auto-merge arm regressing.
    const autoMergeInput = { ...REVIEWER_INPUT, reviewOnly: false };
    const state: any = { data: { input: autoMergeInput } };

    const rev = resolveValue(REVIEW_INPUT_TEMPLATE, state, { throwOnError: true });
    expect(rev.reviewOnly).toBe(false);

    state.data.rev = rev;
    const prompt = resolveValue(REVIEW_PROMPT_TEMPLATE, state, { throwOnError: true });

    expect(prompt).toContain('mode: AUTO-MERGE');
    expect(prompt).not.toContain('REVIEW-ONLY');
    expect(prompt).not.toContain('{{');
  });

  it('leaves resolveValue lenient by default, so non-set callers keep their behaviour', () => {
    // `throwOnError` is opt-in on purpose: only the state-mutating `set` path takes
    // it. renderParameters, step conditions and get-global still get the documented
    // lenient fallback (raw source returned, no throw). This pins that contract so
    // the fail-closed change stays scoped to what persists state.
    const state = { data: { rev: REVIEWER_INPUT } };

    expect(() => resolveValue(MALFORMED_PROMPT_TEMPLATE, state)).not.toThrow();
    expect(resolveValue(MALFORMED_PROMPT_TEMPLATE, state)).toBe(MALFORMED_PROMPT_TEMPLATE);

    // A well-formed template is unaffected either way.
    expect(resolveValue(REVIEW_PROMPT_TEMPLATE, state)).toContain('mode: REVIEW-ONLY');
  });
});

/**
 * The tests above pin `resolveValue`, but production never calls it directly —
 * the reviewer node runs two `set` transform steps through `executeTransform`,
 * which is what actually writes `data.rev` and `data.cliPrompt` into graph state.
 * These drive that executor so the fix is verified on the path it really runs on.
 */
describe('reviewer prompt persistence — through the transform executor', () => {
  const setStep = (outputField: string, value: string): TransformStepConfig =>
    ({ operation: 'set', outputField, value }) as TransformStepConfig;

  it('renders data.rev then data.cliPrompt, leaving no literal template in the persisted patch', async () => {
    const state: any = { data: { input: REVIEWER_INPUT } };

    // Step 1 — the node's `set data.rev` step.
    const revPatch = await executeTransform(setStep('data.rev', REVIEW_INPUT_TEMPLATE), state);
    expect(revPatch['data.rev']).toEqual(REVIEWER_INPUT);

    // Feed step 1's output forward exactly as the engine merges it.
    state.data.rev = revPatch['data.rev'];

    // Step 2 — the `set data.cliPrompt` step that handed the CLI its prompt.
    const promptPatch = await executeTransform(setStep('data.cliPrompt', REVIEW_PROMPT_TEMPLATE), state);
    const cliPrompt = promptPatch['data.cliPrompt'];

    expect(cliPrompt).toContain('mode: REVIEW-ONLY');
    expect(cliPrompt).toContain(REVIEWER_INPUT.prUrl);
    expect(cliPrompt).not.toContain('{{');
  });

  it('aborts the step rather than returning the raw template for persistence', async () => {
    const state = { data: { rev: REVIEWER_INPUT } };
    const config = setStep('data.cliPrompt', MALFORMED_PROMPT_TEMPLATE);

    // The regression: this used to *resolve* with { 'data.cliPrompt': '{{(function(){...' },
    // which the engine merged into state and passed to the reviewer CLI verbatim.
    await expect(executeTransform(config, state)).rejects.toThrow(/Transform step failed/);

    // The error must name the field that would have been poisoned and quote the
    // offending template, so the failing run says what to fix.
    await expect(executeTransform(config, state)).rejects.toThrow(/data\.cliPrompt/);
    await expect(executeTransform(config, state)).rejects.toThrow(/template:/);
  });

  it('still fails closed when the malformed set targets global state', async () => {
    // `set` with a globalState.* outputField persists across runs — the raw
    // template must not reach the global-state client.
    const config = setStep('globalState.reviewer.cliPrompt', MALFORMED_PROMPT_TEMPLATE);

    await expect(executeTransform(config, { data: { rev: REVIEWER_INPUT } })).rejects.toThrow(
      /Transform step failed/,
    );
  });
});
