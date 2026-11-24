import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_PRICING,
  resolvePricing,
  getWeekStart,
  computeActiveDurationMs,
  aggregateCostEvents,
  isConversationBusy,
  loadCostState,
  saveCostState,
  summarizeSessionCost,
  computeWeeklyCosts
} from '../lib/cost.mjs';
import { parseTranscript } from '../lib/parse.mjs';
import { createFileCache } from '../lib/cache.mjs';
import { SAFE_CONV_ID_RE } from '../lib/paths.mjs';

test('resolvePricing selects longest substring match and falls back cleanly', () => {
  assert.deepEqual(resolvePricing('gemini-4-neon-high', DEFAULT_PRICING), { input: 3.0, cache: 0.15, output: 15.0 });
  assert.deepEqual(resolvePricing('gemini-4-hydrogen-xhigh', DEFAULT_PRICING), { input: 1.5, cache: 0.075, output: 7.5 });
  assert.deepEqual(resolvePricing('gemini-flash-worker-agy', DEFAULT_PRICING), { input: 1.5, cache: 0.075, output: 7.5 });
  assert.deepEqual(resolvePricing('unknown-model', DEFAULT_PRICING), { input: 1.5, cache: 0.075, output: 7.5 });
  assert.deepEqual(resolvePricing('unknown-model', { default: { input: 9, cache: 1, output: 20 } }), { input: 9, cache: 1, output: 20 });
});

test('getWeekStart rolls back cleanly to local weekly boundary', () => {
  // 2026-11-24 is Tuesday
  const tue = new Date(2026, 10, 24, 15, 30, 0, 0);
  const monStart = getWeekStart(tue, { day: 1, hour: 0 });
  assert.equal(monStart.getFullYear(), 2026);
  assert.equal(monStart.getMonth(), 10);
  assert.equal(monStart.getDate(), 23);
  assert.equal(monStart.getDay(), 1);
  assert.equal(monStart.getHours(), 0);

  // Sunday before Monday reset falls back to previous Monday
  const sun = new Date(2026, 10, 22, 23, 59, 0, 0);
  const prevMon = getWeekStart(sun, { day: 1, hour: 0 });
  assert.equal(prevMon.getDate(), 16);

  // Same day before reset hour falls back 7 days
  const monEarly = new Date(2026, 10, 23, 5, 0, 0, 0);
  const customHour = getWeekStart(monEarly, { day: 1, hour: 8 });
  assert.equal(customHour.getDate(), 16);
  assert.equal(customHour.getHours(), 8);
});

test('computeActiveDurationMs sums continuous gaps and ignores idle breaks', () => {
  const t0 = Date.parse('2026-11-24T10:00:00Z');
  const t1 = t0 + 2 * 60 * 1000;
  const t2 = t1 + 5 * 60 * 1000;
  const t3 = t2 + 45 * 60 * 1000; // >15m break ignored
  const t4 = t3 + 3 * 60 * 1000;
  assert.equal(computeActiveDurationMs([t2, t0, t4, t1, t3]), 10 * 60 * 1000);
  assert.equal(computeActiveDurationMs([t0]), 0);
});

test('aggregateCostEvents filters by sinceMs and computes equivalent cost and cache savings', () => {
  const events = [
    { step: 1, at: '2026-11-24T09:00:00Z', model: 'gemini-4-neon-high', input: 1_000_000, cache: 0, output: 100_000 },
    { step: 2, at: '2026-11-24T10:00:00Z', model: 'gemini-4-neon-high', input: 500_000, cache: 1_000_000, output: 100_000 },
    { step: 3, at: '2026-11-24T10:05:00Z', model: 'gemini-4-hydrogen-xhigh', input: 1_000_000, cache: 0, output: 0 }
  ];

  const all = aggregateCostEvents(events);
  assert.equal(all.turns, 3);
  // Step 1: 3 + 1.5 = 4.5
  // Step 2: 1.5 + 0.15 + 1.5 = 3.15 (noCache: 4.5 + 1.5 = 6.0, saved: 2.85)
  // Step 3: 1.5
  assert.ok(Math.abs(all.cost - 9.15) < 1e-9);
  assert.ok(Math.abs(all.saved - 2.85) < 1e-9);
  assert.equal(all.activeMs, 5 * 60 * 1000);

  const after = aggregateCostEvents(events, { sinceMs: Date.parse('2026-11-24T09:30:00Z') });
  assert.equal(after.turns, 2);
  assert.ok(Math.abs(after.cost - 4.65) < 1e-9);
});

test('isConversationBusy detects active recent runs and clears on idle DONE responses', () => {
  const nowMs = 1_000_000;
  assert.equal(isConversationBusy({ lastStepState: { type: 'PLANNER_RESPONSE', hadTools: true, status: 'DONE' } }, nowMs - 2000, nowMs), true);
  assert.equal(isConversationBusy({ lastStepState: { type: 'GENERIC', hadTools: false, status: 'DONE' } }, nowMs - 2000, nowMs), true);
  assert.equal(isConversationBusy({ lastStepState: { type: 'PLANNER_RESPONSE', hadTools: false, status: 'RUNNING' } }, nowMs - 2000, nowMs), true);
  assert.equal(isConversationBusy({ lastStepState: { type: 'PLANNER_RESPONSE', hadTools: false, status: 'DONE' } }, nowMs - 2000, nowMs), false);
  assert.equal(isConversationBusy({ lastStepState: { type: 'GENERIC', hadTools: false, status: 'DONE' } }, nowMs - 15000, nowMs), false);
});

test('loadCostState and saveCostState expire stale weekly resets and prune deleted sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-cost-state-'));
  try {
    const statePath = join(dir, 'cost-state.json');
    const weekStartMs = Date.parse('2026-11-23T00:00:00');
    saveCostState(statePath, {
      weeklyResetAt: '2026-11-22T12:00:00Z',
      sessionResets: {
        'conv-alive': '2026-11-24T08:00:00Z',
        'conv-gone': '2026-11-24T08:00:00Z',
        'conv-bad': 'not-a-date'
      }
    }, { validConvIds: new Set(['conv-alive']), scheduleWeekStartMs: weekStartMs });

    const loaded = loadCostState(statePath, weekStartMs);
    assert.equal(loaded.weeklyResetAt, null);
    assert.deepEqual(loaded.sessionResets, { 'conv-alive': '2026-11-24T08:00:00Z' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeWeeklyCosts scans active week transcripts, skips old ones, and respects manual weekly reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-weekly-'));
  try {
    const oldId = '11111111-1111-1111-1111-111111111111';
    const curId = '22222222-2222-2222-2222-222222222222';
    const oldLogs = join(dir, oldId, '.system_generated', 'logs');
    const curLogs = join(dir, curId, '.system_generated', 'logs');
    mkdirSync(oldLogs, { recursive: true });
    mkdirSync(curLogs, { recursive: true });

    const oldLogPath = join(oldLogs, 'transcript.jsonl');
    writeFileSync(oldLogPath, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-18T10:00:00Z',
      model: 'gemini-4-neon-high',
      input_tokens: 1_000_000,
      cache_read_tokens: 0,
      output_tokens: 0
    }) + '\n');
    const oldTime = new Date(2026, 10, 18, 10, 0, 0);
    utimesSync(oldLogPath, oldTime, oldTime);

    const curLogPath = join(curLogs, 'transcript.jsonl');
    writeFileSync(curLogPath, [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(2026, 10, 23, 10, 0, 0).toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        output_tokens: 0
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(2026, 10, 24, 10, 0, 0).toISOString(),
        model: 'gemini-4-hydrogen-xhigh',
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        output_tokens: 0
      })
    ].join('\n') + '\n');
    const curTime = new Date(2026, 10, 24, 10, 0, 0);
    utimesSync(curLogPath, curTime, curTime);

    const now = new Date(2026, 10, 24, 16, 0, 0);
    const cache = createFileCache(10);

    const w1 = computeWeeklyCosts(dir, { weeklyReset: { day: 1, hour: 0 } }, {}, {
      fileCache: cache,
      parseTranscript,
      safeConvIdRe: SAFE_CONV_ID_RE,
      now
    });
    assert.equal(w1.sessions, 1);
    assert.equal(w1.turns, 2);
    assert.ok(Math.abs(w1.cost - 4.5) < 1e-9);
    assert.equal(w1.isManualReset, false);

    // Manual reset after step 1 leaves only step 2
    const resetAt = new Date(2026, 10, 24, 0, 0, 0).toISOString();
    const w2 = computeWeeklyCosts(dir, { weeklyReset: { day: 1, hour: 0 } }, { weeklyResetAt: resetAt }, {
      fileCache: cache,
      parseTranscript,
      safeConvIdRe: SAFE_CONV_ID_RE,
      now
    });
    assert.equal(w2.sessions, 1);
    assert.equal(w2.turns, 1);
    assert.ok(Math.abs(w2.cost - 1.5) < 1e-9);
    assert.equal(w2.isManualReset, true);
    assert.equal(w2.sinceAt, resetAt);

    // Session summary reflects resetAt when provided
    const parsedCur = parseTranscript(
      `${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(2026, 10, 23, 10, 0, 0).toISOString(), model: 'gemini-4-neon-high', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 })}\n` +
      `${JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: new Date(2026, 10, 24, 10, 0, 0).toISOString(), model: 'gemini-4-hydrogen-xhigh', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 })}`
    );
    const sReset = summarizeSessionCost(parsedCur, {}, resetAt, false);
    assert.equal(sReset.turns, 1);
    assert.ok(Math.abs(sReset.cost - 1.5) < 1e-9);
    assert.equal(sReset.sinceAt, resetAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
