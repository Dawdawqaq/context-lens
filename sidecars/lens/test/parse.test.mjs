import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeArg, MODEL_RE, parseTranscript } from '../lib/parse.mjs';

test('decodeArg unquotes nested JSON strings and primitives', () => {
  assert.equal(decodeArg('"\\"Check log\\""'), 'Check log');
  assert.equal(decodeArg('"Check log"'), 'Check log');
  assert.equal(decodeArg('true'), true);
  assert.equal(decodeArg('false'), false);
  assert.equal(decodeArg('123'), 123);
  assert.deepEqual(decodeArg('{"key":"value"}'), { key: 'value' });
  assert.equal(decodeArg('plain string'), 'plain string');
});

test('MODEL_RE extracts model names from user settings change prompt text', () => {
  const geminiText = 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment...';
  const m1 = geminiText.match(MODEL_RE);
  assert.ok(m1);
  assert.equal(m1[1].trim(), 'Gemini 3.8 Flash (High)');

  const claudeText = 'The user changed setting `Model Selection` from Gemini 3.8 Flash to Claude Opus 5.5 (High).';
  const m2 = claudeText.match(MODEL_RE);
  assert.ok(m2);
  assert.equal(m2[1].trim(), 'Claude Opus 5.5 (High)');
});

test('parseTranscript pairs parallel tool calls with sequential GENERIC output steps', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Hello\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      input_tokens: 15000,
      cache_read_tokens: 2000,
      output_tokens: 120,
      content: 'Running parallel calls',
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: '"/path/to/a.txt"', toolSummary: '"View A"' } },
        { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run tests"' } }
      ]
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Content of a.txt which is 50 chars long...................'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Tests passed 100%'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.model, 'Gemini 3.8 Flash (High)');
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].context, 17000);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].name, 'view_file');
  assert.equal(parsed.toolCalls[0].summary, 'View A');
  assert.equal(parsed.toolCalls[0].outputChars, 'Content of a.txt which is 50 chars long...................'.length);
  assert.equal(parsed.toolCalls[1].name, 'run_command');
  assert.equal(parsed.toolCalls[1].summary, 'Run tests');
  assert.equal(parsed.toolCalls[1].outputChars, 'Tests passed 100%'.length);
});

test('parseTranscript counts both content and thinking in contentChars', () => {
  const line = JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    input_tokens: 100,
    output_tokens: 50,
    content: 'Final reply.',
    thinking: 'Detailed chain of thought.'
  });
  const parsed = parseTranscript(line);
  assert.equal(parsed.requests.length, 1);
  assert.equal(
    parsed.requests[0].contentChars,
    'Final reply.'.length + 'Detailed chain of thought.'.length
  );
});

test('parseTranscript captures step models, exit_plan_mode handoffs, and plan reviews without altering requests', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Implement feature\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Hydrogen (High) to Orchestrator (Neon).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 150,
      content: 'Planning',
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: '"Do work"' } }]
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-flash-worker-agy',
      input_tokens: 500,
      cache_read_tokens: 3000,
      output_tokens: 80,
      content: 'Executing'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content: 'Hidden [plan review due] message'
    }),
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 300,
      cache_read_tokens: 3400,
      output_tokens: 60,
      content: 'Reviewing'
    }),
    JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 200,
      cache_read_tokens: 3500,
      output_tokens: 40,
      content: 'Handing back',
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: '"Continue"' } }]
    }),
    JSON.stringify({
      step_index: 6,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Follow-up question'
    }),
    JSON.stringify({
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 100,
      cache_read_tokens: 3700,
      output_tokens: 50,
      content: 'Answering follow-up'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.model, 'Orchestrator (Neon)');
  assert.equal(parsed.isOrchestrator, true);
  assert.equal(parsed.activePhase, 'plan');
  assert.equal(parsed.planReviews, 1);

  assert.deepEqual(
    parsed.routingSteps.map(s => ({ step: s.step, model: s.model, phase: s.phase, handoff: s.handoff })),
    [
      { step: 1, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: 'exit_plan_mode' },
      { step: 2, model: 'gemini-flash-worker-agy', phase: 'execute', handoff: null },
      { step: 4, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: null },
      { step: 5, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: 'exit_plan_mode' },
      { step: 7, model: 'gemini-pro-orchestrator-neon', phase: 'plan', handoff: null }
    ]
  );

  // Ensure existing requests schema remains untouched
  assert.deepEqual(Object.keys(parsed.requests[1]), [
    'step', 'input', 'cache', 'output', 'context', 'contentChars', 'argsChars'
  ]);
});

test('parseTranscript backfills 2.34.0 custom-orchestrator plan turns on handoff without affecting prior non-orchestrator steps', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Start with Hydrogen'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 500,
      cache_read_tokens: 0,
      output_tokens: 50,
      content: 'Reply'
    }),
    JSON.stringify({
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Orchestrator (Neon) to Gemini 4 Neon (High).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-high',
      input_tokens: 800,
      cache_read_tokens: 0,
      output_tokens: 100,
      content: 'Investigating'
    }),
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-high',
      input_tokens: 200,
      cache_read_tokens: 900,
      output_tokens: 120,
      content: 'Ready',
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: '"Implement"' } }]
    }),
    JSON.stringify({
      step_index: 5,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content: 'Plan mode is off: this turn runs on the execution model.'
    }),
    JSON.stringify({
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-xhigh',
      input_tokens: 1200,
      cache_read_tokens: 0,
      output_tokens: 90,
      content: 'Done'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.isOrchestrator, true);
  assert.equal(parsed.activePhase, 'execute');
  assert.deepEqual(
    parsed.routingSteps.map(s => ({ step: s.step, model: s.model, phase: s.phase, handoff: s.handoff })),
    [
      { step: 1, model: 'gemini-4-hydrogen-high', phase: null, handoff: null },
      { step: 3, model: 'gemini-4-neon-high', phase: 'plan', handoff: null },
      { step: 4, model: 'gemini-4-neon-high', phase: 'plan', handoff: 'exit_plan_mode' },
      { step: 6, model: 'gemini-4-hydrogen-xhigh', phase: 'execute', handoff: null }
    ]
  );
});

test('parseTranscript keeps single-model state when switching from Orchestrator with no handoffs', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'The user changed setting `Model Selection` from Orchestrator (Neon) to Gemini 4 Hydrogen (High).'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 600,
      cache_read_tokens: 0,
      output_tokens: 40,
      content: 'Plain reply'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.isOrchestrator, false);
  assert.equal(parsed.activePhase, null);
  assert.equal(parsed.routingSteps[0].phase, null);
});

test('parseTranscript collects costEvents including CHECKPOINT and tracks lastStepState excluding SYSTEM_MESSAGE', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      type: 'CHECKPOINT',
      created_at: '2026-11-24T08:00:00Z',
      input_tokens: 2000,
      cache_read_tokens: 10000,
      output_tokens: 500,
      content: 'Summary'
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T08:01:00Z',
      model: 'gemini-4-neon-high',
      input_tokens: 100,
      cache_read_tokens: 5000,
      output_tokens: 200,
      content: 'Reply'
    }),
    JSON.stringify({
      step_index: 2,
      type: 'SYSTEM_MESSAGE',
      content: 'Hidden notice'
    })
  ].join('\n');

  const parsed = parseTranscript(sample);
  assert.equal(parsed.costEvents.length, 2);
  assert.equal(parsed.costEvents[0].type, 'CHECKPOINT');
  assert.equal(parsed.costEvents[0].at, '2026-11-24T08:00:00Z');
  assert.equal(parsed.costEvents[1].model, 'gemini-4-neon-high');
  assert.deepEqual(parsed.lastStepState, {
    step: 1,
    type: 'PLANNER_RESPONSE',
    hadTools: false,
    status: 'DONE'
  });
});

