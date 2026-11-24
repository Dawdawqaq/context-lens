import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { computeBreakdown } from './breakdown.mjs';
import { backtest, forecastNext } from './forecast.mjs';
import { resolveWindow } from './cache.mjs';

export function normalizeWorkspaceDirs(workspaceDirs = []) {
  if (!Array.isArray(workspaceDirs)) return [];
  const dirs = [];
  for (const raw of workspaceDirs) {
    if (!raw || typeof raw !== 'string') continue;
    let p = raw.trim();
    if (p.startsWith('file://')) {
      try {
        p = fileURLToPath(p);
      } catch {
        p = p.replace(/^file:\/\/\/?/, '');
      }
    }
    if (p) {
      const resolved = resolve(p);
      if (existsSync(resolved)) {
        dirs.push(resolved);
      }
    }
  }
  return [...new Set(dirs)];
}

export function summarizeRequests(requests = []) {
  let turns = 0;
  let input = 0;
  let cache = 0;
  let output = 0;
  if (!Array.isArray(requests)) return { turns, input, cache, output };
  for (const r of requests) {
    if (!r) continue;
    const reqInput = Number.isFinite(r.input) ? Math.max(0, r.input) : 0;
    const reqCache = Number.isFinite(r.cache) ? Math.max(0, r.cache) : 0;
    const reqOutput = Number.isFinite(r.output) ? Math.max(0, r.output) : 0;
    if (reqInput + reqCache + reqOutput <= 0) continue;
    turns += 1;
    input += reqInput;
    cache += reqCache;
    output += reqOutput;
  }
  return { turns, input, cache, output };
}

export function summarizeRouting(parsed) {
  const steps = Array.isArray(parsed?.routingSteps) ? parsed.routingSteps : [];
  const valid = steps.filter(s => s && ((s.context || 0) > 0 || (s.output || 0) > 0 || s.model || s.handoff));

  let exitPlan = 0;
  const phases = {
    plan: { turns: 0, input: 0, cache: 0, output: 0 },
    execute: { turns: 0, input: 0, cache: 0, output: 0 }
  };
  const modelMap = new Map();

  for (const s of valid) {
    const reqInput = Number.isFinite(s.input) ? Math.max(0, s.input) : 0;
    const reqCache = Number.isFinite(s.cache) ? Math.max(0, s.cache) : 0;
    const reqOutput = Number.isFinite(s.output) ? Math.max(0, s.output) : 0;
    if (s.handoff === 'exit_plan_mode') exitPlan += 1;

    if (s.phase === 'plan' || s.phase === 'execute') {
      const p = phases[s.phase];
      p.turns += 1;
      p.input += reqInput;
      p.cache += reqCache;
      p.output += reqOutput;
    }

    const key = s.model || 'unknown';
    let entry = modelMap.get(key);
    if (!entry) {
      entry = { model: key, turns: 0, input: 0, cache: 0, output: 0, planTurns: 0, executeTurns: 0, lastStep: -1 };
      modelMap.set(key, entry);
    }
    entry.turns += 1;
    entry.input += reqInput;
    entry.cache += reqCache;
    entry.output += reqOutput;
    if (s.phase === 'plan') entry.planTurns += 1;
    if (s.phase === 'execute') entry.executeTurns += 1;
    if (Number.isFinite(s.step) && s.step > entry.lastStep) entry.lastStep = s.step;
  }

  const byModel = [...modelMap.values()].sort((a, b) => b.lastStep - a.lastStep);
  const last = valid.length > 0 ? valid[valid.length - 1] : null;
  let currentModel = last?.model || null;
  if (!currentModel) {
    for (let i = valid.length - 1; i >= 0; i--) {
      if (valid[i].model) {
        currentModel = valid[i].model;
        break;
      }
    }
  }
  const planReview = Number.isFinite(parsed?.planReviews) ? parsed.planReviews : 0;
  const currentPhase = (parsed && Object.prototype.hasOwnProperty.call(parsed, 'activePhase'))
    ? parsed.activePhase
    : (last?.phase || null);
  const isOrchestrator = Boolean(
    parsed?.isOrchestrator ||
    exitPlan > 0 ||
    planReview > 0 ||
    phases.plan.turns > 0 ||
    phases.execute.turns > 0
  );

  return {
    isOrchestrator,
    currentModel,
    currentPhase,
    handoffs: { exitPlan, planReview },
    phases,
    byModel
  };
}

export function emptyStatsResponse(config, conversationId, brainPath, warning) {
  return {
    conversationId: conversationId || null,
    brainPath: brainPath || '',
    model: null,
    window: config?.defaultWindow || 1048576,
    total: null,
    free: null,
    lastRequest: null,
    sessionTotals: { turns: 0, input: 0, cache: 0, output: 0 },
    costs: null,
    routing: {
      isOrchestrator: false,
      currentModel: null,
      currentPhase: null,
      handoffs: { exitPlan: 0, planReview: 0 },
      phases: {
        plan: { turns: 0, input: 0, cache: 0, output: 0 },
        execute: { turns: 0, input: 0, cache: 0, output: 0 }
      },
      byModel: []
    },
    categories: [],
    autocompact: config?.autocompactThreshold ?? null,
    forecast: { next: null, delta: null },
    verification: { forecast: null, actual: null, delta: null, errorPct: null, mape: null, samples: 0 },
    warnings: warning ? [warning] : []
  };
}

export function buildStats(parsed, scanned, config = {}, meta = {}) {
  const breakdown = computeBreakdown(parsed, scanned);
  const routing = summarizeRouting(parsed);
  const resolvedModel = parsed?.model || routing.currentModel || null;
  const modelName = resolvedModel || 'Gemini';
  const defaultWindow = config?.defaultWindow || 1048576;
  const windowTokens = resolveWindow(modelName, config) || defaultWindow;
  const total = breakdown.total;
  const free = total !== null ? Math.max(0, windowTokens - total) : null;

  const validRequests = (parsed?.requests || []).filter(r => r.context > 0);
  const lastReqItem = validRequests.length > 0 ? validRequests[validRequests.length - 1] : null;
  const lastRequest = lastReqItem ? {
    step: lastReqItem.step,
    input: lastReqItem.input,
    cache: lastReqItem.cache,
    output: lastReqItem.output
  } : null;
  const sessionTotals = summarizeRequests(parsed?.requests);

  const forecast = forecastNext(parsed);
  const verification = backtest(parsed);

  return {
    conversationId: meta.conversationId || null,
    brainPath: meta.brainPath || '',
    model: resolvedModel,
    window: windowTokens,
    total,
    free,
    lastRequest,
    sessionTotals,
    costs: meta.costs ?? null,
    routing,
    categories: breakdown.categories,
    autocompact: config?.autocompactThreshold ?? null,
    forecast,
    verification,
    warnings: breakdown.warnings
  };
}
