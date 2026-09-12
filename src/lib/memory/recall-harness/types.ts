/**
 * Types for the redMem RAG Recall Harness (Card 6aa1d9c408971669b4a25d1f).
 *
 * Enforces:
 * - 20 seeded memories across 7 domains.
 * - 30 scripted questions (15 positive, 10 negative, 5 canaries).
 * - >=90% positive recall target.
 * - ZERO confabulations on canaries.
 * - ZERO unhedged stale assertions on negative cases.
 * - Zero cross-session canary leakage (contextControl: mode 'ephemeral').
 * - ZERO memories containing local command arguments.
 * - STT error baseline measurement and attribution labelling ('retrieval' vs 'transcription').
 * - Non-gating deployment mode with automated failure card filing.
 */

export type MemoryDomain =
  | 'personal'
  | 'work'
  | 'health'
  | 'home'
  | 'financial'
  | 'projects'
  | 'reference';

export type MemoryStatus = 'active' | 'superseded' | 'expired';

export interface MemoryFact {
  id: string;
  domain: MemoryDomain;
  title: string;
  content: string;
  observedAt: string;
  status: MemoryStatus;
  validUntil?: string;
  supersededBy?: string;
  supersedesId?: string;
  tags: string[];
}

export type TestCaseType = 'positive' | 'negative' | 'canary';

export interface TestCase {
  id: string;
  type: TestCaseType;
  question: string;
  targetMemoryIds?: string[];
  expectedKeywords: string[];
  prohibitedKeywords?: string[];
  /**
   * For negative test cases: requires that the response hedges or explicitly
   * states that the fact is outdated/superseded/expired, and avoids affirmative
   * claims of stale state.
   */
  requireHedge?: boolean;
  /**
   * For canaries: a synthetic identifier with no seeded memory, requiring
   * an explicit refusal or unknown indication (e.g. "I don't have that in memory").
   */
  canaryToken?: string;
}

export type FailureAttribution = 'retrieval' | 'transcription' | 'none';

export interface EvaluationResult {
  testCaseId: string;
  type: TestCaseType;
  question: string;
  success: boolean;
  actualResponse: string;
  attribution: FailureAttribution;
  reason: string;
  sttWer?: number;
}

export interface TranscriptionSample {
  id: string;
  referenceText: string;
  transcribedText: string;
  wer: number;
  mangledEntities: string[];
}

export interface HarnessRunReport {
  runId: string;
  timestamp: string;
  seededMemoryCount: number;
  totalQuestions: number;
  positiveCount: number;
  positivePassed: number;
  positiveRecallRate: number; // 0 - 100 percentage
  canaryCount: number;
  confabulationCount: number;
  negativeCount: number;
  unhedgedStaleCount: number;
  canaryLeakageCount: number;
  localCommandArgLeakCount: number;
  transcriptionErrorRate: number; // 0 - 100 percentage
  failureAttributions: Array<{
    testCaseId: string;
    attribution: FailureAttribution;
    reason: string;
  }>;
  passed: boolean;
  cardFiled?: {
    title: string;
    body: string;
    cardId?: string;
  };
  gatesDeploy: boolean;
  artefactPaths: {
    reportJson: string;
    summaryMd: string;
  };
}

export interface HarnessOptions {
  gateDeploy?: boolean;
  artefactsDir?: string;
  fileCardOnFailure?: boolean;
  cardReporter?: (title: string, body: string) => Promise<string | void>;
  transcriptionSamples?: TranscriptionSample[];
  sttErrorRateOverride?: number;
}
