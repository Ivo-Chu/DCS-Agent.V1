import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForNavigation } from "../src/navigation.ts";
function host() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: unknown[] = [];
  const parent = { postMessage: (value: unknown) => sent.push(value) };
  const window = {
    parent,
    addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.delete(fn),
  } as unknown as Window;
  return { window, listeners, sent, reply(overrides: Record<string, unknown> = {}) {
    listeners.forEach(fn => fn({ origin: "https://dcs.test", source: parent,
      data: { type: "dcs_agent_navigate_result", requestId: "id", ok: false, message: "denied" }, ...overrides } as MessageEvent));
  } };
}
test("origin/source/id checked, negative result preserved, duplicate result inert", async () => {
  const h = host(), controller = new AbortController();
  const result = waitForNavigation("id", "menu", "https://dcs.test", controller.signal, h.window);
  h.reply({ origin: "https://bad.test" }); assert.equal(h.listeners.size, 1);
  h.reply({ source: {} }); assert.equal(h.listeners.size, 1);
  h.reply({ data: { type: "dcs_agent_navigate_result", requestId: "other" } }); assert.equal(h.listeners.size, 1);
  h.reply(); assert.deepEqual(await result, { ok: false, message: "denied" });
  assert.equal(h.listeners.size, 0); h.reply(); assert.equal(h.sent.length, 1);
});
test("unmount/run cancellation removes listeners without cancelling work already sent to parent", async () => {
  const h = host(), controller = new AbortController();
  const pending = waitForNavigation("id", "menu", "https://dcs.test", controller.signal, h.window);
  controller.abort(); assert.equal((await pending).ok, false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.sent.length, 1);
});
test("timeout settles promise, cleans resources, rejects late result", async () => {
  const h = host(), controller = new AbortController();
  const result = await waitForNavigation("id", "menu", "https://dcs.test", controller.signal, h.window, 10);
  assert.equal(result.ok, false); assert.equal(h.listeners.size, 0); assert.equal(h.sent.length, 1);
  h.reply(); assert.equal(h.sent.length, 1);
});
test("already aborted request does not send navigation", async () => {
  const h = host(), controller = new AbortController(); controller.abort();
  assert.equal((await waitForNavigation("id", "menu", "https://dcs.test", controller.signal, h.window)).ok, false);
  assert.equal(h.sent.length, 0);
});
