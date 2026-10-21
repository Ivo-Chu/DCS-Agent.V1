import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkSsoCodeWithDcs } from "../src/web/sso.ts";
import { createWebServer } from "../src/web/server.ts";
async function listen(server: http.Server) {
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: http.Server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
test("real SSO HTTP adapter: DCS contract success, failure and malformed identities", async () => {
  let body: unknown = { IsSuccess: true, Data: { EmpCode: "A" } };
  const dcs = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); });
  const url = await listen(dcs);
  try {
    assert.equal(await checkSsoCodeWithDcs("fixture", url, () => {}), "A");
    for (body of [null, { IsSuccess: false, Data: { EmpCode: "A" } }, { IsSuccess: true, Data: {} },
      { IsSuccess: true, Data: { EmpCode: 123 } }, { Success: true, EmpCode: "A" }]) {
      assert.equal(await checkSsoCodeWithDcs("fixture", url, () => {}), null);
    }
  } finally { await close(dcs); }
});
test("timeout covers stalled JSON body; caller cancellation ends the HTTP request", async () => {
  const dcs = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); });
  const url = await listen(dcs);
  const logs: string[] = [];
  try {
    assert.equal(await checkSsoCodeWithDcs("PRIVATE_CODE", url, s => logs.push(s), { timeoutMs: 30 }), null);
    assert.ok(logs.every(s => !s.includes("PRIVATE_CODE")));
    const controller = new AbortController();
    const pending = checkSsoCodeWithDcs("PRIVATE_CODE", url, () => {}, { signal: controller.signal });
    controller.abort(); assert.equal(await pending, null);
  } finally { await close(dcs); }
});
test("normal verified DCS HTTP identity reaches Node Session; invalid code is rejected", async () => {
  let valid = true;
  const dcs = http.createServer((_req, res) => res.end(JSON.stringify({ IsSuccess: valid, Data: { EmpCode: "A" } })));
  const dcsUrl = await listen(dcs);
  let lookedUp = "";
  const agent = createWebServer({ ssoCheckUrl: dcsUrl, logger: () => {},
    resolveIdentity: async code => { lookedUp = code; return { employeeNo: code, name: "Test" }; } });
  const base = await listen(agent);
  try {
    const login = () => fetch(base + "/api/session/sso", { method: "POST", body: '{"code":"fixture"}' });
    const first = await login(); const body = await first.json() as { employeeNo: string; authMethod: string; token: string };
    assert.equal(first.status, 200); assert.equal(body.employeeNo, "A"); assert.equal(lookedUp, "A");
    assert.equal(body.authMethod, "dcs_sso"); assert.ok(body.token);
    valid = false; lookedUp = "";
    assert.equal((await login()).status, 401); assert.equal(lookedUp, "");
  } finally { await close(agent); await close(dcs); }
});
