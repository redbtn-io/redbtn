/**
 * Coder Memory Context Builder (Card 6aa1d9d708971669b4a25d25).
 *
 * Joins durable run_logs timeline from redboard with per-criterion acceptance
 * attestations from the card, producing structured coder memory context.
 *
 * @module lib/memory/coder-memory/context
 */

import type {
  AcceptanceAttestation,
  CoderMemoryContext,
  CoderPriorRunContext,
  CoderPriorRunEvent,
} from './types';

export const MAX_PRIOR_EVENTS_IN_CONTEXT = 30;
export const MAX_EVENT_SNIPPET_LENGTH = 300;

export function formatEventSnippet(event: CoderPriorRunEvent): string {
  const kind = event.kind || 'text';
  const label = event.label ? `[${event.label}] ` : '';
  const text = (event.text || '').replace(/\r?\n+/g, ' ').trim();
  const truncated =
    text.length > MAX_EVENT_SNIPPET_LENGTH
      ? text.slice(0, MAX_EVENT_SNIPPET_LENGTH) + '...'
      : text;
  return `- ${kind.toUpperCase()}: ${label}${truncated}`;
}

export function formatCoderMemoryContext(context: CoderMemoryContext): string {
  const sections: string[] = [];

  // 1. Acceptance Criteria & Attestations
  if (context.acceptance.length > 0) {
    const total = context.acceptance.length;
    const completed = context.acceptance.filter((a) => a.done).length;
    const items: string[] = [
      `### Acceptance Criteria (${completed}/${total} met):`,
    ];
    for (const a of context.acceptance) {
      const box = a.done ? '[x]' : '[ ]';
      items.push(`- ${box} (${a.id}) ${a.text}`);
    }
    sections.push(items.join('\n'));
  }

  // 2. Prior Run History
  if (context.priorRun) {
    const r = context.priorRun;
    const header = [
      `### Prior Dispatched Run (${r.runId}):`,
      `- Status: ${r.runStatus} | Exit code: ${r.exitCode ?? 'none'} | Turns: ${r.turns ?? 0} | Duration: ${r.durationMs ? Math.round(r.durationMs / 1000) + 's' : 'unknown'}`,
    ];
    if (r.summary) {
      header.push(`- Summary: ${r.summary}`);
    }
    if (r.runs.length > 1) {
      const otherRuns = r.runs
        .filter((o) => o.runId !== r.runId)
        .slice(0, 3)
        .map((o) => `${o.runId} (${o.runStatus || 'done'})`)
        .join(', ');
      header.push(`- Other recorded runs on this card: ${otherRuns}`);
    }

    if (r.events && r.events.length > 0) {
      header.push(`\n**Timeline Snippets (recent ${Math.min(r.events.length, MAX_PRIOR_EVENTS_IN_CONTEXT)} events):**`);
      const recentEvents = r.events.slice(-MAX_PRIOR_EVENTS_IN_CONTEXT);
      for (const ev of recentEvents) {
        header.push(formatEventSnippet(ev));
      }
    }

    sections.push(header.join('\n'));
  }

  return sections.join('\n\n');
}

export function buildCoderMemoryContext(input: {
  cardId: string;
  boardId?: string;
  runLogData?: any;
  cardData?: any;
}): CoderMemoryContext {
  const cardId = input.cardId;
  const boardId = input.boardId;

  // Extract acceptance criteria
  const acceptance: AcceptanceAttestation[] = [];
  const rawAcceptance =
    input.cardData?.checklist || input.cardData?.acceptance || [];
  if (Array.isArray(rawAcceptance)) {
    for (const item of rawAcceptance) {
      if (typeof item === 'object' && item !== null) {
        acceptance.push({
          id: String(item.id || ''),
          text: String(item.text || ''),
          done: !!item.done,
        });
      }
    }
  }

  // Extract prior run context
  let priorRun: CoderPriorRunContext | null = null;
  const log = input.runLogData;
  if (log && log.available && log.runId) {
    priorRun = {
      cardId,
      runId: log.runId,
      runStatus: log.runStatus || 'unknown',
      exitCode: typeof log.exitCode === 'number' ? log.exitCode : null,
      durationMs: typeof log.durationMs === 'number' ? log.durationMs : null,
      turns: typeof log.turns === 'number' ? log.turns : null,
      summary: log.summary || null,
      lastEventAt: log.lastEventAt || null,
      events: Array.isArray(log.events) ? log.events : [],
      runs: Array.isArray(log.runs)
        ? log.runs.map((r: any) => ({
            runId: r.runId,
            runStatus: r.runStatus || null,
            exitCode: r.exitCode ?? null,
            durationMs: r.durationMs ?? null,
            turns: r.turns ?? null,
          }))
        : [],
      totalRuns: typeof log.totalRuns === 'number' ? log.totalRuns : (log.runs?.length || 1),
    };
  }

  const base: CoderMemoryContext = {
    cardId,
    boardId,
    priorRun,
    acceptance,
    formattedContext: '',
  };

  base.formattedContext = formatCoderMemoryContext(base);
  return base;
}
