/** Offline regression: the real Agent/Loop with synthetic source results, never a database/model. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentOptions } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { AgentMessage, ModelStreamEvent, StreamFn, ToolDefinition, ToolOutput } from "../src/core/types.ts";
import { prepareEvidenceRun } from "../src/dcs/evidence.ts";

type Request = Parameters<StreamFn>[0];
interface Plan {
  text?: string;
  calls?: readonly { name: string; args?: object }[];
  end?: "stop" | "toolCalls" | "error" | "length" | "interrupted";
  afterText?: () => void;
  throws?: boolean;
}
const sourceResult: ToolOutput = { output: JSON.stringify({ files: [{ path: "Controllers/Example.cs", status: "success", lines: [{ line: 7, text: "return items.Where(x => x.Visible);" }] }] }) };
const pathsResult: ToolOutput = { output: JSON.stringify({ status: "success", items: [{ path: "Controllers/Example.cs", kind: "source" }] }) };
const emptyResult: ToolOutput = { output: JSON.stringify({ status: "empty", items: [] }) };
const refusal = "本次未能取得可核实的源码内容，暂时无法确认该功能的实际规则。";
const feedback = "本次尚未取得可核实的源码内容。文件路径和业务索引不等于源码证据。请继续搜索或读取实际源码；无法取得时不得编造业务结论。";
const readCall = { name: "read_dcs_code", args: { files: [{ path: "Controllers/Example.cs" }] } };
const searchCall = { name: "search_dcs_code", args: { mode: "files", pattern: "Example.cs" } };

function fake(plans: Plan[]) {
  const requests: Request[] = [];
  const streamFn: StreamFn = async function* (request): AsyncGenerator<ModelStreamEvent> {
    requests.push(structuredClone(request));
    const no = requests.length;
    const plan = plans[no - 1];
    assert.ok(plan, `unexpected model request ${no}`);
    if (plan.text) yield { type: "text_delta", text: plan.text };
    plan.afterText?.();
    if (plan.throws) throw new Error("synthetic stream failure");
    for (const [index, call] of (plan.calls ?? []).entries()) {
      yield { type: "tool_call_start", index, toolCallId: `call_${no}_${index}`, name: call.name };
      yield { type: "tool_call_delta", index, argumentsDelta: JSON.stringify(call.args ?? {}) };
    }
    if (plan.end === "interrupted") return;
    yield { type: "message_end", stopReason: plan.end ?? (plan.calls?.length ? "toolCalls" : "stop"), errorMessage: plan.end === "error" ? "synthetic model failure" : undefined };
  };
  return { streamFn, requests };
}

function fixtureTools(readResults: ToolOutput[] = [sourceResult], searchResults: ToolOutput[] = [pathsResult]) {
  const executed: string[] = [];
  function tool(name: string, results: ToolOutput[]): ToolDefinition {
    let index = 0;
    return {
      name, label: name, description: "Synthetic offline test tool", parameters: { type: "object", properties: {} },
      async execute() {
        executed.push(name);
        return results[Math.min(index++, results.length - 1)] ?? emptyResult;
      },
    };
  }
  return { tools: [tool("search_dcs_code", searchResults), tool("read_dcs_code", readResults), tool("authorized_other", [{ output: "other result" }])], executed };
}

function build(plans: Plan[], options: Partial<AgentOptions> = {}, fixture = fixtureTools()) {
  const model = fake(plans);
  const tools = options.tools ?? fixture.tools;
  const agent = new Agent({
    systemPrompt: "Synthetic base prompt", tools, toolContext: {}, streamFn: model.streamFn,
    maxTurns: 8, prepareRun: (text) => prepareEvidenceRun(text, tools), ...options,
  });
  const events: AgentEvent[] = [];
  agent.subscribe(event => events.push(structuredClone(event)));
  return { agent, events, ...model, ...fixture };
}

function displayed(events: AgentEvent[]) {
  return events.flatMap(event => event.type === "message_delta" ? [event.text] : event.type === "assistant_message" ? [event.message.content] : [] ).join("\n");
}
function paired(messages: AgentMessage[]) {
  const calls = messages.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []);
  const results = messages.filter(message => message.role === "toolResult");
  assert.deepEqual(calls.map(call => call.id), results.map(result => result.toolCallId));
}
function choices(requests: Request[]) { return requests.map(request => request.toolChoice ?? "auto"); }
function runEnd(events: AgentEvent[]) {
  const event = [...events].reverse().find(event => event.type === "run_end");
  assert.ok(event && event.type === "run_end");
  return event;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const previousSourceRoot = process.env.DCS_SOURCE_ROOT;
const syntheticRoot = await mkdtemp(path.join(os.tmpdir(), "dcs-evidence-loop-"));
process.env.DCS_SOURCE_ROOT = syntheticRoot;
try {
  await test("ordinary input keeps auto and emits text during streaming", async () => {
    let observed = false;
    const f = build([{ text: "ordinary reply", afterText: () => { observed = f.events.some(event => event.type === "message_delta" && event.text === "ordinary reply"); } }]);
    assert.equal(await f.agent.prompt("你好"), "ordinary reply");
    assert.equal(observed, true);
    assert.deepEqual(choices(f.requests), ["auto"]);
    assert.equal(f.requests[0].systemPrompt, "Synthetic base prompt");
    assert.equal(f.requests[0].tools.length, 3);
  });

  await test("first required offers source tools only; subsequent auto restores tools and releases only final text", async () => {
    const f = build([{ text: "unverified intermediate claim", calls: [readCall] }, { text: "final answer based on returned source" }]);
    assert.equal(await f.agent.prompt("/查源码 合成模块如何筛选？"), "final answer based on returned source");
    assert.deepEqual(choices(f.requests), ["required", "auto"]);
    assert.deepEqual(f.requests[0].tools.map(tool => tool.name), ["search_dcs_code", "read_dcs_code"]);
    assert.equal(f.requests[1].tools.length, 3);
    assert.equal(f.requests[0].messages.at(-1)?.content, "合成模块如何筛选？");
    assert.equal(f.events.some(event => event.type === "message_delta"), false);
    assert.equal(displayed(f.events).includes("unverified intermediate claim"), false);
    assert.equal(JSON.stringify(f.agent.context).includes("unverified intermediate claim"), false);
    assert.equal(JSON.stringify(f.requests[1].messages).includes("unverified intermediate claim"), false);
    assert.equal(f.events.some(event => event.type === "tool_execution_start"), true);
    assert.equal(f.events.some(event => event.type === "tool_execution_end"), true);
    paired(f.agent.context);
    assert.equal(runEnd(f.events).status, "completed");
  });

  await test("empty slash command and unavailable source tools never request a model", async () => {
    const command = build([]);
    const output = await command.agent.prompt("/查源码   ");
    assert.match(output, /问题/);
    assert.equal(command.requests.length, 0);
    const unavailable = build([], { tools: [] });
    assert.match(await unavailable.agent.prompt("/查源码 合成问题"), /不可用/);
    assert.equal(unavailable.requests.length, 0);
  });

  await test("paths only trigger one repair; discarded answer and feedback never enter formal history", async () => {
    const f = build([{ calls: [searchCall] }, { text: "I have verified the invented business rule" }, { text: "second unverified claim", calls: [searchCall] }, { text: "ordinary follow-up" }]);
    assert.equal(await f.agent.prompt("/查源码 合成问题"), refusal);
    assert.deepEqual(choices(f.requests), ["required", "auto", "required"]);
    assert.ok(f.requests[2].messages.some(message => message.content === feedback));
    assert.equal(f.requests[2].messages.some(message => message.content.includes("invented business rule")), false);
    assert.equal(JSON.stringify(f.agent.context).includes(feedback), false);
    assert.equal(JSON.stringify(f.agent.context).includes("unverified claim"), false);
    assert.equal(JSON.stringify(f.agent.context).includes("invented business rule"), false);
    assert.equal(displayed(f.events).includes("invented business rule"), false);
    assert.equal(displayed(f.events).includes("second unverified claim"), false);
    const rejected = f.events.find(event => event.type === "model_call_end" && event.output?.content.includes("invented business rule"));
    assert.ok(rejected && rejected.type === "model_call_end");
    assert.equal(rejected.draftDisposition, "discarded");
    paired(f.agent.context);
    assert.equal(await f.agent.prompt("继续普通聊天"), "ordinary follow-up");
    assert.equal(f.requests[3].messages.some(message => message.content.includes("invented business rule") || message.content.includes("second unverified claim") || message.content === feedback), false);
  });

  await test("repair may obtain source and then restores auto for the final response", async () => {
    const f = build([{ calls: [searchCall] }, { text: "blocked fabricated answer" }, { calls: [readCall] }, { text: "allowed final answer" }]);
    assert.equal(await f.agent.prompt("/查源码 合成问题"), "allowed final answer");
    assert.deepEqual(choices(f.requests), ["required", "auto", "required", "auto"]);
    assert.equal(f.requests[3].tools.length, 3);
    assert.equal(JSON.stringify(f.agent.context).includes("blocked fabricated answer"), false);
    assert.equal(JSON.stringify(f.agent.context).includes(feedback), false);
    paired(f.agent.context);
  });

  await test("toolCalls finish with no actual calls cannot bypass the gate or repeat repair", async () => {
    const f = build([{ text: "missing-call fabricated answer", end: "toolCalls" }, { text: "still no call", end: "toolCalls" }]);
    assert.equal(await f.agent.prompt("/查源码 合成问题"), refusal);
    assert.deepEqual(choices(f.requests), ["required", "required"]);
    assert.equal(f.executed.length, 0);
    assert.equal(displayed(f.events).includes("missing-call fabricated answer"), false);
    assert.equal(displayed(f.events).includes("still no call"), false);
    assert.equal(JSON.stringify(f.agent.context).includes("fabricated answer"), false);
    paired(f.agent.context);
  });

  await test("intermediate text stays buffered even after source content has been obtained", async () => {
    const f = build([{ calls: [readCall] }, { text: "premature conclusion during more tools", calls: [{ name: "authorized_other" }] }, { text: "final complete reply" }]);
    assert.equal(await f.agent.prompt("/查源码 合成问题"), "final complete reply");
    assert.deepEqual(f.executed, ["read_dcs_code", "authorized_other"]);
    assert.equal(displayed(f.events).includes("premature conclusion"), false);
    assert.equal(JSON.stringify(f.agent.context).includes("premature conclusion"), false);
    assert.equal(JSON.stringify(f.requests[2].messages).includes("premature conclusion"), false);
    paired(f.agent.context);
  });

  await test("source discarded by afterToolCall cannot satisfy evidence", async () => {
    const f = build([{ calls: [readCall] }, { text: "blocked answer" }, { calls: [readCall] }], { hooks: { afterToolCall() { throw new Error("synthetic post-processing failure"); } } });
    assert.equal(await f.agent.prompt("/查源码 合成问题"), refusal);
    assert.equal(f.agent.context.filter(message => message.role === "toolResult").every(message => message.isError && !message.content.includes("Where")), true);
    assert.equal(f.requests[1].messages.some(message => message.role === "toolResult" && message.content.includes("Where")), false);
    paired(f.agent.context);
  });

  await test("registered but unoffered tools and unknown tools are never executed", async () => {
    const f = build([{ calls: [{ name: "authorized_other" }, { name: "unknown_tool" }] }, { text: "blocked unauthorized claim" }, { calls: [readCall] }, { text: "final after source" }]);
    assert.equal(await f.agent.prompt("/查源码 合成问题"), "final after source");
    assert.deepEqual(f.executed, ["read_dcs_code"]);
    const rejected = f.agent.context.filter(message => message.role === "toolResult" && message.toolName !== "read_dcs_code");
    assert.equal(rejected.length, 2);
    assert.equal(rejected.every(message => message.role === "toolResult" && message.isError), true);
    paired(f.agent.context);
  });

  for (const [label, plan] of [
    ["model error", { end: "error" }],
    ["length exhaustion", { end: "length", calls: [readCall] }],
    ["interrupted stream", { end: "interrupted" }],
    ["thrown stream exception", { throws: true }],
  ] as const) {
    await test(`${label} never releases candidate text or starts repair`, async () => {
      const f = build([{ text: "unsafe partial candidate", ...plan }]);
      const output = await f.agent.prompt("/查源码 合成问题");
      assert.equal(output.includes("unsafe partial candidate"), false);
      assert.notEqual(output, refusal);
      assert.equal(f.requests.length, 1);
      assert.equal(f.executed.length, 0);
      assert.equal(displayed(f.events).includes("unsafe partial candidate"), false);
      assert.equal(JSON.stringify(f.agent.context).includes("unsafe partial candidate"), false);
      assert.equal(runEnd(f.events).status, "failed");
      paired(f.agent.context);
    });
  }

  await test("having source content does not convert later model failure into success", async () => {
    const f = build([{ calls: [readCall] }, { text: "failed candidate after source", end: "error" }]);
    const output = await f.agent.prompt("/查源码 合成问题");
    assert.equal(output.includes("failed candidate after source"), false);
    assert.notEqual(output, refusal);
    assert.equal(f.requests.length, 2);
    assert.equal(runEnd(f.events).status, "failed");
    assert.equal(displayed(f.events).includes("failed candidate after source"), false);
    paired(f.agent.context);
  });

  await test("repair shares original turn budget and cannot add a call when exhausted", async () => {
    const f = build([{ calls: [searchCall] }, { text: "blocked budget claim" }], { maxTurns: 2 });
    const output = await f.agent.prompt("/查源码 合成问题");
    assert.equal(f.requests.length, 2);
    assert.equal(output.includes("blocked budget claim"), false);
    assert.equal(runEnd(f.events).reason, "max_turns");
    assert.equal(runEnd(f.events).status, "failed");
    paired(f.agent.context);
  });

  await test("tool-call turn exhaustion preserves tool pairs and returns an explicit failure", async () => {
    const f = build([{ text: "unconfirmed intermediate", calls: [readCall] }], { maxTurns: 1 });
    assert.match(await f.agent.prompt("/查源码 合成问题"), /最大执行轮次|轮次/);
    assert.equal(f.requests.length, 1);
    assert.equal(runEnd(f.events).reason, "max_turns");
    assert.equal(displayed(f.events).includes("unconfirmed intermediate"), false);
    paired(f.agent.context);
  });

  await test("cancel and timeout signals prevent late content/tool execution without repair", async () => {
    for (const reason of [new DOMException("cancelled", "AbortError"), new DOMException("deadline", "TimeoutError")]) {
      const controller = new AbortController();
      const f = build([{ text: "late model text", afterText: () => controller.abort(reason), calls: [readCall] }], { signalProvider: () => controller.signal });
      const output = await f.agent.prompt("/查源码 合成问题");
      assert.equal(output.includes("late model text"), false);
      assert.notEqual(output, refusal);
      assert.equal(f.requests.length, 1);
      assert.equal(f.executed.length, 0);
      assert.equal(runEnd(f.events).status, "failed");
      assert.equal(displayed(f.events).includes("late model text"), false);
      paired(f.agent.context);
    }
    const controller = new AbortController();
    controller.abort();
    const f = build([], { signalProvider: () => controller.signal });
    await f.agent.prompt("/查源码 合成问题");
    assert.equal(f.requests.length, 0);
    assert.equal(runEnd(f.events).status, "failed");
  });

  await test("cancellation during a tool preserves every call/result pair and skips pending tools", async () => {
    const controller = new AbortController();
    const fixture = fixtureTools();
    fixture.tools[1] = { ...fixture.tools[1], async execute() {
      fixture.executed.push("read_dcs_code");
      controller.abort();
      return sourceResult;
    } };
    const f = build([{ calls: [readCall, readCall] }], { signalProvider: () => controller.signal }, fixture);
    const output = await f.agent.prompt("/查源码 合成问题");
    assert.notEqual(output, refusal);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.executed, ["read_dcs_code"]);
    assert.equal(runEnd(f.events).status, "failed");
    const results = f.agent.context.filter(message => message.role === "toolResult");
    assert.equal(results.length, 2);
    assert.equal(results[1].isError, true);
    paired(f.agent.context);
  });

  await test("last-turn cancellation during a tool remains cancellation, with complete tool pairs", async () => {
    const controller = new AbortController();
    const fixture = fixtureTools();
    fixture.tools[1] = { ...fixture.tools[1], async execute() {
      fixture.executed.push("read_dcs_code");
      controller.abort();
      return sourceResult;
    } };
    const f = build([{ calls: [readCall, readCall] }], { maxTurns: 1, signalProvider: () => controller.signal }, fixture);
    const output = await f.agent.prompt("/查源码 合成问题");
    assert.match(output, /取消/);
    assert.notEqual(output, refusal);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.executed, ["read_dcs_code"]);
    assert.equal(runEnd(f.events).reason, "model_error");
    assert.equal(runEnd(f.events).status, "failed");
    assert.equal(f.agent.context.filter(message => message.role === "toolResult").length, 2);
    paired(f.agent.context);
  });

  await test("later ordinary input and another evidence run never inherit prior run evidence", async () => {
    const f = build([{ calls: [readCall] }, { text: "first final" }, { text: "ordinary streamed answer" }, { calls: [searchCall] }, { text: "second run blocked claim" }, { calls: [searchCall] }]);
    assert.equal(await f.agent.prompt("/查源码 第一个问题"), "first final");
    assert.equal(await f.agent.prompt("谢谢"), "ordinary streamed answer");
    assert.equal(await f.agent.prompt("/查源码 第二个问题"), refusal);
    assert.deepEqual(choices(f.requests), ["required", "auto", "auto", "required", "auto", "required"]);
    assert.equal(f.requests[2].systemPrompt, "Synthetic base prompt");
    assert.equal(f.events.some(event => event.type === "message_delta" && event.text === "ordinary streamed answer"), true);
    assert.equal(JSON.stringify(f.agent.context).includes("second run blocked claim"), false);
    paired(f.agent.context);
  });

  await test("concurrent independent sessions keep separate source state", async () => {
    const success = build([{ calls: [readCall] }, { text: "source session final" }]);
    const failure = build([{ calls: [searchCall] }, { text: "other session false claim" }, { calls: [searchCall] }]);
    const outputs = await Promise.all([success.agent.prompt("/查源码 会话一"), failure.agent.prompt("/查源码 会话二")]);
    assert.deepEqual(outputs, ["source session final", refusal]);
    assert.deepEqual(choices(success.requests), ["required", "auto"]);
    assert.deepEqual(choices(failure.requests), ["required", "auto", "required"]);
    assert.equal(failure.agent.context.some(message => message.role === "toolResult" && message.content.includes("Where")), false);
    paired(success.agent.context);
    paired(failure.agent.context);
  });
  console.log(`Evidence Agent/Loop: ${passed} offline regression scenarios passed.`);
} finally {
  if (previousSourceRoot === undefined) delete process.env.DCS_SOURCE_ROOT;
  else process.env.DCS_SOURCE_ROOT = previousSourceRoot;
  await rm(syntheticRoot, { recursive: true, force: true });
}
