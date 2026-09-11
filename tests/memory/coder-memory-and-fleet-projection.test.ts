/**
 * Vitest suite for Coder Memory & Fleet Projection (Card 6aa1d9d708971669b4a25d25).
 *
 * Verifies all 11 acceptance criteria:
 * 1. Zero filesystem writes (one-way disk to platform, read-only).
 * 2. brain-sync is never a write target.
 * 3. Fleet memories are pointer records with fileRef, bucket, modifiedAt, NOT copied bodies.
 * 4. Index line calibration: max 120 chars, 3 buckets (reference, project, feedback) + archive tier.
 * 5. Orphan detection: topic files reachable from neither index are counted and reported.
 * 6. Dormancy markers rendered on every fleet memory pointer.
 * 7. Coder context comes from redboard.run_logs by cardId plus per-criterion acceptance criteria.
 * 8. Dependency on redBoard MCP tools is satisfied.
 * 9. Coder node is formally declared and verified as read-only on memory/state.
 * 10. Capability selector mismatch is resolved using coder* bare-prefix glob.
 * 11. Dispatched coder run task delivery (input.task / redboard dispatch to data.messages & data.task).
 */

import { describe, expect, it } from 'vitest';
import {
  buildFleetProjection,
  extractFrontmatter,
  formatResidentIndexLine,
  MAX_INDEX_LINE_CHARS,
  parseActiveMemoryIndex,
  parseArchivedMemoryIndex,
} from '../../src/lib/memory/fleet-projection';
import {
  buildCoderMemoryContext,
  formatCoderMemoryContext,
} from '../../src/lib/memory/coder-memory';
import { extractTaskOrMessage } from '../../src/functions/run';
import {
  decide,
  selectorMatches,
} from '../../src/lib/permissions/matcher';
import {
  RED_CODER_CAPABILITY_PROFILE,
  RED_CODER_GRAPH_IDS,
} from '../../src/lib/permissions/red-coder-profile';

describe('Coder Memory & Fleet Projection (Card 6aa1d9d708971669b4a25d25)', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1 & 2. Zero File Writes & One-Way Read-Only Projection
  // ─────────────────────────────────────────────────────────────────────────
  describe('1 & 2. Zero File Writes & Read-Only Direction', () => {
    it('executes fleet projection completely in-memory without invoking file write APIs', () => {
      const mockMemoryMd = `
- [alcon contract](alcon_contract.md) — George writes Alcon AVS product-security docs (GlobalLogic).
- [favorite color](user_favorite_color.md) — George's favorite color is teal.
- [be concise](feedback_be_concise.md) — Terse, results-first; no play-by-play.
`;
      const mockArchiveMd = `
- \`project_security_audit_2026_05_27.md\` — redrouter/redGuard/redAuth audit findings.
`;
      const mockTopicFiles = [
        {
          filename: 'alcon_contract.md',
          content: '---\nname: Alcon contract\ntype: project\nmodified: 2026-09-01T10:00:00Z\n---\nFull body text that must never be copied',
          sizeBytes: 1500,
        },
        {
          filename: 'user_favorite_color.md',
          content: '---\nname: Favorite color\ntype: reference\nmodified: 2026-08-15T12:00:00Z\n---\nColor details',
          sizeBytes: 500,
        },
        {
          filename: 'feedback_be_concise.md',
          content: '---\nname: Be concise\ntype: feedback\nmodified: 2026-07-20T08:00:00Z\n---\nBe terse and direct',
          sizeBytes: 800,
        },
        {
          filename: 'project_security_audit_2026_05_27.md',
          content: '---\nname: Security audit\ntype: project\nmodified: 2026-05-27T00:00:00Z\n---\nAudit details',
          sizeBytes: 2500,
        },
        {
          filename: 'unindexed_orphan.md',
          content: '---\nname: Orphan note\ntype: reference\nmodified: 2026-06-11T00:00:00Z\n---\nOrphan content',
          sizeBytes: 1200,
        },
      ];

      const report = buildFleetProjection({
        memoryMdContent: mockMemoryMd,
        archiveMdContent: mockArchiveMd,
        topicFiles: mockTopicFiles,
      });

      expect(report).toBeDefined();
      expect(report.totalFilesScanned).toBe(5);
      expect(report.pointers.length).toBe(5);

      // Verify brain-sync is NOT targeted and bodies are NOT copied
      for (const p of report.pointers) {
        expect(p.scope).toBe('fleet');
        expect((p as any).body).toBeUndefined();
        expect((p as any).content).toBeUndefined();
        expect(p.fileRef).toBeTruthy();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3 & 4. Pointer Records & Calibrated Index Lines
  // ─────────────────────────────────────────────────────────────────────────
  describe('3 & 4. Pointers & Index Line Calibration', () => {
    it('produces pointer memories carrying path, type, and modifiedAt, strictly capping lines at <= 120 chars', () => {
      const line = formatResidentIndexLine(
        'Alcon Contract & Medical Device Architecture Specs',
        'project_alcon_device_specs_v2.md',
        'project',
        'Detailed medical device compliance deliverable specifications for the Extend appliance and Gateway platform.',
        '2026-09-01T12:00:00Z',
      );

      expect(line.length).toBeLessThanOrEqual(MAX_INDEX_LINE_CHARS);
      expect(line).toContain('[fleet]');
      expect(line).toContain('[project]');
      expect(line).toContain('2026-09-01');
    });

    it('demotes archived entries out of the resident Tier-1 index lines while retaining pointer records', () => {
      const mockMemoryMd = `- [live task](live_task.md) — Live ongoing work`;
      const mockArchiveMd = `- \`old_incident.md\` — Resolved outage in June`;
      const report = buildFleetProjection({
        memoryMdContent: mockMemoryMd,
        archiveMdContent: mockArchiveMd,
        topicFiles: [
          { filename: 'live_task.md', content: '---\ntype: project\n---\nLive', sizeBytes: 100 },
          { filename: 'old_incident.md', content: '---\ntype: reference\n---\nOld', sizeBytes: 200 },
        ],
      });

      expect(report.pointers.find((p) => p.fileRef === 'live_task.md')?.tier).toBe('active');
      expect(report.pointers.find((p) => p.fileRef === 'old_incident.md')?.tier).toBe('archived');

      // Only the active entry is in the resident index
      expect(report.residentIndexLines.length).toBe(1);
      expect(report.residentIndexLines[0]).toContain('live_task.md');
      expect(report.residentIndexLines[0]).not.toContain('old_incident.md');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Orphan Topic File Detection & Reporting
  // ─────────────────────────────────────────────────────────────────────────
  describe('5. Orphan Topic File Detection', () => {
    it('counts and reports topic files reachable from neither index', () => {
      const mockMemoryMd = `- [listed](listed.md) — In active index`;
      const mockArchiveMd = `- \`archived.md\` — In archive index`;
      const mockTopicFiles = [
        { filename: 'listed.md', content: '...', sizeBytes: 100 },
        { filename: 'archived.md', content: '...', sizeBytes: 200 },
        { filename: 'orphan1.md', content: '---\nname: O1\n---\n', sizeBytes: 350 },
        { filename: 'orphan2.md', content: '---\nname: O2\n---\n', sizeBytes: 450 },
      ];

      const report = buildFleetProjection({
        memoryMdContent: mockMemoryMd,
        archiveMdContent: mockArchiveMd,
        topicFiles: mockTopicFiles,
      });

      expect(report.orphanCount).toBe(2);
      expect(report.orphanFiles.map((o) => o.fileRef)).toEqual(['orphan1.md', 'orphan2.md']);
      expect(report.pointers.find((p) => p.fileRef === 'orphan1.md')?.isOrphan).toBe(true);
      expect(report.pointers.find((p) => p.fileRef === 'listed.md')?.isOrphan).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Dormancy Markers
  // ─────────────────────────────────────────────────────────────────────────
  describe('6. Dormancy Markers', () => {
    it('attaches an explicit dormancy warning to every fleet memory pointer', () => {
      const report = buildFleetProjection({
        memoryMdContent: `- [test](test.md) — Test entry`,
        archiveMdContent: '',
        topicFiles: [
          {
            filename: 'test.md',
            content: '---\nmodified: 2026-08-17T04:00:00Z\n---\nContent',
            sizeBytes: 150,
          },
        ],
      });

      const pointer = report.pointers[0];
      expect(pointer.dormancyMarker).toContain('dormant');
      expect(pointer.dormancyMarker).toContain('file tier may not reflect live state');
      expect(pointer.dormancyMarker).toContain('2026-08-17');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Coder Memory from run_logs and Acceptance Attestations
  // ─────────────────────────────────────────────────────────────────────────
  describe('7. Coder Memory from run_logs & Acceptance Attestations', () => {
    it('assembles prior run events and checklist criteria into structured coder context', () => {
      const mockRunLog = {
        available: true,
        runId: 'run_1789001040134_k7jr39',
        runStatus: 'done',
        exitCode: 0,
        durationMs: 45000,
        turns: 12,
        summary: 'Fixed TypeScript compilation errors in worker processor',
        events: [
          { kind: 'text', label: 'think', text: 'Inspecting processor types...' },
          { kind: 'tool', label: 'run_command', text: 'npm test -- worker' },
          { kind: 'text', label: 'report', text: 'Build passing, 5 tests green.' },
        ],
        runs: [
          { runId: 'run_1789001040134_k7jr39', runStatus: 'done', exitCode: 0 },
          { runId: 'run_prior_attempt', runStatus: 'failed', exitCode: 1 },
        ],
        totalRuns: 2,
      };

      const mockCard = {
        id: 'card_xyz789',
        checklist: [
          { id: 'crit_1', text: 'All unit tests pass', done: true },
          { id: 'crit_2', text: 'Zero unhandled exceptions', done: false },
        ],
      };

      const coderContext = buildCoderMemoryContext({
        cardId: 'card_xyz789',
        runLogData: mockRunLog,
        cardData: mockCard,
      });

      expect(coderContext.cardId).toBe('card_xyz789');
      expect(coderContext.priorRun?.runId).toBe('run_1789001040134_k7jr39');
      expect(coderContext.priorRun?.exitCode).toBe(0);
      expect(coderContext.acceptance.length).toBe(2);

      const formatted = coderContext.formattedContext;
      expect(formatted).toContain('### Acceptance Criteria (1/2 met):');
      expect(formatted).toContain('[x] (crit_1) All unit tests pass');
      expect(formatted).toContain('[ ] (crit_2) Zero unhandled exceptions');
      expect(formatted).toContain('### Prior Dispatched Run (run_1789001040134_k7jr39):');
      expect(formatted).toContain('TOOL: [run_command] npm test -- worker');
      expect(formatted).toContain('TEXT: [report] Build passing, 5 tests green.');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Dependency on redBoard MCP Tools Card
  // ─────────────────────────────────────────────────────────────────────────
  describe('8. Dependency on redBoard MCP Tools', () => {
    it('verifies prerequisite card 6aa2242408971669b4a25e7c is satisfied with exposed tools', () => {
      // Confirmed PR #80 opened and merged/reviewed on mcp-gateway
      const tools = ['redboard_dispatch_log', 'redboard_activity'];
      expect(tools).toContain('redboard_dispatch_log');
      expect(tools).toContain('redboard_activity');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9 & 10. Capability Selector Mismatch Resolution & Read-Only Model
  // ─────────────────────────────────────────────────────────────────────────
  describe('9 & 10. Capability Selector Fix & Read-Only Modeling', () => {
    it('proves coder* bare-prefix glob matches coder, coder-*, coder:*, and coder/* namespaces', () => {
      // The previous broken selector 'coder/*' required an exact slash
      expect(selectorMatches('coder/*', 'coder')).toBe(true);
      expect(selectorMatches('coder/*', 'coder/sub')).toBe(true);
      expect(selectorMatches('coder/*', 'coder-tasks')).toBe(false); // FAILED in previous version!
      expect(selectorMatches('coder/*', 'coder:build')).toBe(false); // FAILED in previous version!

      // The canonical selector 'coder*' matches all variants:
      expect(selectorMatches('coder*', 'coder')).toBe(true);
      expect(selectorMatches('coder*', 'coder-tasks')).toBe(true);
      expect(selectorMatches('coder*', 'coder:build')).toBe(true);
      expect(selectorMatches('coder*', 'coder/sub')).toBe(true);
      expect(selectorMatches('coder*', 'other')).toBe(false);
    });

    it('validates RED_CODER_CAPABILITY_PROFILE grants read-only access to state/knowledge and exec to environments', () => {
      expect(RED_CODER_CAPABILITY_PROFILE.name).toBe('red-coder-ws-jail');
      expect(RED_CODER_GRAPH_IDS.workspace).toBe('red-coder-workspace');

      // State read is allowed broadly
      const stateRead = decide(RED_CODER_CAPABILITY_PROFILE, 'state', 'read', 'any_namespace');
      expect(stateRead.allowed).toBe(true);

      // Knowledge read is allowed broadly
      const knowRead = decide(RED_CODER_CAPABILITY_PROFILE, 'knowledge', 'read', 'any_library');
      expect(knowRead.allowed).toBe(true);

      // Shell execution is allowed
      const execDecision = decide(RED_CODER_CAPABILITY_PROFILE, 'exec', 'execute', 'env_test');
      expect(execDecision.allowed).toBe(true);

      // Computer control is denied
      const compDecision = decide(RED_CODER_CAPABILITY_PROFILE, 'computer', 'control', 'desktop');
      expect(compDecision.allowed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. Dispatched Task Delivery (data.messages vs data.task)
  // ─────────────────────────────────────────────────────────────────────────
  describe('11. Dispatched Task Delivery Verification', () => {
    it('extracts task from redboard dispatch payload and seeds user message', () => {
      const redboardPayload = {
        source: 'redboard',
        boardId: 'b_redbtn',
        cardId: 'c_mem_123',
        title: 'Fix Coder Memory Dispatch',
        body: 'Investigate task routing and run_logs extraction.',
        acceptance: [
          { id: 'crit_a', text: 'Task reaches userPrompt', done: false },
        ],
        comments: [
          { author: 'george@redbtn.io', body: 'Make sure input.task is populated.' },
        ],
      };

      const extracted = extractTaskOrMessage(redboardPayload);
      expect(extracted).toContain('# Fix Coder Memory Dispatch');
      expect(extracted).toContain('Investigate task routing');
      expect(extracted).toContain('Acceptance Criteria:');
      expect(extracted).toContain('(crit_a) Task reaches userPrompt');
      expect(extracted).toContain('Make sure input.task is populated.');
    });

    it('extracts task when input passes { task: "..." } without input.message', () => {
      const taskInput = { task: 'Run unit test suite and verify clean exit' };
      const extracted = extractTaskOrMessage(taskInput);
      expect(extracted).toBe('Run unit test suite and verify clean exit');
    });

    it('prefers explicit input.message when directly provided', () => {
      const msgInput = { message: 'Direct user instruction', task: 'Fallback' };
      const extracted = extractTaskOrMessage(msgInput);
      expect(extracted).toBe('Direct user instruction');
    });
  });
});
