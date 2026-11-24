import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PRICING = {
  'gemini-4-neon': { input: 3.0, cache: 0.15, output: 15.0 },
  'gemini-pro-orchestrator-neon': { input: 3.0, cache: 0.15, output: 15.0 },
  'gemini 4 neon': { input: 3.0, cache: 0.15, output: 15.0 },
  'orchestrator (neon)': { input: 3.0, cache: 0.15, output: 15.0 },
  'gemini-4-hydrogen': { input: 1.5, cache: 0.075, output: 7.5 },
  'gemini-flash-worker': { input: 1.5, cache: 0.075, output: 7.5 },
  'gemini 4 hydrogen': { input: 1.5, cache: 0.075, output: 7.5 },
  'gemini-4-argon': { input: 2.0, cache: 0.10, output: 10.0 },
  'gemini 4 argon': { input: 2.0, cache: 0.10, output: 10.0 },
  'gemini-4-carbon': { input: 2.0, cache: 0.10, output: 10.0 },
  'gemini 4 carbon': { input: 2.0, cache: 0.10, output: 10.0 },
  'gemini 3.8': { input: 0.75, cache: 0.075, output: 3.75 },
  'gemini 3.1 pro': { input: 2.0, cache: 0.20, output: 12.0 },
  'gemini 2.5': { input: 0.10, cache: 0.025, output: 0.40 },
  'claude opus': { input: 15.0, cache: 1.5, output: 75.0 },
  'claude sonnet': { input: 3.0, cache: 0.30, output: 15.0 },
  'claude haiku': { input: 0.80, cache: 0.08, output: 4.0 }
};

const FALLBACK_RATE = { input: 1.5, cache: 0.075, output: 7.5 };

function isValidRate(rate) {
  return rate &&
    typeof rate === 'object' &&
    Number.isFinite(rate.input) &&
    Number.isFinite(rate.cache) &&
    Number.isFinite(rate.output);
}

/**
 * Resolve per-1M-token USD rates by longest case-insensitive substring match.
 */
export function resolvePricing(modelName, pricingMap = DEFAULT_PRICING) {
  const table = pricingMap && typeof pricingMap === 'object' ? pricingMap : DEFAULT_PRICING;
  const fallback = isValidRate(table.default) ? table.default : FALLBACK_RATE;
  if (!modelName || typeof modelName !== 'string') return fallback;

  const norm = modelName.toLowerCase();
  let bestKey = null;
  let bestLen = 0;
  for (const [key, rate] of Object.entries(table)) {
    if (key === 'default' || !isValidRate(rate)) continue;
    const keyNorm = key.toLowerCase();
    if (norm.includes(keyNorm) && keyNorm.length > bestLen) {
      bestLen = keyNorm.length;
      bestKey = key;
    }
  }
  return bestKey ? table[bestKey] : fallback;
}

/**
 * Normalize weeklyReset config and compute the local most-recent boundary <= now.
 */
export function normalizeWeeklyReset(weeklyReset = {}) {
  const rawDay = Number(weeklyReset?.day);
  const rawHour = Number(weeklyReset?.hour);
  const day = Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6 ? rawDay : 1;
  const hour = Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 0;
  return { day, hour };
}

export function getWeekStart(now = new Date(), weeklyReset = {}) {
  const d = new Date(now instanceof Date ? now.getTime() : now);
  const { day, hour } = normalizeWeeklyReset(weeklyReset);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  const diffDays = (d.getDay() - day + 7) % 7;
  start.setDate(start.getDate() - diffDays);
  if (start.getTime() > d.getTime()) {
    start.setDate(start.getDate() - 7);
  }
  return start;
}

/**
 * Sum positive inter-event gaps <= maxGapMs to estimate active interaction duration.
 */
export function computeActiveDurationMs(timestampsMs = [], maxGapMs = 15 * 60 * 1000) {
  if (!Array.isArray(timestampsMs) || timestampsMs.length < 2) return 0;
  const sorted = timestampsMs
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap <= maxGapMs) {
      total += gap;
    }
  }
  return total;
}

/**
 * Aggregate token counts, equivalent USD costs, and active duration for events after sinceMs.
 */
export function aggregateCostEvents(events = [], { sinceMs = null, pricing = DEFAULT_PRICING } = {}) {
  let turns = 0;
  let input = 0;
  let cache = 0;
  let output = 0;
  let cost = 0;
  let noCacheCost = 0;
  let firstAt = null;
  let firstMs = Infinity;
  let lastAt = null;
  let lastMs = -Infinity;
  const timestamps = [];

  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev) continue;
      const ts = ev.at ? Date.parse(ev.at) : NaN;
      if (sinceMs !== null && Number.isFinite(sinceMs)) {
        if (!Number.isFinite(ts) || ts <= sinceMs) continue;
      }

      const evInput = Number.isFinite(ev.input) ? Math.max(0, ev.input) : 0;
      const evCache = Number.isFinite(ev.cache) ? Math.max(0, ev.cache) : 0;
      const evOutput = Number.isFinite(ev.output) ? Math.max(0, ev.output) : 0;
      if (evInput + evCache + evOutput <= 0) continue;

      const rate = resolvePricing(ev.model, pricing);
      cost += (evInput * rate.input + evCache * rate.cache + evOutput * rate.output) / 1e6;
      noCacheCost += ((evInput + evCache) * rate.input + evOutput * rate.output) / 1e6;

      turns += 1;
      input += evInput;
      cache += evCache;
      output += evOutput;

      if (Number.isFinite(ts)) {
        timestamps.push(ts);
        if (ts < firstMs) {
          firstMs = ts;
          firstAt = ev.at;
        }
        if (ts > lastMs) {
          lastMs = ts;
          lastAt = ev.at;
        }
      }
    }
  }

  return {
    turns,
    input,
    cache,
    output,
    cost,
    noCacheCost,
    saved: Math.max(0, noCacheCost - cost),
    firstAt,
    lastAt,
    activeMs: computeActiveDurationMs(timestamps)
  };
}

/**
 * Determine whether a conversation looks actively mid-turn (recent file write + unfinished step).
 */
export function isConversationBusy(parsed, mtimeMs, nowMs = Date.now()) {
  if (!Number.isFinite(mtimeMs) || (nowMs - mtimeMs) >= 10000) return false;
  const st = parsed?.lastStepState;
  if (!st) return false;
  return Boolean(st.type !== 'PLANNER_RESPONSE' || st.hadTools || (st.status && st.status !== 'DONE'));
}

export function loadCostState(statePath, scheduleWeekStartMs = null) {
  const empty = { weeklyResetAt: null, sessionResets: {} };
  if (!statePath || !existsSync(statePath)) return empty;
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    let weeklyResetAt = typeof raw?.weeklyResetAt === 'string' ? raw.weeklyResetAt : null;
    if (weeklyResetAt) {
      const wMs = Date.parse(weeklyResetAt);
      if (!Number.isFinite(wMs) || (Number.isFinite(scheduleWeekStartMs) && wMs <= scheduleWeekStartMs)) {
        weeklyResetAt = null;
      }
    }
    const sessionResets = {};
    if (raw?.sessionResets && typeof raw.sessionResets === 'object') {
      for (const [k, v] of Object.entries(raw.sessionResets)) {
        if (typeof v === 'string' && Number.isFinite(Date.parse(v))) {
          sessionResets[k] = v;
        }
      }
    }
    return { weeklyResetAt, sessionResets };
  } catch {
    return empty;
  }
}

export function saveCostState(statePath, state, { validConvIds = null, scheduleWeekStartMs = null } = {}) {
  let weeklyResetAt = typeof state?.weeklyResetAt === 'string' ? state.weeklyResetAt : null;
  if (weeklyResetAt) {
    const wMs = Date.parse(weeklyResetAt);
    if (!Number.isFinite(wMs) || (Number.isFinite(scheduleWeekStartMs) && wMs <= scheduleWeekStartMs)) {
      weeklyResetAt = null;
    }
  }
  const sessionResets = {};
  if (state?.sessionResets && typeof state.sessionResets === 'object') {
    for (const [id, iso] of Object.entries(state.sessionResets)) {
      if (validConvIds && !validConvIds.has(id)) continue;
      if (typeof iso === 'string' && Number.isFinite(Date.parse(iso))) {
        sessionResets[id] = iso;
      }
    }
  }
  const payload = { weeklyResetAt, sessionResets };
  writeFileSync(statePath, JSON.stringify(payload), 'utf8');
  return payload;
}

export function summarizeSessionCost(parsed, config = {}, sessionResetAt = null, isBusy = false) {
  const parsedResetMs = sessionResetAt ? Date.parse(sessionResetAt) : NaN;
  const hasReset = Number.isFinite(parsedResetMs);
  const sinceMs = hasReset ? parsedResetMs : null;
  const agg = aggregateCostEvents(parsed?.costEvents || [], {
    sinceMs,
    pricing: config?.pricing || DEFAULT_PRICING
  });
  return {
    ...agg,
    sinceAt: hasReset ? sessionResetAt : agg.firstAt,
    resetAt: hasReset ? sessionResetAt : null,
    isBusy
  };
}

export function computeWeeklyCosts(
  brainBase,
  config = {},
  state = {},
  { fileCache, parseTranscript, safeConvIdRe, maxTranscriptBytes = 50 * 1024 * 1024, now = new Date() }
) {
  const weeklyReset = normalizeWeeklyReset(config?.weeklyReset);
  const scheduleWeekStart = getWeekStart(now, weeklyReset);
  const scheduleMs = scheduleWeekStart.getTime();
  const manualMs = state?.weeklyResetAt ? Date.parse(state.weeklyResetAt) : NaN;
  const isManualReset = Number.isFinite(manualMs) && manualMs > scheduleMs;
  const effectiveStartMs = isManualReset ? manualMs : scheduleMs;

  let turns = 0;
  let input = 0;
  let cache = 0;
  let output = 0;
  let cost = 0;
  let noCacheCost = 0;
  let sessions = 0;
  let activeMs = 0;
  let anyBusy = false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (brainBase && existsSync(brainBase)) {
    let entries = [];
    try {
      entries = readdirSync(brainBase, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (safeConvIdRe && !safeConvIdRe.test(ent.name)) continue;

      const bPath = join(brainBase, ent.name);
      const logFull = join(bPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      const logNorm = join(bPath, '.system_generated', 'logs', 'transcript.jsonl');
      const activeLogPath = existsSync(logFull) ? logFull : (existsSync(logNorm) ? logNorm : null);
      if (!activeLogPath) continue;

      let st;
      try {
        st = statSync(activeLogPath);
      } catch {
        continue;
      }
      if (st.mtimeMs <= effectiveStartMs || st.size > maxTranscriptBytes) continue;

      let parsed = fileCache ? fileCache.get(activeLogPath) : null;
      if (!parsed) {
        try {
          parsed = parseTranscript(readFileSync(activeLogPath, 'utf8'));
          if (fileCache) fileCache.set(activeLogPath, st, parsed);
        } catch {
          continue;
        }
      }

      if (isConversationBusy(parsed, st.mtimeMs, nowMs)) {
        anyBusy = true;
      }

      const agg = aggregateCostEvents(parsed?.costEvents || [], {
        sinceMs: effectiveStartMs,
        pricing: config?.pricing || DEFAULT_PRICING
      });
      if (agg.turns > 0) {
        sessions += 1;
        turns += agg.turns;
        input += agg.input;
        cache += agg.cache;
        output += agg.output;
        cost += agg.cost;
        noCacheCost += agg.noCacheCost;
        activeMs += agg.activeMs;
      }
    }
  }

  return {
    cost,
    saved: Math.max(0, noCacheCost - cost),
    input,
    cache,
    output,
    turns,
    sessions,
    activeMs,
    sinceAt: new Date(effectiveStartMs).toISOString(),
    isManualReset,
    nextResetAt: new Date(scheduleMs + 7 * 86400 * 1000).toISOString(),
    weeklyReset,
    isBusy: anyBusy
  };
}
