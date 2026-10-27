import { fixtureAuthority, conversationFetch as fetch } from "./web-conversation-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createWebServer, type AgentLike } from "../src/web/server.ts";
import type { RequestNavigation } from "../src/dcs/navigation-tool.ts";
import type { AgentEvent } from "../src/core/events.ts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function setup(prompt: (n: number, nav: RequestNavigation, emit: (e: AgentEvent) => void) => Promise<string>, budgetMs = 500) {
  let count = 0;
  const server = createWebServer({ dataFile: ":memory:",
    budgetMs, navigationTimeoutMs: 200, logger: () => {},
    authority: fixtureAuthority(async code => code),
    resolveIdentity: async code => ({ employeeNo: code, name: "Test" }),
    createAgent: (_id, _holder, _auth, nav): AgentLike => {
      const n = ++count;
      const listeners = new Set<(e: AgentEvent) => void>();
      return { subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        prompt: () => prompt(n, nav, e => listeners.forEach(fn => fn(e))) };
    },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function login(code = "A") {
    return (await (await fetch(base + "/api/session/sso", { method: "POST", body: JSON.stringify({ code }) })).json() as { token: string }).token;
  }
  return {
    login,
    chat: (token: string, signal?: AbortSignal) => fetch(base + "/api/chat", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: '{"question":"test"}', signal,
    }),
    result: (token: string, requestId: string) => fetch(base + "/api/ui-action/result", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId, result: { ok: true, message: "ok" } }),
    }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}
test("timed-out old Tool cannot navigate through a new Run", async () => {
  const releaseOld = deferred<void>(), oldFinished = deferred<void>();
  const s = await setup(async (n, nav, emit) => {
    if (n === 1) {
      await releaseOld.promise;
      await assert.rejects(nav("A", "OLD"));
      oldFinished.resolve();
      return "old";
    }
    emit({ type: "message_delta", text: "new" });
    releaseOld.resolve();
    await oldFinished.promise;
    return "new";
  }, 100);
  try {
    const token = await s.login();
    assert.match(await (await s.chat(token)).text(), /timeout/);
    const text = await (await s.chat(token)).text();
    assert.doesNotMatch(text, /ui_action|OLD/); assert.match(text, /final/);
  } finally { releaseOld.resolve(); await s.close(); }
});
test("closing an iframe rejects pending; reopened session receives no old navigation", async () => {
  const rejected = deferred<void>(), releaseOld = deferred<void>(), oldFinished = deferred<void>();
  const s = await setup(async (n, nav, emit) => {
    if (n === 1) {
      await assert.rejects(nav("A", "first"));
      rejected.resolve();
      await releaseOld.promise;
      await assert.rejects(nav("A", "OLD"));
      oldFinished.resolve();
      return "old";
    }
    emit({ type: "message_delta", text: "new" }); releaseOld.resolve();
    await oldFinished.promise; return "new";
  });
  try {
    const controller = new AbortController();
    const first = await s.chat(await s.login(), controller.signal);
    const reader = first.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /ui_action/);
    controller.abort(); await rejected.promise;
    const text = await (await s.chat(await s.login())).text();
    assert.doesNotMatch(text, /ui_action|OLD/);
  } finally { releaseOld.resolve(); await s.close(); }
});
test("expired requestId cannot complete a later Run", async () => {
  const s = await setup(async (_n, nav) => { try { return (await nav("A", "menu")).message; } catch { return "expired"; } });
  try {
    const token = await s.login();
    const text = await (await s.chat(token)).text();
    const id = /"requestId":"([^"]+)"/.exec(text)![1];
    const current = await s.chat(token);
    assert.equal((await s.result(token, id)).status, 404);
    assert.match(await current.text(), /expired/);
  } finally { await s.close(); }
});
test("active request rejects another employee AND another session of same employee", async () => {
  const s = await setup(async (_n, nav) => (await nav("A", "menu")).message);
  try {
    const a = await s.login(), a2 = await s.login(), b = await s.login("B");
    const response = await s.chat(a);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const id = /"requestId":"([^"]+)"/.exec(first)![1];
    assert.equal((await s.result(b, id)).status, 404);
    assert.equal((await s.result(a2, id)).status, 404);
    assert.equal((await s.result(a, id)).status, 200);
    assert.equal((await s.result(a, id)).status, 404);
    while (!(await reader.read()).done) { /* drain */ }
  } finally { await s.close(); }
});
