import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { normalizeWorkspaceDirs, emptyStatsResponse, buildStats, summarizeRequests, summarizeRouting } from '../lib/stats.mjs';

test('normalizeWorkspaceDirs converts file URIs, resolves real paths, dedupes, and drops missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-ws-test-'));
  try {
    const ws1 = join(dir, 'ws1');
    const ws2 = join(dir, 'ws2');
    mkdirSync(ws1);
    mkdirSync(ws2);

    const uri1 = pathToFileURL(ws1).href;
    const nonExistent = join(dir, 'does-not-exist');

    const result = normalizeWorkspaceDirs([
      uri1,
      ws1, // duplicate of ws1
      ws2,
      nonExistent,
      '',
      null
    ]);

    assert.equal(result.length, 2);
    assert.ok(result.includes(ws1));
    assert.ok(result.includes(ws2));
    assert.ok(!result.includes(nonExistent));

    assert.deepEqual(normalizeWorkspaceDirs(null), []);
    assert.deepEqual(normalizeWorkspaceDirs('invalid'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emptyStatsResponse returns default structure with warnings', () => {
  const cfg = { defaultWindow: 200000, autocompactThreshold: 0.8 };
  const resp = emptyStatsResponse(cfg, 'conv-123', '/brain/conv-123', 'Log not found');

  assert.equal(resp.conversationId, 'conv-123');
  assert.equal(resp.brainPath, '/brain/conv-123');
  assert.equal(resp.window, 200000);
  assert.equal(resp.autocompact, 0.8);
  assert.equal(resp.total, null);
  assert.equal(resp.free, null);
  assert.deepEqual(resp.sessionTotals, { turns: 0, input: 0, cache: 0, output: 0 });
  assert.deepEqual(resp.routing, {
    isOrchestrator: false,
    currentModel: null,
    currentPhase: null,
    handoffs: { exitPlan: 0, planReview: 0 },
    phases: {
      plan: { turns: 0, input: 0, cache: 0, output: 0 },
      execute: { turns: 0, input: 0, cache: 0, output: 0 }
    },
    byModel: []
  });
  assert.deepEqual(resp.warnings, ['Log not found']);
});

test('buildStats assembles full telemetry with breakdown, window, forecast, and verification', () => {
  const parsed = {
    model: 'Gemini 4 Argon (Medium)',
    requests: [
      { step: 1, context: 10000, output: 100, input: 8000, cache: 2000, contentChars: 400, argsChars: 0 },
      { step: 3, context: 14000, output: 150, input: 1000, cache: 13000, contentChars: 800, argsChars: 0 }
    ],
    userInputs: [
      { step: 0, chars: 400 },
      { step: 2, chars: 400 }
    ],
    toolCalls: []
  };

  const scanned = {
    rules: [{ label: 'workspace: AGENTS.md', tokens: 100 }],
    skills: [{ label: 'test-skill', tokens: 50 }],
    agents: []
  };

  const config = {
    defaultWindow: 1000000,
    windows: {
      'Gemini 4': 1048576
    },
    autocompactThreshold: null
  };

  const meta = {
    conversationId: 'test-conv-abc',
    brainPath: '~/brain/test-conv-abc'
  };

  const stats = buildStats(parsed, scanned, config, meta);

  assert.equal(stats.conversationId, 'test-conv-abc');
  assert.equal(stats.brainPath, '~/brain/test-conv-abc');
  assert.equal(stats.model, 'Gemini 4 Argon (Medium)');
  assert.equal(stats.window, 1048576);
  assert.equal(stats.total, 14000);
  assert.equal(stats.free, 1048576 - 14000);

  assert.deepEqual(stats.lastRequest, {
    step: 3,
    input: 1000,
    cache: 13000,
    output: 150
  });
  assert.deepEqual(stats.sessionTotals, {
    turns: 2,
    input: 9000,
    cache: 15000,
    output: 250
  });

  assert.ok(Array.isArray(stats.categories));
  const catTotal = stats.categories.reduce((sum, c) => sum + c.tokens, 0);
  assert.equal(catTotal, stats.total);

  const rulesCat = stats.categories.find(c => c.id === 'rules');
  assert.ok(rulesCat);
  assert.equal(rulesCat.tokens, 100);

  assert.ok(stats.forecast.next > stats.total);
  assert.equal(stats.verification.samples, 1);
});

test('summarizeRequests ignores empty entries and totals valid requests', () => {
  assert.deepEqual(summarizeRequests(null), { turns: 0, input: 0, cache: 0, output: 0 });
  assert.deepEqual(summarizeRequests([
    null,
    { input: 0, cache: 0, output: 0 },
    { input: 500, cache: 1500, output: 80 },
    { input: -10, cache: 2000, output: NaN }
  ]), {
    turns: 2,
    input: 500,
    cache: 3500,
    output: 80
  });
});

test('summarizeRouting aggregates orchestrator phases, handoffs, models, and fallback model in buildStats', () => {
  const parsed = {
    model: null,
    isOrchestrator: true,
    activePhase: 'execute',
    planReviews: 1,
    requests: [
      { step: 1, context: 3000, output: 150, input: 1000, cache: 2000, contentChars: 200, argsChars: 0 },
      { step: 3, context: 3500, output: 90, input: 500, cache: 3000, contentChars: 100, argsChars: 0 }
    ],
    routingSteps: [
      { step: 1, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: 'exit_plan_mode', input: 1000, cache: 2000, output: 150, context: 3000 },
      { step: 3, model: 'gemini-flash-worker-agy', phase: 'execute', handoff: null, input: 500, cache: 3000, output: 90, context: 3500 }
    ],
    userInputs: [{ step: 0, chars: 100 }],
    toolCalls: []
  };

  const routing = summarizeRouting(parsed);
  assert.equal(routing.isOrchestrator, true);
  assert.equal(routing.currentModel, 'gemini-flash-worker-agy');
  assert.equal(routing.currentPhase, 'execute');
  assert.deepEqual(routing.handoffs, { exitPlan: 1, planReview: 1 });
  assert.deepEqual(routing.phases, {
    plan: { turns: 1, input: 1000, cache: 2000, output: 150 },
    execute: { turns: 1, input: 500, cache: 3000, output: 90 }
  });
  assert.equal(routing.byModel.length, 2);
  assert.equal(routing.byModel[0].model, 'gemini-flash-worker-agy');
  assert.equal(routing.byModel[0].executeTurns, 1);
  assert.equal(routing.byModel[1].model, 'gemini-pro-orchestrator-neon');
  assert.equal(routing.byModel[1].planTurns, 1);

  const stats = buildStats(parsed, { rules: [], skills: [], agents: [] }, { defaultWindow: 524288, windows: {} }, {});
  assert.equal(stats.model, 'gemini-flash-worker-agy');
  assert.deepEqual(stats.routing, routing);
});

test('summarizeRouting preserves explicit activePhase null when switched back to single model after historical orchestrator turns', () => {
  const parsed = {
    model: 'Gemini 4 Neon (High)',
    isOrchestrator: false,
    activePhase: null,
    planReviews: 0,
    routingSteps: [
      { step: 1, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: 'exit_plan_mode', input: 1000, cache: 2000, output: 150, context: 3000 },
      { step: 2, model: 'gemini-flash-worker-agy', phase: 'execute', handoff: null, input: 500, cache: 3000, output: 90, context: 3500 },
      { step: 3, model: 'gemini-4-neon-high', phase: null, handoff: null, input: 700, cache: 3100, output: 110, context: 3800 }
    ]
  };

  const routing = summarizeRouting(parsed);
  assert.equal(routing.isOrchestrator, true);
  assert.equal(routing.currentPhase, null);
  assert.equal(routing.currentModel, 'gemini-4-neon-high');
});
