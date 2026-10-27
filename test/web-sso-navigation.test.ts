import { fixtureAuthority, conversationFetch as fetch } from "./web-conversation-fixture.ts";
import { requireTrustedEmployee } from "../src/dcs/db/authorization.ts";
import { createNavigateDcsMenuTool } from "../src/dcs/navigation-tool.ts";
import type { DcsToolContext } from "../src/dcs/session.ts";
import type { AddressInfo } from "node:net";
import { createWebServer, type AgentLike } from "../src/web/server.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function ctx(authMethod?: "dcs_sso"): DcsToolContext {
  return { session: { user: { source: "web", userId: "web-10086", employeeNo: "10086", name: "张三", roles: [], ...(authMethod ? { authMethod } : {}) } } };
}
const prev = process.env.DCS_ALLOW_WEB_TEST_IDENTITY;
delete process.env.DCS_ALLOW_WEB_TEST_IDENTITY;
check("Web无SSO标记被拒绝", (() => { try { requireTrustedEmployee(ctx()); return false; } catch { return true; } })());
check("Web SSO标记通过", requireTrustedEmployee(ctx("dcs_sso")) === "10086");
process.env.DCS_ALLOW_WEB_TEST_IDENTITY = "true";
check("显式测试开关通过", requireTrustedEmployee(ctx()) === "10086");
delete process.env.DCS_ALLOW_WEB_TEST_IDENTITY;
const nav = createNavigateDcsMenuTool(async (emp, menu) => ({ ok: true, message: `${emp}:${menu}` }));
const navCtx = ctx("dcs_sso");
check("导航Tool使用会话员工并回传结果", (await nav.execute({ menuName: "上岗证查询" }, navCtx)).output === "10086:上岗证查询");
const denied = await nav.execute({ menuName: "上岗证查询" }, ctx());
check("导航Tool拒绝无SSO身份", denied.isError === true && denied.output.includes("unavailable"), denied.output);
check("导航Tool拒绝空参数", ((await nav.execute({ menuName: " " }, ctx("dcs_sso"))).isError ?? false) === true);

class NoopAgent implements AgentLike {
  subscribe(): () => void { return () => undefined; }
  async prompt(): Promise<string> { return "ok"; }
}
delete process.env.DCS_ALLOW_WEB_TEST_IDENTITY;
const navServer = createWebServer({ dataFile: ":memory:",
  resolveIdentity: async (code) => code === "10086" ? { employeeNo: "10086", name: "张三", department: "制造一部", roles: [] } : null,
  authority: fixtureAuthority(async (code) => code === "sso-ok" ? "10086" : null),
  createAgent: () => new NoopAgent(),
  logger: () => undefined,
  navigationTimeoutMs: 100,
});
await new Promise<void>((r) => navServer.listen(0, r));
const navBase = `http://127.0.0.1:${(navServer.address() as AddressInfo).port}`;
{
  const resp = await fetch(`${navBase}/api/session/sso`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "bad" }) });
  check("SSO无效code返回401", resp.status === 401);
  const resp2 = await fetch(`${navBase}/api/session/sso`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "sso-ok" }) });
  const data = await resp2.json() as { ok: boolean; token?: string; authMethod?: string };
  check("SSO建档返回token与dcs_sso", resp2.status === 200 && data.ok && !!data.token && data.authMethod === "dcs_sso");
  const manual = await fetch(`${navBase}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "10086" }) });
  check("正式模式手动工号入口关闭", manual.status === 404);
  const result = await fetch(`${navBase}/api/ui-action/result`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` }, body: JSON.stringify({ requestId: "missing", result: { ok: true, message: "ok" } }) });
  check("未等待中的导航结果返回404", result.status === 404);
}

console.log(`\nSSO/导航权限与接口测试：通过${passed}，失败${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
await new Promise<void>((resolve) => navServer.closeAllConnections?.() ?? navServer.close(() => resolve()));
