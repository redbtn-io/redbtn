/**
 * Graph-referenced secret discovery tests.
 *
 * `extractSecretNamesFromConfig` is what makes secrets "just work" for a chat or
 * agent: enrichInput scans the graph's node-step configs for the secrets the
 * graph references (`_secrets.NAME` / `{{secret:NAME}}`) and resolves exactly
 * those from the user's own secrets — no pre-seeded graphInputs placeholder
 * needed. (Before this, a conversation without the placeholder had empty
 * `_secrets`, so e.g. the claude-assistant ssh step failed "Unsupported key
 * format".)
 *
 * These cover the real reference shapes the claude-assistant graph uses and the
 * least-privilege guarantee (no spurious names from unrelated text).
 */

import { describe, it, expect } from 'vitest';
import { extractSecretNamesFromConfig } from '../../src/lib/run/enrich-input';

describe('extractSecretNamesFromConfig', () => {
  it('extracts the real claude-assistant reference: {{state.data.input._secrets.SSH_KEY}}', () => {
    const cfg = JSON.stringify([
      { operation: 'set', outputField: 'data.resolvedSshKey', value: '{{state.data.input._secrets.SSH_KEY}}' },
    ]);
    expect(extractSecretNamesFromConfig(cfg)).toEqual(['SSH_KEY']);
  });

  it('extracts bracket access: _secrets["API_TOKEN"] and _secrets[\'X\']', () => {
    const cfg = `foo _secrets["API_TOKEN"] bar _secrets['X'] baz`;
    expect(extractSecretNamesFromConfig(cfg).sort()).toEqual(['API_TOKEN', 'X']);
  });

  it('extracts {{secret:NAME}} placeholders embedded in configs', () => {
    const cfg = JSON.stringify({ key: '{{secret:REDRUN_API_KEY}}', other: '{{ secret:GH_PAT }}' });
    expect(extractSecretNamesFromConfig(cfg).sort()).toEqual(['GH_PAT', 'REDRUN_API_KEY']);
  });

  it('dedupes repeated references across a node', () => {
    const cfg = '_secrets.SSH_KEY ... _secrets.SSH_KEY ... {{secret:SSH_KEY}}';
    expect(extractSecretNamesFromConfig(cfg)).toEqual(['SSH_KEY']);
  });

  it('collects multiple distinct secrets', () => {
    const cfg = '{{state.data.input._secrets.SSH_KEY}} and {{state.data.input._secrets.REDRUN_API_KEY}}';
    expect(extractSecretNamesFromConfig(cfg).sort()).toEqual(['REDRUN_API_KEY', 'SSH_KEY']);
  });

  it('returns nothing for configs with no secret references (least-privilege)', () => {
    const cfg = JSON.stringify([
      { operation: 'set', outputField: 'data.x', value: '{{state.data.input.message}}' },
      { operation: 'get-global', namespace: 'prompts', key: 'structuredOutput' },
    ]);
    expect(extractSecretNamesFromConfig(cfg)).toEqual([]);
  });

  it('does not match a property literally named secrets (only the _secrets sigil)', () => {
    const cfg = 'state.data.secrets.NOPE and config.mySecretsThing.NOPE2';
    expect(extractSecretNamesFromConfig(cfg)).toEqual([]);
  });
});
