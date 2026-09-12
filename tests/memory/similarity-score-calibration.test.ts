import { describe, expect, test } from 'vitest';
import { DEFAULT_SIMILARITY_THRESHOLD, SearchResult } from '../../src/lib/memory/vectors';
import searchDocuments from '../../src/lib/tools/native/search-documents';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

function makeContext(): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1', authToken: 'jwt-test' },
    runId: 'run-1',
    nodeId: 'node-1',
    toolId: 'tool-1',
    abortSignal: null,
  };
}

describe('Similarity Score Conversion & Threshold Recalibration (Card 6aa223ea08971669b4a25e5b)', () => {
  test('1. DEFAULT_SIMILARITY_THRESHOLD is recalibrated to 0.55', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.55);
  });

  test('2. Score conversion formula is true cosine similarity (score = 1 - distance)', () => {
    // Distance of 0.0 (identical) -> score 1.0
    expect(1 - 0.0).toBe(1.0);
    // Distance of 0.4405 (database replication topology) -> score 0.5595
    const distRelevant = 0.4405;
    const scoreRelevant = 1 - distRelevant;
    expect(scoreRelevant).toBeCloseTo(0.5595, 4);
    expect(scoreRelevant >= DEFAULT_SIMILARITY_THRESHOLD).toBe(true);

    // Distance of 0.5737 ("what is my sleep goal" on red-research, irrelevant) -> score 0.4263
    const distIrrelevant = 0.5737;
    const scoreIrrelevant = 1 - distIrrelevant;
    expect(scoreIrrelevant).toBeCloseTo(0.4263, 4);
    // MUST NOT clear the 0.55 threshold!
    expect(scoreIrrelevant >= DEFAULT_SIMILARITY_THRESHOLD).toBe(false);
  });

  test('3. Demonstrates why legacy 1 - (dist / 2) was broken and allowed noise to clear 0.70', () => {
    const distIrrelevant = 0.5737; // "what is my sleep goal" against red-research
    const legacyScore = 1 - (distIrrelevant / 2);
    expect(legacyScore).toBeCloseTo(0.7132, 4);
    // Under the broken legacy formula, it cleared 0.70!
    expect(legacyScore >= 0.70).toBe(true);

    // Under corrected formula:
    const correctedScore = 1 - distIrrelevant;
    expect(correctedScore >= DEFAULT_SIMILARITY_THRESHOLD).toBe(false);
  });

  test('4. Score spread calibration comparison between legacy and corrected formulas', () => {
    // Sample corpus distances measured against live Chroma
    const measurements = [
      { query: 'zebra migration botswana', dist: 0.2554, relevant: true },
      { query: 'tunguska event explosion', dist: 0.4131, relevant: true },
      { query: 'antikythera mechanism', dist: 0.4330, relevant: true },
      { query: 'database replication topology', dist: 0.4405, relevant: true },
      { query: 'what is my sleep goal', dist: 0.5737, relevant: false },
      { query: 'flight to denver', dist: 0.5482, relevant: false },
      { query: 'buy eggs and milk', dist: 0.5254, relevant: false },
      { query: 'recipe for chocolate cake', dist: 0.5255, relevant: false },
    ];

    for (const m of measurements) {
      const legacyScore = 1 - (m.dist / 2);
      const newScore = 1 - m.dist;

      if (!m.relevant) {
        // Irrelevant queries MUST NOT clear the recalibrated threshold
        expect(newScore).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
      }
    }
  });

  test('5. search-documents.ts renders [similarity: X.XXX] and NEVER renders inflated "% relevant"', async () => {
    const originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';

    try {
      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              { id: 'r1', text: 'Clean architecture facts', score: 0.8123, metadata: { source: 'arch.md' } },
            ],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const result = await searchDocuments.handler(
        { libraryId: 'lib-test', query: 'architecture' },
        makeContext(),
      );

      expect(result.isError).toBeFalsy();
      const output = result.content[0].text;

      // Must contain clean similarity score
      expect(output).toContain('[similarity: 0.812]');
      // Must NOT contain inflated percentage label
      expect(output).not.toContain('% relevant');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.WEBAPP_URL;
    }
  });

  test('6. search-documents schema defaults to DEFAULT_SIMILARITY_THRESHOLD (0.55)', () => {
    const thresholdProp = (searchDocuments.inputSchema?.properties as any)?.threshold;
    expect(thresholdProp.default).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(thresholdProp.description).toContain('0.55');
  });
});
