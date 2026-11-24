function isJsonLike(t) {
  if (!t) return false;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === '"' && last === '"') || (first === '{' && last === '}') || (first === '[' && last === ']')) {
    return true;
  }
  if (t === 'true' || t === 'false') return true;
  return /^-?\d+(\.\d+)?$/.test(t);
}

// Decode values the transcript stores JSON-encoded, e.g. "\"Check log\"" -> "Check log".
export function decodeArg(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.length > 65536) return v;
  if (isJsonLike(t)) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') {
        const t2 = parsed.trim();
        if (/^["{[]/.test(t2) && isJsonLike(t2)) {
          try { return JSON.parse(t2); } catch { return parsed; }
        }
      }
      return parsed;
    } catch {
      return v;
    }
  }
  return v;
}

export const MODEL_RE = /changed setting `Model Selection` from .+? to (.+?)\.(?=\s*(?:[A-Z]|<|\n|$))/;

export function parseTranscript(text) {
  const rawSteps = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rawSteps.push(JSON.parse(line)); } catch { /* ignore partial trailing line */ }
  }
  const steps = [], requests = [], userInputs = [], toolCalls = [], routingSteps = [], costEvents = [];
  let lastCheckpoint = -1, checkpointChars = 0, model = null, pending = [];
  let isOrchestrator = false, currentPhase = null, planReviews = 0, lastNonOrchSettingStep = -1;
  let lastStepState = null;

  for (const s of rawSteps) {
    const content = typeof s.content === 'string' ? s.content : '';
    steps.push({ step_index: s.step_index, type: s.type });
    if (s.type && s.type !== 'SYSTEM_MESSAGE') {
      lastStepState = {
        step: s.step_index,
        type: s.type,
        hadTools: s.type === 'PLANNER_RESPONSE' && Array.isArray(s.tool_calls) && s.tool_calls.length > 0,
        status: typeof s.status === 'string' ? s.status : null
      };
    }

    if (s.type === 'USER_INPUT') {
      userInputs.push({ step: s.step_index, chars: content.length });
      let modelChanged = false;
      if (content.includes('changed setting `Model Selection`')) {
        const m = content.match(MODEL_RE);
        if (m) {
          model = m[1].trim();
          isOrchestrator = /\borchestrator\b/i.test(model);
          currentPhase = isOrchestrator ? 'plan' : null;
          if (!isOrchestrator) lastNonOrchSettingStep = s.step_index;
          modelChanged = true;
        }
      }
      if (!modelChanged && isOrchestrator) {
        currentPhase = 'plan';
      }
    } else if (s.type === 'SYSTEM_MESSAGE') {
      if (content.includes('[plan review]') || content.includes('[plan review due]')) {
        isOrchestrator = true;
        currentPhase = 'plan';
        planReviews += 1;
      } else if (content.includes('Plan mode is off: this turn runs on the execution model')) {
        isOrchestrator = true;
        currentPhase = 'execute';
      }
    } else if (s.type === 'CHECKPOINT') {
      lastCheckpoint = s.step_index;
      checkpointChars = content.length;
      const cpInput = s.input_tokens ?? 0;
      const cpCache = s.cache_read_tokens ?? 0;
      const cpOutput = s.output_tokens ?? 0;
      if (cpInput + cpCache + cpOutput > 0) {
        costEvents.push({
          step: s.step_index,
          type: 'CHECKPOINT',
          at: typeof s.created_at === 'string' ? s.created_at : null,
          model: (typeof s.model === 'string' && s.model.trim()) ? s.model.trim() : (model || null),
          input: cpInput,
          cache: cpCache,
          output: cpOutput
        });
      }
    } else if (s.type === 'PLANNER_RESPONSE') {
      const input = s.input_tokens ?? 0;
      const cache = s.cache_read_tokens ?? 0;
      const output = s.output_tokens ?? 0;
      const thinking = typeof s.thinking === 'string' ? s.thinking : '';
      const stepModel = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : null;
      const calls = (s.tool_calls ?? []).map(tc => {
        const args = Object.fromEntries(
          Object.entries(tc.args ?? {}).map(([k, v]) => [k, decodeArg(v)])
        );
        return {
          step: s.step_index,
          name: tc.name,
          summary: String(args.toolSummary || args.toolAction || tc.name),
          argsChars: JSON.stringify(args).length,
          outputChars: 0
        };
      });
      const hasExitPlan = calls.some(c => c.name === 'exit_plan_mode');
      const hasEnterPlan = calls.some(c => c.name === 'enter_plan_mode');
      if (!isOrchestrator && ((stepModel && /orchestrator/i.test(stepModel)) || hasExitPlan || hasEnterPlan)) {
        isOrchestrator = true;
        currentPhase = hasEnterPlan ? 'execute' : 'plan';
        const backfillFrom = lastNonOrchSettingStep >= 0 ? lastNonOrchSettingStep : -1;
        for (const prev of routingSteps) {
          if (prev.step > backfillFrom && prev.phase === null) {
            prev.phase = 'plan';
          }
        }
      }
      toolCalls.push(...calls);
      pending = [...calls];
      requests.push({
        step: s.step_index,
        input,
        cache,
        output,
        context: input + cache,
        contentChars: content.length + thinking.length,
        argsChars: calls.reduce((sum, c) => sum + c.argsChars, 0)
      });
      if (input + cache + output > 0) {
        costEvents.push({
          step: s.step_index,
          type: 'PLANNER_RESPONSE',
          at: typeof s.created_at === 'string' ? s.created_at : null,
          model: stepModel || model || null,
          input,
          cache,
          output
        });
      }
      routingSteps.push({
        step: s.step_index,
        model: stepModel,
        phase: isOrchestrator ? (currentPhase || 'plan') : null,
        handoff: hasExitPlan ? 'exit_plan_mode' : (hasEnterPlan ? 'enter_plan_mode' : null),
        input,
        cache,
        output,
        context: input + cache
      });
      if (hasExitPlan) {
        isOrchestrator = true;
        currentPhase = 'execute';
      } else if (hasEnterPlan) {
        isOrchestrator = true;
        currentPhase = 'plan';
      }
    } else if (s.type === 'GENERIC') {
      const call = pending.shift();
      if (call) call.outputChars = content.length;
    }
  }
  return { steps, requests, userInputs, toolCalls, lastCheckpoint, checkpointChars, model, routingSteps, isOrchestrator, activePhase: currentPhase, planReviews, costEvents, lastStepState };
}
