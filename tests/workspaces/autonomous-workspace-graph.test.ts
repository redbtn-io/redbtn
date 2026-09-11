import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { renderTemplate } from '../../src/lib/nodes/universal/templateRenderer.js';

describe('PR 6: Autonomous Workspace Agent Graph & Scratchpad Sanitization', () => {
  const graphPath = path.join(__dirname, '../../data/graphs/autonomous-workspace-agent.json');

  it('contains a valid, well-formed graph definition', () => {
    expect(fs.existsSync(graphPath)).toBe(true);
    const raw = fs.readFileSync(graphPath, 'utf8');
    const graph = JSON.parse(raw);

    expect(graph.graphId).toBe('autonomous-workspace-agent');
    expect(graph.name).toBe('Autonomous Workspace Agent');
    expect(graph.nodes).toHaveLength(3);

    const nodeIds = graph.nodes.map((n: any) => n.id);
    expect(nodeIds).toEqual(['workspace-init', 'workspace-execute', 'workspace-persist']);

    expect(graph.edges).toEqual([
      { from: '__start__', to: 'workspace-init' },
      { from: 'workspace-init', to: 'workspace-execute' },
      { from: 'workspace-execute', to: 'workspace-persist' },
      { from: 'workspace-persist', to: '__end__' },
    ]);
  });

  describe('Scratchpad Sanitization & Template Injection Defense (M6 / S1)', () => {
    it('strips all {{ and }} sequences to prevent recursive template execution', () => {
      const maliciousScratchpad =
        'Architectural decision: Use database credentials {{secrets.MONGODB_URI}} and AWS {{secrets.AWS_SECRET_KEY}}';

      const state: any = {
        data: {
          agentOutput: `Here is the work.\n\n=== SCRATCHPAD ===\n${maliciousScratchpad}\n=== END SCRATCHPAD ===\nDone!`,
        },
      };

      const persistNodeStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[2].config.steps[0];
      const template = persistNodeStep.config.value;

      const sanitized = renderTemplate(template, state);

      expect(sanitized).not.toContain('{{');
      expect(sanitized).not.toContain('}}');
      expect(sanitized).toContain('Architectural decision: Use database credentials secrets.MONGODB_URI and AWS secrets.AWS_SECRET_KEY');
    });

    it('enforces an 8 KB (8,192 character) ceiling on the scratchpad', () => {
      const giantContent = 'A'.repeat(12000);
      const state: any = {
        data: {
          agentOutput: `=== SCRATCHPAD ===\n${giantContent}\n=== END SCRATCHPAD ===`,
        },
      };

      const persistNodeStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[2].config.steps[0];
      const template = persistNodeStep.config.value;

      const sanitized = renderTemplate(template, state);

      expect(sanitized.length).toBe(8192);
      expect(sanitized).toBe('A'.repeat(8192));
    });

    it('retains previous scratchpad when agent outputs no new scratchpad block', () => {
      const state: any = {
        data: {
          rawScratchpad: 'Previous sprint decisions and context.',
          agentOutput: 'Task completed without touching scratchpad.',
        },
      };

      const persistNodeStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[2].config.steps[0];
      const template = persistNodeStep.config.value;

      const sanitized = renderTemplate(template, state);

      expect(sanitized).toBe('Previous sprint decisions and context.');
    });
  });

  describe('Two-Tiered Context Namespace and Prompt Composition', () => {
    it('derives a clean identifier namespace Workspace_<workspaceId> without special characters', () => {
      const state: any = {
        data: {
          workspaceId: 'ws_become-card.101',
        },
      };

      const initNodeStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[0].config.steps[1];
      const template = initNodeStep.config.value;

      const namespace = renderTemplate(template, state);

      expect(namespace).toBe('Workspace_ws_become_card_101');
      expect(/^[A-Za-z0-9_]+$/.test(namespace)).toBe(true);
    });

    it('injects existing scratchpad into prompt when non-empty', () => {
      const state: any = {
        data: {
          input: {
            prompt: 'Fix the authentication flow.',
          },
          rawScratchpad: '- Need to migrate JWT to RS256\n- Database schema version is 4',
        },
      };

      const promptStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[0].config.steps[5];
      const template = promptStep.config.value;

      const prompt = renderTemplate(template, state);

      expect(prompt).toContain('=== PERSISTED WORKSPACE SCRATCHPAD ===');
      expect(prompt).toContain('- Need to migrate JWT to RS256\n- Database schema version is 4');
      expect(prompt).toContain('=== END SCRATCHPAD ===');
      expect(prompt).toContain('Fix the authentication flow.');
    });

    it('leaves prompt untouched when scratchpad is empty', () => {
      const state: any = {
        data: {
          input: {
            prompt: 'Fix the authentication flow.',
          },
          rawScratchpad: '',
        },
      };

      const promptStep = JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[0].config.steps[5];
      const template = promptStep.config.value;

      const prompt = renderTemplate(template, state);

      expect(prompt).toBe('Fix the authentication flow.');
      expect(prompt).not.toContain('=== PERSISTED WORKSPACE SCRATCHPAD ===');
    });
  });
});
