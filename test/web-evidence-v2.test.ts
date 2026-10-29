/** Offline HTTP regressions: real Web/Agent/Loop, synthetic files and model output. No external services. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../src/web/server.ts";
import { ConversationStore, validContext } from "../src/web/conversation-store.ts";
import { createDcsAgent, type DcsAgentHolder } from "../src/dcs/agent-factory.ts";
import { createSession } from "../src/dcs/session.ts";
import { createNavigateDcsMenuTool } from "../src/dcs/navigation-tool.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelStreamEvent, StreamFn } from "../src/core/types.ts";

type Request = Parameters<StreamFn>[0];
type FixtureStream = (request: Request, holder: DcsAgentHolder) => AsyncGenerator<ModelStreamEvent>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function* call(name: string, args: object, id = "fixture-call"): Generator<ModelStreamEvent> {
  yield { type: "tool_call_start", index: 0, toolCallId: id, name };
  yield { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(args) };
  yield { type: "message_end", stopReason: "toolCalls" };
}
function* answer(text: string): Generator<ModelStreamEvent> {
  yield { type: "text_delta", text };
  yield { type: "message_end", stopReason: "stop" };
}
const read = (id = "fixture-read") => call("read_dcs_code", { files: [{ path: "Fixture.cs" }] }, id);
const pause = () => new Promise(resolve => setImmediate(resolve));
async function setup(stream: FixtureStream, options: { budgetMs?: number; navigation?: boolean; sourceAvailable?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dcs-web-evidence-v2-"));
  const source = path.join(dir, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "Fixture.cs"), "public class Fixture {\n  public int Count => 7;\n}\n");
  const keys = ["DCS_SOURCE_ROOT", "DCS_SOURCE_MAP_FILE", "DCS_DB_USER", "DCS_DB_PASSWORD", "DCS_DB_CONNECT_STRING", "DCS_EMBEDDING_URL", "DCS_EMBEDDING_API_KEY"];
  const env = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DCS_SOURCE_ROOT = options.sourceAvailable === false ? path.join(dir, "unavailable-source") : source;
  process.env.DCS_SOURCE_MAP_FILE = path.join(dir, "absent-map.json");
  const store = new ConversationStore(":memory:");
  const requests: Request[] = [], events: AgentEvent[] = [];
  const server = createWebServer({
    store, logsDir: dir, budgetMs: options.budgetMs ?? 3000, logger: () => {},
    authority: { verify: async () => ({ status: "valid", employeeNo: "fixture" }) },
    resolveIdentity: async employeeNo => ({ employeeNo, name: "fixture" }),
    createAgent: (identity, holder, auth, nav) => {
      const agent = createDcsAgent({
        session: createSession(identity, "v2-web-fixture", "web", auth), holder, maxTurns: 8,
        extraTools: options.navigation ? [createNavigateDcsMenuTool(nav)] : [],
        streamFn: async function* (request) {
          requests.push(structuredClone(request));
          yield* stream(request, holder);
        },
      });
      agent.subscribe(event => events.push(structuredClone(event)));
      return agent;
    },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, token: string, body: unknown) => fetch(base + route, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pause();
    store.close();
    for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  };
  let token: string, id: string;
  const create = async () => (await (await post("/api/conversations", token, {})).json() as any).conversation.id as string;
  try {
    token = (await (await post("/api/session/sso", "", { code: "a".repeat(32) })).json() as { token: string }).token;
    id = await create();
  } catch (error) { await close(); throw error; }
  return {
    store, id, requests, events, create,
    chat: (question: string, conversationId = id, pageContext?: { title: string; path: string }) => post("/api/chat", token, { conversationId, question, pageContext }),
    stop: () => post("/api/chat/stop", token, { conversationId: id }),
    uiResult: (requestId: string, result: object) => post("/api/ui-action/result", token, { conversationId: id, requestId, result }),
    saved: (conversationId = id) => store.get(store.find("fixture")!, conversationId)!,
    close,
  };
}
function collect(response: Response) {
  let wire = "";
  const done = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return wire;
      wire += decoder.decode(chunk.value, { stream: true });
    }
  })();
  return { done, text: () => wire };
}
function lastRun(events: AgentEvent[]) {
  const event = [...events].reverse().find(event => event.type === "run_end");
  assert.ok(event?.type === "run_end");
  return event;
}

test("real Web entry defaults substantive Chinese requests to required without a command", async () => {
  const inputs = [
    "通讯录怎么查不到其他厂区的人？", "重点岗位和一般岗位分别有哪些查询条件？",
    "宿舍床位统计选到今天，今天的数据算进去吗？", "谢谢，另外通讯录能查哪些人？", "那其他厂区呢？",
  ];
  const s = await setup(async function* (req) {
    if (req.messages.at(-1)?.role === "user") yield* read(`read-${req.messages.length}`);
    else yield* answer("本次取得合成源码；这只是离线流程测试。");
  });
  try {
    for (const question of inputs) {
      const start = s.requests.length;
      const wire = await (await s.chat(question)).text();
      assert.equal(s.requests[start].toolChoice, "required", question);
      assert.equal(s.requests[start].messages.at(-1)?.content, question);
      assert.equal(s.requests[start + 1].toolChoice, "auto", question);
      const names = s.requests[start].tools.map(tool => tool.name);
      assert.ok(names.includes("request_clarification"));
      assert.ok(names.includes("search_dcs_code") && names.includes("read_dcs_code"));
      assert.ok(!names.includes("query_dcs_data") && !names.includes("search_dcs_knowledge"));
      assert.match(wire, /"type":"tool_step"/);
      assert.match(wire, /"type":"final"/);
      assert.doesNotMatch(wire, /"type":"delta"/);
    }
    assert.ok(validContext(s.saved().context));
    assert.equal(s.saved().context.filter(message => message.role === "toolResult").length, inputs.length);
  } finally { await s.close(); }
});

test("whole-message greetings and a pure rewrite retain auto streaming, business followups do not", async () => {
  let rewrite = false;
  const emitted = deferred(), release = deferred();
  const s = await setup(async function* (req) {
    const question = req.messages.at(-1)?.content;
    if (["你好", "谢谢", "再简短一点"].includes(question ?? "")) {
      yield { type: "text_delta", text: "简短答复" };
      if (rewrite) { emitted.resolve(); await release.promise; }
      yield { type: "message_end", stopReason: "stop" };
    } else if (req.messages.at(-1)?.role === "user") yield* read();
    else yield* answer("这段合成源码返回 7。");
  });
  try {
    for (const greeting of ["你好", "谢谢"]) {
      assert.match(await (await s.chat(greeting)).text(), /"type":"delta"/);
      assert.equal(s.requests.at(-1)?.toolChoice, "auto");
    }
    await (await s.chat("重点岗位有哪些查询条件？")).text();
    rewrite = true;
    const pending = collect(await s.chat("再简短一点"));
    await emitted.promise; await pause();
    assert.match(pending.text(), /"type":"delta".*简短答复/);
    assert.equal(s.requests.at(-1)?.toolChoice, "auto");
    release.resolve(); await pending.done;
    rewrite = false;
    const before = s.requests.length;
    await (await s.chat("那其他厂区呢？")).text();
    assert.equal(s.requests[before].toolChoice, "required");
    const other = await s.create(), beforeOther = s.requests.length;
    await (await s.chat("再简短一点", other)).text();
    assert.equal(s.requests[beforeOther].toolChoice, "required", "without a previous answer this cannot rewrite a known answer");
  } finally { release.resolve(); await s.close(); }
});

test("clarification uses a missing-information slot and terminates awaiting_input without a business answer", async () => {
  let step = 0;
  const s = await setup(async function* (req) {
    step++;
    if (step === 1) {
      yield { type: "text_delta", text: "不应展示：这个页面默认可以查询全厂。" };
      yield* call("request_clarification", { missingInfo: "page" });
    } else if (req.messages.at(-1)?.role === "user") yield* read();
    else yield* answer("取得本次合成页面代码。");
  });
  try {
    const wire = await (await s.chat("这个页面怎么筛选？")).text();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].toolChoice, "required");
    assert.match(wire, /awaiting_input/);
    assert.match(wire, /页面/);
    assert.doesNotMatch(wire, /不应展示|默认可以查询全厂|"type":"delta"/);
    assert.equal(lastRun(s.events).status, "awaiting_input");
    assert.ok(validContext(s.saved().context));
    assert.doesNotMatch(JSON.stringify(s.saved()), /默认可以查询全厂/);
    assert.equal(s.saved().messages.at(-1)?.kind, "selection");
    await (await s.chat("合成页面的实际筛选规则是什么？")).text();
    assert.equal(s.requests[1].toolChoice, "required", "clarification cannot be reused as evidence on the next Run");
    assert.ok(validContext(s.requests[1].messages));
    assert.equal(lastRun(s.events).status, "completed");
    assert.ok(validContext(s.saved().context));
  } finally { await s.close(); }
});

test("no configured investigation tools reports unavailability instead of forcing a needless clarification", async () => {
  const s = await setup(async function* () { throw new Error("no model request is needed when investigation capabilities are unavailable"); }, { sourceAvailable: false });
  try {
    const wire = await (await s.chat("通讯录怎么查不到其他厂区的人？")).text();
    assert.equal(s.requests.length, 0);
    assert.match(wire, /没有可用|不可用/);
    assert.doesNotMatch(wire, /awaiting_input|请补充|"type":"tool_step"/);
    assert.equal(lastRun(s.events).policyState?.evidenceObtained, false);
    assert.ok(validContext(s.saved().context));
  } finally { await s.close(); }
});

test("optional page context reaches only the current request as a locating clue, not an authorization", async () => {
  const s = await setup(async function* (req) {
    if (req.messages.at(-1)?.role === "user") yield* read();
    else yield* answer("已读取合成页面代码，实际业务结论未验证。");
  });
  try {
    await (await s.chat("这个页面怎么筛选？", s.id, { title: "合成床位页面", path: "/Fixture/Beds" })).text();
    assert.match(s.requests[0].systemPrompt, /合成床位页面/);
    assert.match(s.requests[0].systemPrompt, /线索|不可信/);
    assert.ok(!s.requests[0].tools.some(tool => tool.name === "query_dcs_data"));
    const before = s.requests.length;
    await (await s.chat("这个页面怎么筛选？")).text();
    assert.doesNotMatch(s.requests[before].systemPrompt, /合成床位页面/);
    assert.equal(s.requests[before].toolChoice, "required");
  } finally { await s.close(); }
});

for (const status of ["opened", "needs_selection"] as const) {
  test(`navigation ${status} from the real HTTP bridge is not blocked by absent source`, async () => {
    const s = await setup(async function* (request) {
      if (request.messages.at(-1)?.role === "user") yield* call("navigate_dcs_menu", { menuName: "通讯录" }, "navigate-fixture");
      else yield* answer("已打开页面。未核实业务结论：所有员工都可见。");
    }, { navigation: true });
    try {
      const output = collect(await s.chat("帮我打开通讯录"));
      let nav: any;
      const deadline = Date.now() + 1000;
      while (!nav && Date.now() < deadline) {
        nav = output.text().split(/\r?\n\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "ui_action");
        if (!nav) await pause();
      }
      assert.ok(nav, "navigation bridge should produce a real pending request");
      const result = status === "opened" ? { ok: true, status, message: "合成通讯录已打开。" } : {
        ok: false, status, message: "请从候选选择。", candidates: [{ title: "通讯录", path: "合成一 / 通讯录" }, { title: "通讯录", path: "合成二 / 通讯录" }],
      };
      assert.equal((await s.uiResult(nav.requestId, result)).status, 200);
      const wire = await output.done;
      assert.equal(s.requests.length, status === "opened" ? 2 : 1);
      assert.match(wire, /"type":"final"/);
      assert.doesNotMatch(wire, /未能取得可核实的源码|未核实业务结论|所有员工都可见|"type":"delta"/);
      assert.equal(lastRun(s.events).status, status === "needs_selection" ? "awaiting_input" : "completed");
      assert.ok(validContext(s.saved().context));
      assert.equal(s.saved().context.filter(message => message.role === "toolResult").length, 1);
    } finally { await s.close(); }
  });
}

test("opening a page leaves room to investigate the business question in the same request", async () => {
  const s = await setup(async function* (request) {
    const last = request.messages.at(-1);
    if (last?.role === "user") yield* call("navigate_dcs_menu", { menuName: "合成页面" }, "open-and-read");
    else if (last?.role === "toolResult" && last.toolName === "navigate_dcs_menu") yield* read();
    else yield* answer("已打开合成页面；本次读取的合成属性返回 7。");
  }, { navigation: true });
  try {
    const output = collect(await s.chat("帮我打开合成页面，并说明合成属性的实际返回值"));
    let nav: any;
    const deadline = Date.now() + 1000;
    while (!nav && Date.now() < deadline) {
      nav = output.text().split(/\r?\n\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "ui_action");
      if (!nav) await pause();
    }
    assert.ok(nav);
    await s.uiResult(nav.requestId, { ok: true, status: "opened", message: "合成页面已打开。" });
    const wire = await output.done;
    assert.deepEqual(s.requests.map(request => request.toolChoice), ["required", "auto", "auto"]);
    assert.equal(s.saved().context.filter(message => message.role === "toolResult").length, 2);
    assert.equal(lastRun(s.events).policyState?.sourceContentObtained, true);
    assert.match(wire, /本次读取的合成属性返回 7/);
    assert.ok(validContext(s.saved().context));
  } finally { await s.close(); }
});

test("natural-language drafts stay buffered through persistence and cannot pollute a different conversation", async () => {
  let step = 0;
  const finalStarted = deferred(), release = deferred();
  const s = await setup(async function* () {
    step++;
    if (step === 1) {
      yield { type: "text_delta", text: "中间未核实业务草稿" }; yield* read();
    } else if (step === 2) {
      yield { type: "text_delta", text: "等待保存的正式答复" };
      finalStarted.resolve(); await release.promise;
      yield { type: "message_end", stopReason: "stop" };
    } else yield* answer("你好");
  });
  const finish = s.store.finish.bind(s.store);
  try {
    const output = collect(await s.chat("宿舍床位统计选到今天，今天的数据算进去吗？"));
    await finalStarted.promise; await pause();
    assert.doesNotMatch(output.text(), /业务草稿|正式答复|"type":"delta"/);
    assert.match(output.text(), /"type":"tool_step"/);
    assert.deepEqual(s.saved().messages.filter(message => message.role === "assistant"), []);
    s.store.finish = (conversation, run, complete) => {
      if (complete) throw new Error("synthetic final save failure");
      return finish(conversation, run, false);
    };
    release.resolve();
    assert.doesNotMatch(await output.done, /业务草稿|正式答复|"type":"final"/);
    assert.deepEqual(s.saved().context, []);
    s.store.finish = finish;
    const other = await s.create();
    await (await s.chat("你好", other)).text();
    const next = s.requests.at(-1)!;
    assert.equal(next.toolChoice, "auto");
    assert.equal(next.messages.length, 1);
    assert.doesNotMatch(JSON.stringify(next), /业务草稿|正式答复/);
  } finally { release.resolve(); s.store.finish = finish; await s.close(); }
});

for (const mode of ["cancel", "timeout"] as const) {
  test(`natural-language ${mode} keeps error semantics and no evidence leaks into the next request`, async () => {
    const started = deferred(), release = deferred(), finished = deferred();
    let step = 0;
    const s = await setup(async function* (_request, holder) {
      step++;
      if (step === 1) {
        yield { type: "text_delta", text: "旧调查未核实草稿" }; started.resolve(); await release.promise;
        yield { type: "text_delta", text: "迟到内容" };
        yield { type: "message_end", stopReason: holder.controller.signal.aborted ? "error" : "stop" }; finished.resolve();
      } else yield* answer("你好");
    }, { budgetMs: mode === "timeout" ? 100 : 3000 });
    try {
      const pending = s.chat("通讯录怎么查不到其他厂区的人？");
      await started.promise;
      if (mode === "cancel") await s.stop();
      const wire = await (await pending).text();
      assert.match(wire, mode === "timeout" ? /"type":"timeout"/ : /已停止本次回复/);
      assert.doesNotMatch(wire, /旧调查未核实草稿|迟到内容|"type":"final"/);
      await (await s.chat("谢谢")).text();
      assert.equal(s.requests.at(-1)?.toolChoice, "auto");
      release.resolve(); await finished.promise; await pause();
      assert.doesNotMatch(JSON.stringify(s.saved()), /旧调查未核实草稿|迟到内容/);
      assert.deepEqual(s.saved().context.filter(message => message.role === "user").map(message => message.content), ["谢谢"]);
    } finally { release.resolve(); await s.close(); }
  });
}
