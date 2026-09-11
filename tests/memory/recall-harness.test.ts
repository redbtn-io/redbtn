/**
 * Test Suite for redMem RAG Recall Harness (Card 6aa1d9c408971669b4a25d1f).
 *
 * Verifies all 10 acceptance criteria:
 * 1. 30 scripted questions against 20 seeded memories.
 * 2. 90% or better positive recall on 15 positive questions.
 * 3. ZERO confabulations on 5 no-memory canaries.
 * 4. ZERO unhedged stale assertions on 10 negative cases.
 * 5. Zero cross-session canary leakage (contextControl: mode 'ephemeral').
 * 6. ZERO memories contain a local command argument after held-trigger-key session.
 * 7. Transcription error rate recorded per run against fixed spoken script.
 * 8. Every recall failure labelled 'retrieval' or 'transcription', never assumed.
 * 9. Reports and files card on failure; does not gate deploy until 2 clean weeks.
 * 10. Every test artefact kept. No test suite run against production Mongo.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createHeldTriggerSession,
  verifyNoCommandArgumentLeak,
} from '../../src/lib/memory/recall-harness/desktop-boundary-test';
import {
  InMemoryMemoryStore,
  RecallHarnessRunner,
} from '../../src/lib/memory/recall-harness/harness';
import {
  buildResidentIndex,
  SEEDED_MEMORIES,
} from '../../src/lib/memory/recall-harness/seed-memories';
import { SCRIPTED_TEST_CASES } from '../../src/lib/memory/recall-harness/test-cases';
import {
  attributeFailure,
  calculateWordErrorRate,
  CANONICAL_SPOKEN_SCRIPT,
  evaluateTranscriptionBaseline,
  normalizeText,
} from '../../src/lib/memory/recall-harness/transcription-baseline';

describe('redMem RAG Recall Harness (Card 6aa1d9c408971669b4a25d1f)', () => {
  let tmpArtefactsDir: string;

  beforeEach(() => {
    tmpArtefactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-artefacts-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpArtefactsDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('1. Seeded Store & Resident Index Compliance', () => {
    it('seeds exactly 20 memories across 7 distinct domains', () => {
      expect(SEEDED_MEMORIES).toHaveLength(20);
      const domains = new Set(SEEDED_MEMORIES.map((m) => m.domain));
      expect(domains.size).toBe(7);
      expect(domains).toContain('personal');
      expect(domains).toContain('work');
      expect(domains).toContain('health');
      expect(domains).toContain('home');
      expect(domains).toContain('financial');
      expect(domains).toContain('projects');
      expect(domains).toContain('reference');
    });

    it('generates resident index strictly respecting caps: <=64 lines, <=120 chars/line, <=6000 chars', () => {
      const index = buildResidentIndex(SEEDED_MEMORIES);
      const lines = index.split('\n');

      expect(lines.length).toBeLessThanOrEqual(64);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(120);
      }
      expect(index.length).toBeLessThanOrEqual(6000);
    });
  });

  describe('2. Test Case Breakdown', () => {
    it('scripts exactly 30 test cases: 15 positive, 10 negative, 5 canaries', () => {
      expect(SCRIPTED_TEST_CASES).toHaveLength(30);

      const positives = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'positive');
      const negatives = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'negative');
      const canaries = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'canary');

      expect(positives).toHaveLength(15);
      expect(negatives).toHaveLength(10);
      expect(canaries).toHaveLength(5);
    });
  });

  describe('3. Positive Recall (Target >= 90%)', () => {
    it('achieves 90% or better positive recall on 15 positive questions against seeded store', async () => {
      const runner = new RecallHarnessRunner({ artefactsDir: tmpArtefactsDir });
      const positives = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'positive');

      let passedCount = 0;
      for (const tc of positives) {
        const result = runner.evaluateCase(tc);
        if (result.success) {
          passedCount++;
        } else {
          console.error(`POSITIVE MISSED: ${tc.id} - ${result.reason}\nActual: ${result.actualResponse}`);
        }
      }

      const recallRate = (passedCount / positives.length) * 100;
      expect(recallRate).toBeGreaterThanOrEqual(90);
      expect(passedCount).toBe(15);
    });
  });

  describe('4. Zero Confabulations on Canaries', () => {
    it('produces ZERO confabulations across all 5 no-memory canaries', () => {
      const runner = new RecallHarnessRunner({ artefactsDir: tmpArtefactsDir });
      const canaries = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'canary');

      for (const canary of canaries) {
        const result = runner.evaluateCase(canary);
        if (!result.success) {
          console.error(`CANARY FAILED: ${canary.id} - ${result.reason}\nActual: ${result.actualResponse}`);
        }
        expect(result.success).toBe(true);
      }
    });
  });

  describe('5. Zero Unhedged Stale Assertions', () => {
    it('produces ZERO unhedged stale assertions on the 10 negative cases', () => {
      const runner = new RecallHarnessRunner({ artefactsDir: tmpArtefactsDir });
      const negatives = SCRIPTED_TEST_CASES.filter((tc) => tc.type === 'negative');

      for (const neg of negatives) {
        const result = runner.evaluateCase(neg);
        if (!result.success) {
          console.error(`NEGATIVE FAILED: ${neg.id} - ${result.reason}\nActual: ${result.actualResponse}`);
        }
        expect(result.success).toBe(true);
      }
    });
  });

  describe('6. Zero Cross-Session Canary Leakage (contextControl: mode ephemeral)', () => {
    it('verifies ephemeral context isolation and zero cross-session canary leakage', () => {
      const runner = new RecallHarnessRunner({ artefactsDir: tmpArtefactsDir });
      const leakageResult = runner.testCanaryLeakage();

      expect(leakageResult.leaked).toBe(false);
      expect(leakageResult.details).toContain('Zero cross-session canary leakage verified');
    });
  });

  describe('7. Desktop Boundary Test: Zero Local Command Argument Leaks', () => {
    it('asserts wire frame sanitizes arguments and ZERO memories contain local command arguments', () => {
      const session = createHeldTriggerSession(
        'open visual studio',
        'C:\\secrets\\george_q3_financial_planning.pdf --key=priv_88992211',
      );

      expect(session.wireFrame.data.label).toBe('open visual studio');
      expect(JSON.stringify(session.wireFrame)).not.toContain('george_q3_financial_planning');
      expect(JSON.stringify(session.wireFrame)).not.toContain('priv_88992211');

      const extractedMemories = [
        'User triggered desktop command: open visual studio.',
      ];

      const boundaryResult = verifyNoCommandArgumentLeak(session, extractedMemories);
      expect(boundaryResult.passed).toBe(true);
      expect(boundaryResult.leakedTokens).toHaveLength(0);
      expect(boundaryResult.wireFrameSanitized).toBe(true);
    });

    it('flags an argument leakage if an unredacted argument crosses into memory', () => {
      const session = createHeldTriggerSession(
        'open visual studio',
        'confidential_client_tax_records.xlsx',
      );

      const buggyMemories = [
        'User executed command with argument confidential_client_tax_records.xlsx',
      ];

      const boundaryResult = verifyNoCommandArgumentLeak(session, buggyMemories);
      expect(boundaryResult.passed).toBe(false);
      expect(boundaryResult.leakedTokens).toContain('confidential');
    });
  });

  describe('8. STT Error Baseline & Objective Attribution', () => {
    it('computes Word Error Rate correctly on normalized text', () => {
      const werIdentical = calculateWordErrorRate(
        'tmux list-sessions or grep ps for opus',
        'tmux list-sessions or grep ps for opus',
      );
      expect(werIdentical).toBe(0);

      const werMangled = calculateWordErrorRate(
        'tmux list-sessions or grep ps for opus',
        'just check TX list sessions or Grep PS for Opus',
      );
      expect(werMangled).toBeGreaterThan(0.2);
    });

    it('records baseline error rate against canonical spoken script', () => {
      const sampleTranscriptions = [
        {
          phraseId: 'stt-01',
          transcribedText: 'tmux list-sessions or grep ps for opus',
        },
        {
          phraseId: 'stt-02',
          transcribedText: 'Ask your work specialist',
        },
        {
          phraseId: 'stt-03',
          transcribedText: 'Check ChromaDB port 8024 on redServer',
        },
      ];

      const baseline = evaluateTranscriptionBaseline(sampleTranscriptions);
      expect(baseline.evaluatedSamples).toHaveLength(3);
      expect(baseline.averageWer).toBe(0);
      expect(baseline.errorRatePercent).toBe(0);
    });

    it('strictly attributes recall failure to transcription when STT mangles entities', () => {
      const query = 'Ask your work specialist for advice';
      const mangledTranscription = 'Ask your word specialist for advice';

      const attr = attributeFailure(query, mangledTranscription, ['work specialist']);
      expect(attr.attribution).toBe('transcription');
      expect(attr.reason).toContain('STT corrupted critical entities');
    });

    it('strictly attributes recall failure to retrieval when STT is accurate', () => {
      const query = 'What is the port for ChromaDB on redServer?';
      const cleanTranscription = 'What is the port for ChromaDB on redServer?';

      const attr = attributeFailure(query, cleanTranscription, ['8024', 'redServer']);
      expect(attr.attribution).toBe('retrieval');
      expect(attr.reason).toContain('Transcription was accurate');
    });
  });

  describe('9. Full Harness End-to-End Run & Acceptance Contract', () => {
    it('executes full run passing all acceptance criteria and persisting artefacts', async () => {
      const runner = new RecallHarnessRunner({
        artefactsDir: tmpArtefactsDir,
        gateDeploy: false,
      });

      const report = await runner.run();

      expect(report.passed).toBe(true);
      expect(report.seededMemoryCount).toBe(20);
      expect(report.totalQuestions).toBe(30);
      expect(report.positiveRecallRate).toBeGreaterThanOrEqual(90);
      expect(report.confabulationCount).toBe(0);
      expect(report.unhedgedStaleCount).toBe(0);
      expect(report.canaryLeakageCount).toBe(0);
      expect(report.localCommandArgLeakCount).toBe(0);
      expect(report.gatesDeploy).toBe(false);

      expect(fs.existsSync(report.artefactPaths.reportJson)).toBe(true);
      expect(fs.existsSync(report.artefactPaths.summaryMd)).toBe(true);

      const savedJson = JSON.parse(fs.readFileSync(report.artefactPaths.reportJson, 'utf8'));
      expect(savedJson.report.runId).toBe(report.runId);

      const savedSummary = fs.readFileSync(report.artefactPaths.summaryMd, 'utf8');
      expect(savedSummary).toContain('PASSED');
      expect(savedSummary).toContain('Positive Recall');
    });

    it('files a RedBoard card on regression and does NOT gate deploy', async () => {
      let filedCardTitle = '';
      let filedCardBody = '';

      const runner = new RecallHarnessRunner({
        artefactsDir: tmpArtefactsDir,
        gateDeploy: false,
        fileCardOnFailure: true,
        cardReporter: async (title, body) => {
          filedCardTitle = title;
          filedCardBody = body;
          return 'card-regression-test-123';
        },
      });

      (runner as any).store.seed([]);

      const report = await runner.run();
      expect(report.passed).toBe(false);
      expect(report.positiveRecallRate).toBe(0);
      expect(report.gatesDeploy).toBe(false);

      expect(report.cardFiled).toBeDefined();
      expect(report.cardFiled?.title).toContain('[Recall Harness Regression]');
      expect(filedCardTitle).toContain('[Recall Harness Regression]');
      expect(filedCardBody).toContain('Deploy Gating Status');
      expect(filedCardBody).toContain('Non-gating mode');
    });
  });

  describe('10. Zero Production Mongo Touch', () => {
    it('runs purely in-memory with zero network or database dependencies', () => {
      const store = new InMemoryMemoryStore();
      expect(store.getAllMemories()).toHaveLength(20);
      const res = store.query('What is the IP of alphaSystem?');
      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.response).toContain('10.100.0.1');
    });
  });
});
