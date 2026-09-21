// Review-only probes. Uses local fake fetch; makes no external model requests.
// Run with Node 24: node audit/reproduce.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Agent } from '../src/core/agent.ts';
import { createDeepSeekStreamFn } from '../src/core/model/deepseek.ts';

const originalFetch = globalThis.fetch;
const req = { systemPrompt: 'test', messages: [], tools: [] };
const records = [];
const record = (name, evidence) => { records.push({ name, evidence }); console.log(JSON.stringify({ name, evidence })); };
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
async function streamEvents(body) {
  globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  return Array.fromAsync(createDeepSeekStreamFn({ apiKey: 'local-fixture' })(req));
}
const tool = { name: 'probe', label: 'probe', description: 'probe', parameters: {}, async execute() { return { output: 'phone=13812345678' }; } };
function callStream(reason = 'toolCalls') {
  return async function* () {
    yield { type: 'tool_call_start', index: 0, toolCallId: 'probe-id', name: 'probe' };
    yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' };
    yield { type: 'message_end', stopReason: reason };
  };
}
function agent(streamFn, extra = {}) {
  return new Agent({ systemPrompt: 'test', tools: [tool], toolContext: {}, streamFn, maxTurns: 1, ...extra });
}
try {
  const malformed = await streamEvents('data: {broken json}\n\n');
  assert.equal(malformed.at(-1).stopReason, 'stop');
  record('SSE malformed JSON silently succeeds', malformed);

  const truncated = await streamEvents(frame({ content: 'partial answer' }));
  assert.equal(truncated.at(-1).stopReason, 'stop');
  record('SSE EOF without finish_reason silently succeeds', truncated);

  const limited = agent(callStream());
  const limitedEvents = [];
  limited.subscribe(e => limitedEvents.push(e.type));
  const finalText = await limited.prompt('test');
  assert.equal(finalText, '');
  assert.equal(limited.context.at(-1).role, 'toolResult');
  record('maxTurns ends with empty answer and toolResult', { finalText, roles: limited.context.map(m => m.role), events: limitedEvents });

  const lengthAgent = agent(callStream('length'));
  await lengthAgent.prompt('test');
  let followup;
  globalThis.fetch = async (_url, init) => {
    followup = JSON.parse(init.body);
    return new Response(frame({ content: 'ok' }, 'stop') + 'data: [DONE]\n\n');
  };
  await Array.fromAsync(createDeepSeekStreamFn({ apiKey: 'local-fixture' })({ ...req, messages: [...lengthAgent.context, { role: 'user', content: 'next' }] }));
  assert(followup.messages.some(m => m.tool_calls));
  assert(!followup.messages.some(m => m.role === 'tool'));
  record('length with partial tool call leaves unmatched tool_calls in next request', { roles: followup.messages.map(m => m.role), toolCallCount: followup.messages.find(m => m.tool_calls).tool_calls.length });

  let round = 0;
  let nextRequest;
  const hookAgent = agent(async function* (request) {
    if (round++ === 0) yield* callStream()();
    else { nextRequest = request; yield { type: 'message_end', stopReason: 'stop' }; }
  }, { maxTurns: 2, hooks: { afterToolCall() { throw new Error('masking failed'); } } });
  await hookAgent.prompt('test');
  const rawResult = nextRequest.messages.find(m => m.role === 'toolResult');
  assert(rawResult.content.includes('13812345678'));
  record('afterToolCall failure passes raw PII to next model turn', rawResult);

  const beforeAgent = agent(callStream(), { hooks: { beforeToolCall() { throw new Error('before hook failed'); } } });
  await assert.rejects(beforeAgent.prompt('test'), /before hook failed/);
  assert.equal(beforeAgent.context.length, 0);
  record('beforeToolCall exception rejects prompt and loses run messages', { contextLength: beforeAgent.context.length });

  const cli = spawnSync(process.execPath, ['--import', './audit/cli-fixture.mjs', 'src/index.ts'], { cwd: process.cwd(), encoding: 'utf8', input: '检索员工信息\n', timeout: 10000 });
  assert(cli.stdout.includes('Luxshare.DCS.WebApi/Controllers/'), cli.stderr || cli.stdout);
  record('CLI prints real source paths from tool summaries', { sourcePathVisible: true, exitStatus: cli.status });

  const live = spawnSync(process.execPath, ['--import', './audit/live-fixture.mjs', 'test/deepseek-live.ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  assert.equal(live.status, 0, live.stderr);
  assert(live.stderr.includes('模型未发起工具调用'));
  assert(live.stdout.includes('真实 key 单测全部通过'));
  record('live test reports success without any model tool call', { exitStatus: live.status, warning: live.stderr.trim(), successBanner: true });
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`Reproduced ${records.length} review observations (assertions confirm existing behavior, not correctness).`);
