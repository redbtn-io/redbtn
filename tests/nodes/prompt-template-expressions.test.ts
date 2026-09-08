/**
 * `{{a || 'fallback'}}` in a neuron step's prompts — report 39, defect D2.
 *
 * # What was broken
 *
 * `renderTemplate` recognised exactly one form: the bare dotted path
 * `{{state.a.b}}` / `{{parameters.x}}`. Every other form — a `||` fallback, a
 * ternary, an IIFE, bracket indexing — matched neither of its two regexes and
 * was left in the string VERBATIM.
 *
 * A transform step never hit that, because `transformExecutor`'s `set` goes
 * through `resolveValue`, which falls back to evaluating the expression. A
 * neuron step's `systemPrompt` / `userPrompt` goes through `renderTemplate`.
 * So the same expression, in the same run, resolved in a transform and reached
 * the model as its own source text in a prompt:
 *
 *   > "the transcript between those markers is empty (it shows the placeholder
 *   >  text, not actual prior messages)"  — Sonnet 5, conversation c2t2
 *
 * It is platform-wide, not a claude-code quirk: `neuronExecutor` builds every
 * provider's prompts with the same `renderTemplate`.
 *
 * Blast radius at the time of the report: the live `red-coder-node-opus` node
 * uses the idiom three times (working directory, workspace snapshot, workspace
 * instructions), so Red Coder was running with all three lines blank.
 *
 * These tests pin: the expression forms resolve, they resolve to the SAME
 * thing a transform gets, the bare-path behaviour is unchanged, and a value
 * substituted INTO a template is never itself evaluated.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  renderTemplate,
  resolveValue,
  hasTemplateVariables,
  findTemplateExpressions,
} from '../../src/lib/nodes/universal/templateRenderer';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TRANSCRIPT = 'george@redbtn.io: Do three things, briefly\nSonnet 5: sure';

function state(over: Any = {}): Any {
  return {
    data: {
      input: { _recentTranscript: TRANSCRIPT, message: 'latest' },
      workingDir: '/home/alpha/code/redbtn',
      workspace: 'WORKSPACE SNAPSHOT',
      items: [1, 2, 3],
      obj: { a: 1 },
      ...(over.data ?? {}),
    },
    parameters: { ns: 'test-sonnet5', ...(over.parameters ?? {}) },
  };
}

describe('renderTemplate — expression forms (defect D2)', () => {
  it("resolves {{a || 'fallback'}} to the value when the path exists", () => {
    const out = renderTemplate(
      "<<<TRANSCRIPT-BEGIN>>>\n{{state.data.input._recentTranscript || '(no earlier messages)'}}\n<<<TRANSCRIPT-END>>>",
      state(),
    );
    expect(out).toBe(`<<<TRANSCRIPT-BEGIN>>>\n${TRANSCRIPT}\n<<<TRANSCRIPT-END>>>`);
    expect(out).not.toContain('{{');
  });

  it("resolves {{a || 'fallback'}} to the fallback when the path is missing", () => {
    expect(
      renderTemplate("{{state.data.nothingHere || '(no earlier messages)'}}", state()),
    ).toBe('(no earlier messages)');
  });

  it('resolves ternaries, indexing, comparisons and IIFEs', () => {
    const s = state();
    expect(renderTemplate("{{state.data.items.length > 2 ? 'many' : 'few'}}", s)).toBe('many');
    expect(renderTemplate("{{state.data.input['_recentTranscript']}}", s)).toBe(TRANSCRIPT);
    expect(renderTemplate('{{state.data.items[1]}}', s)).toBe('2');
    // Braces inside the expression: a regex-based scanner stops at the first
    // inner `}}` and mangles this one.
    expect(
      renderTemplate("{{(() => { return state.data.items.join('-'); })()}}", s),
    ).toBe('1-2-3');
  });

  it('resolves {{parameters.x || fallback}} too', () => {
    expect(renderTemplate("{{parameters.ns || 'default'}}", state())).toBe('test-sonnet5');
    expect(renderTemplate("{{parameters.missing || 'default'}}", state())).toBe('default');
  });

  it('stringifies an object result the way a bare path does', () => {
    expect(renderTemplate("{{state.data.obj || {}}}", state())).toBe('{"a":1}');
    expect(renderTemplate('{{state.data.obj}}', state())).toBe('{"a":1}');
  });

  it('renders several expressions and plain text in one string', () => {
    const out = renderTemplate(
      "dir={{state.data.workingDir || '/'}} ns={{parameters.ns}} n={{state.data.items.length}}",
      state(),
    );
    expect(out).toBe('dir=/home/alpha/code/redbtn ns=test-sonnet5 n=3');
  });

  it('agrees with what a transform step (resolveValue) gets for the same expression', () => {
    const s = state();
    for (const expr of [
      "{{state.data.input._recentTranscript || '(no earlier messages)'}}",
      "{{state.data.nothingHere || '(no earlier messages)'}}",
      "{{state.data.items.length > 2 ? 'many' : 'few'}}",
    ]) {
      expect(renderTemplate(expr, s)).toBe(String(resolveValue(expr, s)));
    }
  });

  // ── non-regressions ─────────────────────────────────────────────────────
  it('still leaves a bare path that does not resolve exactly as it was', () => {
    expect(renderTemplate('{{state.data.history}}', state())).toBe('{{state.data.history}}');
    expect(renderTemplate('{{parameters.nope}}', state())).toBe('{{parameters.nope}}');
  });

  it('leaves globalState to renderTemplateAsync', () => {
    expect(renderTemplate("{{globalState.ns.key || 'x'}}", state())).toBe(
      "{{globalState.ns.key || 'x'}}",
    );
  });

  it('never touches a mustache that does not mention state or parameters', () => {
    expect(renderTemplate('literal {{foo}} and {{ bar.baz }} stay', state())).toBe(
      'literal {{foo}} and {{ bar.baz }} stay',
    );
  });

  it('warns and keeps the source when an expression yields nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(renderTemplate('{{state.data.obj.missing}}', state())).toBe(
        '{{state.data.obj.missing}}',
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The expression pass can execute JavaScript, so it runs on the template the
   * graph author wrote and NEVER on a value substituted into it. A chat message
   * that happens to contain braces must not become executable.
   */
  it('does not evaluate an expression that arrived inside a substituted value', () => {
    const injected = {
      data: { msg: "{{state.constructor.constructor('return 1+1')()}}" },
    } as Any;
    expect(renderTemplate('user said: {{state.data.msg}}', injected)).toBe(
      "user said: {{state.constructor.constructor('return 1+1')()}}",
    );
  });

  it('hasTemplateVariables recognises expression forms', () => {
    expect(hasTemplateVariables("{{state.a || 'b'}}")).toBe(true);
    expect(hasTemplateVariables('{{state.a}}')).toBe(true);
    expect(hasTemplateVariables('no templates here')).toBe(false);
    expect(hasTemplateVariables('{{unrelated}}')).toBe(false);
  });

  it('findTemplateExpressions balances braces and ignores a stray mustache', () => {
    expect(findTemplateExpressions('a {{state.x}} b').map((g) => g.expression)).toEqual([
      'state.x',
    ]);
    expect(
      findTemplateExpressions('{{(() => { return 1 })()}}').map((g) => g.expression),
    ).toEqual(['(() => { return 1 })()']);
    expect(findTemplateExpressions('{{ unterminated').length).toBe(0);
  });
});

/**
 * The live `red-coder-node-opus` system prompt, verbatim. Before the fix all
 * three of these lines reached Opus 5 as their own source text.
 */
describe('red-coder-node-opus system prompt (blast radius)', () => {
  const PROMPT = [
    "- **Working directory**: {{state.data.workingDir || '/'}}",
    '- **Workspace snapshot**:',
    "{{state.data.workspace || '(workspace orientation not yet captured)'}}",
    '## Workspace instructions',
    "{{state.data.workspaceInstructions || '(this workspace ships no AGENTS.md or CLAUDE.md)'}}",
  ].join('\n');

  it('renders all three lines with the real values when they are in state', () => {
    const out = renderTemplate(
      PROMPT,
      state({ data: { workspaceInstructions: 'AGENTS.md says hello' } }),
    );
    expect(out).not.toContain('{{');
    expect(out).toContain('- **Working directory**: /home/alpha/code/redbtn');
    expect(out).toContain('WORKSPACE SNAPSHOT');
    expect(out).toContain('AGENTS.md says hello');
  });

  it('renders the declared fallbacks when they are not', () => {
    const out = renderTemplate(PROMPT, {
      data: {},
      parameters: {},
    } as Any);
    expect(out).not.toContain('{{');
    expect(out).toContain('- **Working directory**: /');
    expect(out).toContain('(workspace orientation not yet captured)');
    expect(out).toContain('(this workspace ships no AGENTS.md or CLAUDE.md)');
  });
});

/**
 * Platform-wide, not claude-code-only: `neuronExecutor` renders every
 * provider's prompts through the same `renderTemplate`.
 */
describe('neuronExecutor prompts — any provider (platform-wide)', () => {
  function makeState(over: Any = {}) {
    const seen: Any[] = [];
    // `neuronExecutor` always streams internally, so the mock must return an
    // async iterable regardless of `config.stream`.
    async function* chunks() {
      yield { content: 'ok' };
    }
    const neuronRegistry = {
      getConfig: vi.fn(async (id: string) => ({
        neuronId: id,
        provider: 'google',
        model: 'gemini-2.5-flash',
      })),
      getModel: vi.fn(async () => ({})),
      callNeuron: vi.fn(async (_id: Any, _userId: Any, messages: Any) => {
        seen.push(messages);
        return chunks();
      }),
    };
    return {
      seen,
      state: {
        neuronRegistry,
        data: { runId: 'run_test', ...(over.data ?? {}) },
        parameters: {},
      } as Any,
    };
  }

  it('resolves a || fallback in systemPrompt and userPrompt for a non-claude-code neuron', async () => {
    const { state: s, seen } = makeState({ data: { transcript: TRANSCRIPT } });

    await executeNeuron(
      {
        neuronId: 'gemini-flash',
        outputField: 'data.out',
        stream: false,
        systemPrompt: "Working dir: {{state.data.workingDir || '/none'}}",
        userPrompt: "TRANSCRIPT:\n{{state.data.transcript || '(no earlier messages)'}}",
      } as Any,
      s,
    );

    const messages = seen[0] as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system')!.content;
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(system).toContain('Working dir: /none');
    expect(system).not.toContain('{{');
    expect(user).toContain(TRANSCRIPT);
    expect(user).not.toContain('{{');
  });
});
