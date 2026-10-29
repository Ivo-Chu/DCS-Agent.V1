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
import type { ModelStreamEvent, StreamFn } from "../src/core/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function* call(id: string, file: string): Generator<ModelStreamEvent> {
  yield { type: "tool_call_start", index: 0, toolCallId: id, name: "read_dcs_code" };
  yield { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify({ files: [{ path: file }] }) };
  yield { type: "message_end", stopReason: "toolCalls" };
}
type ModelRequest = Parameters<StreamFn>[0];
type FixtureStream = (req: ModelRequest, holder: DcsAgentHolder) => AsyncGenerator<ModelStreamEvent>;
async function setup(stream: FixtureStream, budgetMs = 3000, maxTurns = 8) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dcs-web-evidence-"));
  const source = path.join(dir, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "Fixture.cs"), "public class Fixture {\n  public int VisibleCount => 7;\n}\n");
  writeFileSync(path.join(source, "Labels.resx"), "<root><data name=\"title\"><value>示例页面</value></data></root>\n");
  const priorRoot = process.env.DCS_SOURCE_ROOT;
  process.env.DCS_SOURCE_ROOT = source;
  const db = new ConversationStore(":memory:");
  const requests: ModelRequest[] = [];
  const server = createWebServer({
    store: db, logsDir: dir, budgetMs, logger: () => {},
    authority: { verify: async () => ({ status: "valid", employeeNo: "fixture" }) },
    resolveIdentity: async employeeNo => ({ employeeNo, name: "fixture" }),
    createAgent: (identity, holder, auth) => createDcsAgent({
      session: createSession(identity, "web-fixture", "web", auth), holder, maxTurns,
      streamFn: async function* (req) {
        requests.push(structuredClone(req));
        yield* stream(req, holder);
      },
    }),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, token = "", data?: unknown, signal?: AbortSignal) => fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise(resolve => setImmediate(resolve));
    db.close();
    if (priorRoot === undefined) delete process.env.DCS_SOURCE_ROOT;
    else process.env.DCS_SOURCE_ROOT = priorRoot;
    rmSync(dir, { recursive: true, force: true });
  };
  let token: string, id: string;
  const create = async () => (await (await request("/api/conversations", token, {})).json() as any).conversation.id as string;
  try {
    token = (await (await request("/api/session/sso", "", { code: "a".repeat(32) })).json() as { token: string }).token;
    id = await create();
  } catch (error) { await close(); throw error; }
  return {
    db, id, requests, create,
    chat: (question: string, conversationId = id, signal?: AbortSignal) => request("/api/chat", token, { conversationId, question }, signal),
    stop: () => request("/api/chat/stop", token, { conversationId: id }),
    saved: (conversationId = id) => db.get(db.find("fixture")!, conversationId)!,
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
const choice = (req: ModelRequest) => (req as ModelRequest & { toolChoice?: string }).toolChoice;
const pause = () => new Promise(resolve => setImmediate(resolve));

test("actual Web command forces source first, buffers all drafts, and keeps tool pairs and ordinary streaming", async () => {
  let turn = 0;
  const finalStarted = deferred(), releaseFinal = deferred(), releaseOrdinary = deferred();
  const s = await setup(async function* () {
    turn++;
    if (turn === 1) {
      yield { type: "text_delta", text: "未核实的中间调查说明" };
      yield* call("source-1", "Fixture.cs");
    } else if (turn === 2) {
      yield { type: "text_delta", text: "已取得源码片段，示例属性返回 7。" };
      finalStarted.resolve();
      await releaseFinal.promise;
      yield { type: "message_end", stopReason: "stop" };
    } else {
      yield { type: "text_delta", text: "普通聊天仍实时显示" };
      await releaseOrdinary.promise;
      yield { type: "message_end", stopReason: "stop" };
    }
  });
  try {
    const output = collect(await s.chat("/查源码 示例属性的实际实现？"));
    await finalStarted.promise;
    await pause();
    assert.doesNotMatch(output.text(), /未核实的中间调查说明|已取得源码片段|"type":"delta"/);
    assert.match(output.text(), /"type":"tool_step"/);
    assert.deepEqual(s.saved().messages.filter(m => m.role === "assistant"), []);
    assert.equal(s.saved().tools[0]?.status, "success");
    assert.equal(choice(s.requests[0]), "required");
    assert.deepEqual(s.requests[0].tools.map(t => t.name).sort(), ["read_dcs_code", "search_dcs_code"]);
    assert.equal(s.requests[0].messages.at(-1)?.content, "示例属性的实际实现？");
    assert.equal(choice(s.requests[1]), "auto");
    assert.ok(s.requests[1].tools.length > 2);
    releaseFinal.resolve();
    const wire = await output.done;
    assert.match(wire, /"type":"final"/);
    assert.doesNotMatch(wire, /未核实的中间调查说明|"type":"delta"/);
    const saved = s.saved();
    assert.deepEqual(saved.messages.filter(m => m.role === "assistant").map(m => m.content), ["已取得源码片段，示例属性返回 7。"]);
    assert.equal(validContext(saved.context), true);
    assert.equal(saved.context.filter(m => m.role === "toolResult").length, 1);
    assert.doesNotMatch(JSON.stringify(saved.context), /未核实的中间调查说明/);
    const ordinary = await s.chat("你好");
    const reader = ordinary.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"delta".*普通聊天仍实时显示/);
    assert.equal(choice(s.requests[2]), "auto");
    assert.ok(s.requests[2].tools.length > 2);
    releaseOrdinary.resolve();
    while (!(await reader.read()).done) { /* drain */ }
  } finally { releaseFinal.resolve(); releaseOrdinary.resolve(); await s.close(); }
});

test("Web empty source command prompts for a question without a model request", async () => {
  const s = await setup(async function* () { throw new Error("model must not be called"); });
  try {
    const wire = await (await s.chat("/查源码   ")).text();
    assert.equal(s.requests.length, 0);
    assert.match(wire, /问题/);
    assert.doesNotMatch(wire, /"type":"tool_step"/);
  } finally { await s.close(); }
});

test("Web rejects resource-only evidence, retries once, and excludes rejected draft from history and later context", async () => {
  let turn = 0;
  const s = await setup(async function* () {
    turn++;
    if (turn === 1) yield* call("resource", "Labels.resx");
    else if (turn === 2) {
      yield { type: "text_delta", text: "拦截草稿：已查阅源码，所有员工都可见。" };
      yield { type: "message_end", stopReason: "stop" };
    } else if (turn === 3) yield* call("rescue", "missing.cs");
    else {
      yield { type: "text_delta", text: "普通后续回答" };
      yield { type: "message_end", stopReason: "stop" };
    }
  });
  try {
    const wire = await (await s.chat("/查源码 页面实际规则？")).text();
    assert.equal(s.requests.length, 3);
    assert.deepEqual(s.requests.map(choice), ["required", "auto", "required"]);
    assert.match(wire, /本次未能取得可核实的源码内容，暂时无法确认该功能的实际规则。/);
    assert.doesNotMatch(wire, /拦截草稿|所有员工都可见|"type":"delta"/);
    const saved = s.saved();
    assert.equal(validContext(saved.context), true);
    assert.equal(saved.context.filter(m => m.role === "toolResult").length, 2);
    assert.doesNotMatch(JSON.stringify(saved), /拦截草稿|所有员工都可见/);
    await (await s.chat("你好")).text();
    assert.equal(choice(s.requests[3]), "auto");
    assert.doesNotMatch(JSON.stringify(s.requests[3].messages), /拦截草稿|所有员工都可见/);
    const other = await s.create();
    await (await s.chat("谢谢", other)).text();
    assert.equal(choice(s.requests[4]), "auto");
    assert.equal(s.requests[4].messages.length, 1);
  } finally { await s.close(); }
});

for (const mode of ["timeout", "stop"] as const) {
  test(`Web evidence ${mode} discards buffered text and late completion cannot enter the next run`, async () => {
    let turn = 0;
    const started = deferred(), release = deferred(), oldFinished = deferred();
    const s = await setup(async function* (_req, holder) {
      turn++;
      if (turn === 1) {
        yield { type: "text_delta", text: "旧请求尚未核实的秘密草稿" };
        started.resolve();
        await release.promise;
        // Deliberately late output exercises the Web ownership fence, even for a misbehaving model.
        yield { type: "text_delta", text: "旧请求迟到内容" };
        yield { type: "message_end", stopReason: holder.controller.signal.aborted ? "error" : "stop" };
        oldFinished.resolve();
      } else {
        yield { type: "text_delta", text: "新请求普通回答" };
        yield { type: "message_end", stopReason: "stop" };
      }
    }, mode === "timeout" ? 100 : 3000);
    try {
      const pending = s.chat("/查源码 慢请求");
      await started.promise;
      if (mode === "stop") await s.stop();
      const wire = await (await pending).text();
      assert.match(wire, mode === "timeout" ? /"type":"timeout"/ : /已停止本次回复/);
      assert.doesNotMatch(wire, /秘密草稿|迟到内容|"type":"final"/);
      const next = await (await s.chat("你好")).text();
      assert.match(next, /新请求普通回答/);
      release.resolve();
      await oldFinished.promise;
      await pause();
      assert.doesNotMatch(JSON.stringify(s.saved()), /秘密草稿|迟到内容/);
      assert.deepEqual(s.saved().context.filter(m => m.role === "user").map(m => m.content), ["你好"]);
      assert.equal(choice(s.requests[1]), "auto");
    } finally { release.resolve(); await s.close(); }
  });
}

test("Web model stream failure does not convert an evidence run to a successful fallback", async () => {
  const s = await setup(async function* () {
    yield { type: "text_delta", text: "中断前没有核实的草稿" };
    throw new Error("fixture stream disconnected");
  });
  try {
    const wire = await (await s.chat("/查源码 中断请求")).text();
    assert.equal(s.requests.length, 1);
    assert.doesNotMatch(wire, /中断前没有核实的草稿|"type":"final"|本次未能取得可核实的源码内容/);
    assert.match(wire, /"type":"error"/);
    assert.deepEqual(s.saved().context, []);
    assert.doesNotMatch(JSON.stringify(s.saved().messages), /中断前没有核实的草稿/);
  } finally { await s.close(); }
});

for (const failureAt of ["save", "finish"] as const) {
  test(`Web evidence ${failureAt} failure publishes no candidate and leaves the next request isolated`, async () => {
    let turn = 0;
    const s = await setup(async function* (req) {
      turn++;
      if (req.messages.at(-1)?.content === "你好") {
        yield { type: "text_delta", text: "后续普通答复" };
        yield { type: "message_end", stopReason: "stop" };
      } else if (turn === 1) {
        yield { type: "text_delta", text: "保存失败前的中间草稿" };
        yield* call("save-source", "Fixture.cs");
      } else {
        yield { type: "text_delta", text: "已读源码的候选正式答案" };
        yield { type: "message_end", stopReason: "stop" };
      }
    });
    const save = s.db.save.bind(s.db), finish = s.db.finish.bind(s.db);
    if (failureAt === "save") s.db.save = () => { throw new Error("fixture checkpoint failure"); };
    else s.db.finish = (c, run, complete) => {
      if (complete) throw new Error("fixture final persistence failure");
      return finish(c, run, false);
    };
    try {
      const wire = await (await s.chat("/查源码 保存失败调查")).text();
      assert.match(wire, /"type":"error"/);
      assert.doesNotMatch(wire, /中间草稿|候选正式答案|"type":"final"|"type":"delta"/);
      assert.deepEqual(s.saved().context, []);
      assert.doesNotMatch(JSON.stringify(s.saved().messages), /中间草稿|候选正式答案/);
      s.db.save = save; s.db.finish = finish;
      const next = await (await s.chat("你好")).text();
      assert.match(next, /后续普通答复/);
      assert.doesNotMatch(next, /中间草稿|候选正式答案/);
      const request = s.requests.at(-1)!;
      assert.equal(choice(request), "auto");
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0].content, "你好");
    } finally { s.db.save = save; s.db.finish = finish; await s.close(); }
  });
}

test("Web disconnected socket drops buffered evidence output and preserves later request ownership", async () => {
  let turn = 0;
  const finalStarted = deferred(), release = deferred(), oldFinished = deferred();
  const s = await setup(async function* () {
    turn++;
    if (turn === 1) yield* call("disconnect-source", "Fixture.cs");
    else if (turn === 2) {
      yield { type: "text_delta", text: "断开连接时的缓冲候选" };
      finalStarted.resolve();
      await release.promise;
      yield { type: "text_delta", text: "断开连接后的迟到文字" };
      yield { type: "message_end", stopReason: "stop" };
      oldFinished.resolve();
    } else {
      yield { type: "text_delta", text: "重连普通答复" };
      yield { type: "message_end", stopReason: "stop" };
    }
  });
  try {
    const controller = new AbortController();
    const output = collect(await s.chat("/查源码 断开连接调查", s.id, controller.signal));
    const ended = output.done.catch(() => output.text());
    await finalStarted.promise;
    controller.abort();
    assert.doesNotMatch(await ended, /缓冲候选|迟到文字|"type":"final"|"type":"delta"/);
    const deadline = Date.now() + 2000;
    while (s.saved().runId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(s.saved().runId, null);
    assert.deepEqual(s.saved().context, []);
    assert.doesNotMatch(JSON.stringify(s.saved().messages), /缓冲候选|迟到文字/);
    // Persistence finishes before observer flushing releases the employee lock.
    // The existing stop endpoint awaits that already-started close operation.
    await s.stop();
    assert.match(await (await s.chat("你好")).text(), /重连普通答复/);
    release.resolve(); await oldFinished.promise; await pause();
    assert.deepEqual(s.saved().context.filter(m => m.role === "user").map(m => m.content), ["你好"]);
    assert.doesNotMatch(JSON.stringify(s.saved()), /缓冲候选|迟到文字/);
    assert.equal(choice(s.requests[2]), "auto");
  } finally { release.resolve(); await s.close(); }
});
