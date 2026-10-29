import assert from 'node:assert/strict';
import { createOpenAiStreamFn } from '../src/core/model/openai-compatible.ts';
import { dcsTools, inspectDcsSchemaTool } from '../src/dcs/tools.ts';
import { createNavigateDcsMenuTool } from '../src/dcs/navigation-tool.ts';
import type { ToolSchema } from '../src/core/types.ts';

const tools = [...dcsTools, createNavigateDcsMenuTool(async () => { throw new Error('No navigation in test'); })];
const before = structuredClone(tools.map(t => t.parameters));
function freeze(value: unknown) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
tools.forEach(t => freeze(t.parameters));
async function capture(model: string, schemas: ToolSchema[] = tools, toolChoice?: 'auto' | 'required') {
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  try {
    for await (const _ of createOpenAiStreamFn({ model, apiKey: 'test', baseUrl: 'http://test.invalid' })({ systemPrompt: 'test', messages: [], tools: schemas, toolChoice })) { /* serialization only */ }
  } finally { globalThis.fetch = original; }
  assert.ok(body);
  return body;
}
const body = await capture('Qwen3.5-35B');
assert.equal(body.tool_choice, 'auto', 'production default must remain auto');
assert.equal((await capture('Qwen3.5-35B', tools, 'required')).tool_choice, 'required');
assert.equal((await capture('Qwen3.5-35B')).tool_choice, 'auto', 'per-call choice never leaks');
assert.equal(body.tools.length, 7);
for (let i = 0; i < tools.length; i++) {
  const expected: any = structuredClone(before[i]);
  if (tools[i].name === 'inspect_dcs_schema') {
    for (const key of ['objectTypes', 'searchIn', 'objects', 'include']) delete expected.properties[key].uniqueItems;
  }
  assert.deepEqual(body.tools[i].function.parameters, expected, 'only confirmed unsupported keywords are removed');
}
assert.deepEqual(tools.map(t => t.parameters), before, 'original frozen schemas unchanged');
const other = await capture('OtherModel');
assert.deepEqual(other.tools.map((t: any) => t.function.parameters), before, 'other models retain schemas');

// A business field named uniqueItems and data values must not be treated as Schema keywords.
const nested = { type: 'object', properties: {
  uniqueItems: { type: 'boolean' },
  rows: { type: 'array', uniqueItems: true, items: { type: 'array', uniqueItems: true, items: { type: 'string' } } },
}, default: { uniqueItems: true }, enum: [{ uniqueItems: false }],
allOf: [{ if: { properties: { rows: { uniqueItems: true } } }, then: { required: ['rows'] } }] };
const nestedBefore = structuredClone(nested); freeze(nested);
const sent = (await capture('Qwen3.5-35B', [{ name: 'synthetic', description: 'test', parameters: nested }])).tools[0].function.parameters;
assert.deepEqual(sent.properties.uniqueItems, { type: 'boolean' });
assert.deepEqual(sent.default, nested.default); assert.deepEqual(sent.enum, nested.enum);
assert.equal(sent.properties.rows.uniqueItems, undefined);
assert.equal(sent.properties.rows.items.uniqueItems, undefined);
assert.deepEqual(sent.allOf, [{ if: { properties: { rows: {} } }, then: { required: ['rows'] } }]);
assert.deepEqual(nested, nestedBefore);

// Invalid inputs must be rejected before context or database access.
const noContext = new Proxy({} as any, { get() { throw new Error('Validation reached context/database'); } });
for (const args of [
  { operation: 'search', keyword: 'synthetic', objectTypes: ['TABLE', 'TABLE'] },
  { operation: 'search', keyword: 'synthetic', searchIn: ['objectName', 'objectName'] },
  { operation: 'describe', objects: ['SYNTHETIC', 'SYNTHETIC'] },
  { operation: 'definition', objects: ['SYNTHETIC', 'SYNTHETIC'] },
  { operation: 'describe', objects: ['SYNTHETIC'], include: ['columns', 'columns'] },
  { operation: 'search' }, { operation: 'describe' }, { operation: 'definition' },
]) {
  const result = await inspectDcsSchemaTool.execute(args as any, noContext);
  assert.equal(JSON.parse(result.output).status, 'invalid_args', JSON.stringify(args));
}
console.log('PASS: model Schema compatibility, immutable originals, auto default, duplicate/conditional validation');
