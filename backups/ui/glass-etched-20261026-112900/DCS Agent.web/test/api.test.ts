import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loginSso, postNavigationResult, streamChat, type ChatEvent } from "../src/api.ts";
import { applyTextEvent } from "../src/messages.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const events: ChatEvent[] = [];
async function run(signal?: AbortSignal) {
  events.length = 0;
  await streamChat("test", "question", event => events.push(event), signal);
}
test("fetch failure becomes a visible error", async () => {
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  await run(); assert.equal(events.at(-1)?.type, "error");
});
test("reader failure after delta preserves partial text and emits error", async () => {
  let n = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(c) { if (++n === 1) c.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"partial"}\n\n')); else c.error(new Error("broken")); },
  }));
  await run(); assert.deepEqual(events.map(e => e.type), ["delta", "error"]);
});
test("early EOF cannot be successful", async () => {
  globalThis.fetch = async () => new Response('data: {"type":"delta","text":"partial"}\n\n');
  await run(); assert.deepEqual(events.map(e => e.type), ["delta", "error"]);
});
test("normal final closes and releases reader even if server keeps stream open", async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"final","text":"done"}\r\n\r\n')); },
    cancel() { cancelled = true; },
  }));
  await run(); assert.deepEqual(events, [{ type: "final", text: "done" }]); assert.equal(cancelled, true);
});
test("active user cancellation is distinguished from network failure", async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const controller = new AbortController();
  const pending = run(controller.signal); controller.abort(); await pending;
  assert.match((events.at(-1) as { message: string }).message, /已停止/);
});
test("401 and 409 are visible; malformed SSE is not silently accepted", async () => {
  for (const status of [401, 409]) {
    globalThis.fetch = async () => new Response('{"message":"拒绝"}', { status });
    await run(); assert.deepEqual(events, [{ type: "error", message: "拒绝" }]);
  }
  globalThis.fetch = async () => new Response("data: broken\n\n");
  await run(); assert.equal(events.at(-1)?.type, "error");
});
test("SSO timeout aborts fetch and ends loading with a timeout message", async () => {
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Promise((_r, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancel")); });
  });
  const result = await loginSso("fixture", { timeoutMs: 10 });
  assert.equal(aborted, true); assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /超时/);
});
test("SSO caller cancellation cancels the request", async () => {
  globalThis.fetch = async (_url, init) => new Promise((_r, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("cancel")));
  });
  const controller = new AbortController();
  const pending = loginSso("fixture", { signal: controller.signal }); controller.abort();
  assert.match((await pending as { message: string }).message, /取消/);
});
test("SSO normal response and navigation negative result keep their semantics", async () => {
  globalThis.fetch = async () => Response.json({ ok: true, token: "fixture" });
  assert.equal((await loginSso("fixture")).ok, true);
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init!.body)).result, { ok: false, message: "未找到菜单" });
    return Response.json({ ok: true });
  };
  await postNavigationResult("fixture", "id", { ok: false, message: "未找到菜单" });
  globalThis.fetch = async () => new Response("", { status: 404 });
  await assert.rejects(postNavigationResult("fixture", "id", { ok: true, message: "ok" }));
});
test("tool preamble and final answer are separate turns; final never duplicates delta", () => {
  let messages = applyTextEvent([], "run", { type: "delta", messageId: "1", text: "我来查询" });
  messages = applyTextEvent(messages, "run", { type: "delta", messageId: "2", text: "答案" });
  messages = applyTextEvent(messages, "run", { type: "final", messageId: "2", text: "答案。" });
  assert.deepEqual(messages.map(m => m.content), ["我来查询", "答案。"]);
  messages = applyTextEvent(messages, "run", { type: "error", message: "中断" });
  assert.deepEqual(messages.map(m => m.content), ["我来查询", "答案。", "中断"]);
});
