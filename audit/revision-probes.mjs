// Run: node audit/revision-probes.mjs. Assertions confirm observations, not correctness.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDeepSeekStreamFn } from '../src/core/model/deepseek.ts';
const out = (name, evidence) => console.log(JSON.stringify({ name, evidence }));
function child(mode, entry, input) {
  const r = spawnSync(process.execPath, ['--import', './audit/revision-fixture.mjs', entry], {
    cwd: process.cwd(), env: { ...process.env, REVISION_PROBE: mode }, input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout + r.stderr;
}
const invalid = child('invalid-acceptance', 'test/acceptance-live.ts');
assert(invalid.includes('PASS：三个验收场景全部通过'));
out('R1: acceptance passes despite API errors, wrong permission menu and invalid dataType', { reportedPass: true, invalidDataTypeRecorded: invalid.includes('无效类型') });
const valid = child('valid-acceptance', 'test/acceptance-live.ts');
assert(valid.includes('PASS：三个验收场景全部通过'));
assert(!valid.includes('你缺少系统管理员角色，请联系管理员开通。'));
assert(!valid.includes('订单42元，餐标35元，超出7元被驳回。'));
out('R2: successful acceptance never prints actual replies', { reportedPass: true, repliesMissing: true });
const length = child('length', 'src/index.ts', '查权限\n');
assert(!length.includes('截断'));
assert(length.includes('助手>'));
out('R3: CLI length-only tool response has no visible truncation notice', { stdout: length.trim() });
const args = child('args', 'src/index.ts', '内部检索\n');
assert(args.includes('Luxshare.DCS.WebApi/Controllers/ReviewProbe.cs'));
assert(args.includes('内部检索已完成'));
out('R4: source path still printed via tool call arguments', { pathVisible: true, resultSummaryHidden: true });
const originalFetch = globalThis.fetch;
try {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('data: {broken json}\n\n')); } });
  globalThis.fetch = async () => new Response(body);
  let settled = false;
  const pending = Array.fromAsync(createDeepSeekStreamFn({ apiKey: 'fixture' })({ systemPrompt: '', messages: [], tools: [] })).then(events => { settled = true; return events; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false);
  controller.close();
  const events = await pending;
  assert.equal(events.at(-1).stopReason, 'error');
  out('R5: known bad frame does not return error until another chunk or EOF', { pendingBeforeEOF: true, errorAfterEOF: true });
} finally { globalThis.fetch = originalFetch; }
const cliFixed = spawnSync(process.execPath, ['--import', './audit/cli-fixture.mjs', 'src/index.ts'], { cwd: process.cwd(), input: '检索\n', encoding: 'utf8', timeout: 10000 });
assert.equal(cliFixed.status, 0);
assert(cliFixed.stdout.includes('内部检索已完成'));
assert(!cliFixed.stdout.includes('Luxshare.DCS.WebApi/Controllers/'));
out('PASS: original F5 successful search summary is now hidden', true);
const liveFixed = spawnSync(process.execPath, ['--import', './audit/live-fixture.mjs', 'test/deepseek-live.ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
assert.equal(liveFixed.status, 1);
assert(liveFixed.stdout.includes('FAIL'));
out('PASS: original F4 adapter test now fails when no tools called', true);
