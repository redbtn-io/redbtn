import { describe, expect, it } from 'vitest';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';

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
    // Mirrors the failure shape that broke red-reviewer-auto: the extra `)`
    // makes the IIFE invalid. Before this guard, the raw {{...}} source was
    // written to data.cliPrompt and handed to the reviewer as its prompt.
    const malformedPrompt = `{{(function(){
      var r = state.data.rev || {};
      return [r.prUrl ? 'has-pr' : 'missing-pr'), 'continue'].join('\\n');
    })()}}`;

    expect(() =>
      resolveValue(malformedPrompt, { data: { rev: REVIEWER_INPUT } }, { throwOnError: true }),
    ).toThrow(/template expression failed to evaluate/i);
  });
});
