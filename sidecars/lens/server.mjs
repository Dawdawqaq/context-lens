import { SidecarApp, Response } from 'sidecar_sdk';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { parseTranscript } from './lib/parse.mjs';
import { getEnabledPlugins, scanRules, scanSkills, scanAgents, redactHomePath } from './lib/scan.mjs';
import { SAFE_CONV_ID_RE, resolveSafeBrainPath } from './lib/paths.mjs';
import { createFileCache, createTtlCache } from './lib/cache.mjs';
import { buildStats, emptyStatsResponse, normalizeWorkspaceDirs } from './lib/stats.mjs';
import {
  getWeekStart,
  isConversationBusy,
  loadCostState,
  saveCostState,
  summarizeSessionCost,
  computeWeeklyCosts
} from './lib/cost.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const costStatePath = join(__dirname, 'cost-state.json');
const app = new SidecarApp();

const fileCache = createFileCache(20);
const ttlCache = createTtlCache(30000, 20);

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;


function loadLensConfig() {
  const cfgPath = join(__dirname, 'lens.config.json');
  if (existsSync(cfgPath)) {
    try {
      return JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch {}
  }
  return {
    defaultWindow: 1048576,
    windows: {
      "Gemini 4": 1048576,
      "Gemini 3.8": 1048576,
      "Gemini 3": 1048576,
      "Gemini 2.5": 1048576,
      "Claude Opus 5.5": 1000000,
      "Claude Opus": 1000000,
      "Claude Sonnet": 200000,
      "Claude Haiku": 200000
    },
    workspaceDirs: [],
    autocompactThreshold: null,
    brainDir: null
  };
}

app.page('/', () => {
  const htmlPath = join(__dirname, 'index.html');
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8') : '<h1>Context Lens</h1>';
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
});

app.api('/api/conversations/recent', () => {
  const config = loadLensConfig();
  const brainBase = config.brainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
  if (!existsSync(brainBase)) return [];

  const recentCacheKey = `recent:${brainBase}`;
  const cachedRecents = ttlCache.get(recentCacheKey);
  if (cachedRecents) return cachedRecents;

  const recents = [];
  try {
    const entries = readdirSync(brainBase, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !SAFE_CONV_ID_RE.test(ent.name)) continue;
      const id = ent.name;
      const bPath = join(brainBase, id);
      const logFull = join(bPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      const logNorm = join(bPath, '.system_generated', 'logs', 'transcript.jsonl');

      let mtimeMs = 0;
      if (existsSync(logFull)) {
        try { mtimeMs = statSync(logFull).mtimeMs; } catch {}
      } else if (existsSync(logNorm)) {
        try { mtimeMs = statSync(logNorm).mtimeMs; } catch {}
      }

      if (mtimeMs > 0) {
        recents.push({ id, mtimeMs, brainPath: redactHomePath(bPath) });
      }
    }
  } catch {}

  recents.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const topRecents = recents.slice(0, 5);
  ttlCache.set(recentCacheKey, topRecents, 3000);
  return topRecents;
}, 'POST');

app.api('/api/context-stats', (data = {}) => {
  const config = loadLensConfig();
  const rawConvId = data.conversationId ? String(data.conversationId).trim() : '';
  if (!rawConvId) {
    return emptyStatsResponse(config, null, '', 'No conversationId provided');
  }

  const brainBase = config.brainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
  const brainPath = resolveSafeBrainPath(brainBase, rawConvId);
  if (!brainPath) {
    return emptyStatsResponse(config, null, '', 'Invalid conversationId format');
  }

  const displayBrainPath = redactHomePath(brainPath);
  const logFull = join(brainPath, '.system_generated', 'logs', 'transcript_full.jsonl');
  const logNorm = join(brainPath, '.system_generated', 'logs', 'transcript.jsonl');
  const activeLogPath = existsSync(logFull) ? logFull : (existsSync(logNorm) ? logNorm : null);

  if (!activeLogPath) {
    return emptyStatsResponse(config, rawConvId, displayBrainPath, 'Conversation log not found on disk');
  }

  let activeLogStat;
  try {
    activeLogStat = statSync(activeLogPath);
  } catch {
    return emptyStatsResponse(config, rawConvId, displayBrainPath, 'Failed reading conversation transcript');
  }
  if (activeLogStat.size > MAX_TRANSCRIPT_BYTES) {
    return emptyStatsResponse(config, rawConvId, displayBrainPath, 'Transcript file exceeds 50MB safety limit');
  }

  let parsed = fileCache.get(activeLogPath);
  if (!parsed) {
    try {
      const text = readFileSync(activeLogPath, 'utf8');
      parsed = parseTranscript(text);
      fileCache.set(activeLogPath, activeLogStat, parsed);
    } catch {
      return emptyStatsResponse(config, rawConvId, displayBrainPath, 'Failed reading conversation transcript');
    }
  }

  const inputWs = Array.isArray(data.workspaceDirs) && data.workspaceDirs.length > 0
    ? data.workspaceDirs
    : (config.workspaceDirs || []);
  const normWorkspaceDirs = normalizeWorkspaceDirs(inputWs);

  const wsKey = normWorkspaceDirs.join('|');
  const ttlKey = `scan:${wsKey}`;
  let scanned = ttlCache.get(ttlKey);
  if (!scanned) {
    const enabledPlugins = getEnabledPlugins();
    const rules = scanRules(enabledPlugins, normWorkspaceDirs);
    const skills = scanSkills(enabledPlugins);
    const agents = scanAgents(enabledPlugins);
    scanned = { rules, skills, agents };
    ttlCache.set(ttlKey, scanned);
  }

  const now = new Date();
  const scheduleStart = getWeekStart(now, config.weeklyReset);
  const costState = loadCostState(costStatePath, scheduleStart.getTime());
  const sessionBusy = isConversationBusy(parsed, activeLogStat.mtimeMs, now.getTime());
  const sessionCost = summarizeSessionCost(parsed, config, costState.sessionResets?.[rawConvId] || null, sessionBusy);

  const weeklyCacheKey = `weekly:${brainBase}`;
  let weeklyCost = data.forceRefresh === true ? null : ttlCache.get(weeklyCacheKey);
  if (!weeklyCost) {
    weeklyCost = computeWeeklyCosts(brainBase, config, costState, {
      fileCache,
      parseTranscript,
      safeConvIdRe: SAFE_CONV_ID_RE,
      maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
      now
    });
    ttlCache.set(weeklyCacheKey, weeklyCost, 15000);
  }

  return buildStats(parsed, scanned, config, {
    conversationId: rawConvId,
    brainPath: displayBrainPath,
    costs: { session: sessionCost, weekly: weeklyCost }
  });
}, 'POST');

app.api('/api/cost-reset', (data = {}) => {
  const scope = data.scope === 'weekly' ? 'weekly' : (data.scope === 'session' ? 'session' : null);
  if (!scope) {
    return { ok: false, error: 'Invalid reset scope' };
  }

  const config = loadLensConfig();
  const brainBase = config.brainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
  const now = new Date();
  const nowMs = now.getTime();
  const scheduleStart = getWeekStart(now, config.weeklyReset);

  if (scope === 'session') {
    const rawConvId = data.conversationId ? String(data.conversationId).trim() : '';
    const brainPath = rawConvId ? resolveSafeBrainPath(brainBase, rawConvId) : null;
    if (!brainPath) {
      return { ok: false, error: 'Invalid conversationId format' };
    }
    const logFull = join(brainPath, '.system_generated', 'logs', 'transcript_full.jsonl');
    const logNorm = join(brainPath, '.system_generated', 'logs', 'transcript.jsonl');
    const activeLogPath = existsSync(logFull) ? logFull : (existsSync(logNorm) ? logNorm : null);
    if (activeLogPath) {
      try {
        const st = statSync(activeLogPath);
        if (nowMs - st.mtimeMs < 10000 && st.size <= MAX_TRANSCRIPT_BYTES) {
          let parsed = fileCache.get(activeLogPath);
          if (!parsed) {
            parsed = parseTranscript(readFileSync(activeLogPath, 'utf8'));
            fileCache.set(activeLogPath, st, parsed);
          }
          if (isConversationBusy(parsed, st.mtimeMs, nowMs)) {
            return { ok: false, busy: true, error: 'Task is currently running' };
          }
        }
      } catch {}
    }
  } else if (existsSync(brainBase)) {
    try {
      const entries = readdirSync(brainBase, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || !SAFE_CONV_ID_RE.test(ent.name)) continue;
        const bPath = join(brainBase, ent.name);
        const logFull = join(bPath, '.system_generated', 'logs', 'transcript_full.jsonl');
        const logNorm = join(bPath, '.system_generated', 'logs', 'transcript.jsonl');
        const logPath = existsSync(logFull) ? logFull : (existsSync(logNorm) ? logNorm : null);
        if (!logPath) continue;
        try {
          const st = statSync(logPath);
          if (nowMs - st.mtimeMs >= 10000 || st.size > MAX_TRANSCRIPT_BYTES) continue;
          let parsed = fileCache.get(logPath);
          if (!parsed) {
            parsed = parseTranscript(readFileSync(logPath, 'utf8'));
            fileCache.set(logPath, st, parsed);
          }
          if (isConversationBusy(parsed, st.mtimeMs, nowMs)) {
            return { ok: false, busy: true, error: 'Task is currently running' };
          }
        } catch {}
      }
    } catch {}
  }

  const validConvIds = new Set();
  if (existsSync(brainBase)) {
    try {
      for (const ent of readdirSync(brainBase, { withFileTypes: true })) {
        if (ent.isDirectory() && SAFE_CONV_ID_RE.test(ent.name)) {
          validConvIds.add(ent.name);
        }
      }
    } catch {}
  }

  const state = loadCostState(costStatePath, scheduleStart.getTime());
  const resetAt = now.toISOString();
  if (scope === 'weekly') {
    state.weeklyResetAt = resetAt;
  } else {
    state.sessionResets[String(data.conversationId).trim()] = resetAt;
  }
  saveCostState(costStatePath, state, {
    validConvIds: validConvIds.size > 0 ? validConvIds : null,
    scheduleWeekStartMs: scheduleStart.getTime()
  });
  ttlCache.clear();
  return { ok: true, scope, resetAt };
}, 'POST');

app.api('/status', () => {
  return { status: 'ok', time: new Date().toISOString() };
}, 'GET');

app.run();
