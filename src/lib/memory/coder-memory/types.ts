/**
 * Types for Coder Memory from run_logs and acceptance attestations (Card 6aa1d9d708971669b4a25d25).
 *
 * @module lib/memory/coder-memory/types
 */

export interface CoderPriorRunEvent {
  kind: string;
  label?: string;
  text?: string;
  at?: string;
  durationMs?: number;
}

export interface CoderRunSummary {
  runId: string;
  runStatus: string | null;
  exitCode: number | null;
  durationMs?: number | null;
  turns?: number | null;
}

export interface CoderPriorRunContext {
  cardId: string;
  runId: string;
  runStatus: string;
  exitCode: number | null;
  durationMs: number | null;
  turns: number | null;
  summary: string | null;
  lastEventAt: string | null;
  events: CoderPriorRunEvent[];
  runs: CoderRunSummary[];
  totalRuns: number;
}

export interface AcceptanceAttestation {
  id: string;
  text: string;
  done: boolean;
  attestationNote?: string;
}

export interface CoderMemoryContext {
  cardId: string;
  boardId?: string;
  priorRun: CoderPriorRunContext | null;
  acceptance: AcceptanceAttestation[];
  formattedContext: string;
}
