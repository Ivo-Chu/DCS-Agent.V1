import { fixtureAuthority, conversationFetch as fetch } from "./web-conversation-fixture.ts";
import type { DcsIdentity } from "../src/dcs/identity.ts";
import { createNavigateDcsMenuTool, type RequestNavigation } from "../src/dcs/navigation-tool.ts";
import type { DcsToolContext } from "../src/dcs/session.ts";
import { createWebServer, type AgentLike } from "../src/web/server.ts";
import type { AddressInfo } from "node:net";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

class NavigationAgent implements AgentLike {
  private readonly requestNavigation: RequestNavigation;
  constructor(requestNavigation: RequestNavigation) { this.requestNavigation = requestNavigation; }
  subscribe(): () => void { return () => undefined; }
  async prompt(): Promise<string> {
    const ctx: DcsToolContext = {
      session: { user: { source: "web", userId: "web-10086", employeeNo: "10086", name: "张三", roles: [], authMethod: "dcs_sso" } },
    };
    const tool = createNavigateDcsMenuTool(this.requestNavigation);
    return (await tool.execute({ menuName: "上岗证查询" }, ctx)).output;
  }
}

function createIdentity(employeeNo: string): DcsIdentity {
  return { employeeNo, name: `员工${employeeNo}`, department: "制造一部", roles: [] };
}

async function startServer(navigationTimeoutMs: number) {
  const server = createWebServer({ dataFile: ":memory:",
    resolveIdentity: async (code) => code === "10086" || code === "20001" ? createIdentity(code) : null,
    authority: fixtureAuthority(async (code) => code.startsWith("sso-") ? code.slice(4) : null),
    createAgent: (_identity, _holder, _auth, requestNavigation) => new NavigationAgent(requestNavigation),
    logger: () => undefined,
    navigationTimeoutMs,
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function login(base: string, code: string): Promise<string> {
  const res = await fetch(`${base}/api/session/sso`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return ((await res.json()) as { token: string }).token;
}

function parseFrame(frame: string): Record<string, unknown> | null {
  const line = frame.split("\n").find((item) => item.startsWith("data: "));
  if (!line) return null;
  try { return JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { return null; }
}

interface SseCursor {
  events: Record<string, unknown>[];
  buffer: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
}

/** 增量读取 SSE；onEvent 返回 true 时暂停，返回 cursor 后可用同一 reader 继续。 */
async function readSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => boolean | Promise<boolean>
): Promise<SseCursor> {
  if (!response.body) throw new Error("SSE response body missing");
  const cursor: SseCursor = {
    events: [],
    buffer: "",
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
  };
  return await continueSse(cursor, onEvent);
}

async function continueSse(
  cursor: SseCursor,
  onEvent: (event: Record<string, unknown>) => boolean | Promise<boolean>
): Promise<SseCursor> {
  for (;;) {
    const { value, done } = await cursor.reader.read();
    if (done) return cursor;
    cursor.buffer += cursor.decoder.decode(value, { stream: true });
    const frames = cursor.buffer.split("\n\n");
    cursor.buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (!event) continue;
      cursor.events.push(event);
      if (await onEvent(event)) return cursor;
    }
  }
}

// 1. 真实 execute → SSE ui_action → result 回传 → ToolResult
{
  const { server, base } = await startServer(2000);
  const token = await login(base, "sso-10086");
  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "打开上岗证查询" }),
  });

  let requestId = "";
  const firstPass = await readSse(chat, (event) => {
    if (event.type !== "ui_action") return false;
    requestId = String(event.requestId ?? "");
    return true;
  });
  const ui = firstPass.events.find((e) => e.type === "ui_action") as { requestId?: string; payload?: { menuName?: string } } | undefined;
  check("工具 execute 后发送 ui_action", !!ui?.requestId && ui.payload?.menuName === "上岗证查询", JSON.stringify(ui));

  const unknown = await fetch(`${base}/api/ui-action/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: "wrong", result: { ok: true, message: "不应配对" } }),
  });
  check("未知 requestId 不接受", unknown.status === 404);

  const accepted = await fetch(`${base}/api/ui-action/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId, result: { ok: true, message: "已打开：上岗证查询" } }),
  });
  check("真实 requestId 回传被接受", accepted.status === 200, `status=${accepted.status}`);

  const rest = await continueSse(firstPass, () => false);
  const final = rest.events.at(-1);
  check("导航结果回填 final", final?.type === "final" && final.text === "已打开：上岗证查询", JSON.stringify(final));

  const repeat = await fetch(`${base}/api/ui-action/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId, result: { ok: true, message: "重复结果" } }),
  });
  check("重复 requestId 返回 404", repeat.status === 404);

  await new Promise<void>((r) => server.closeAllConnections?.() ?? server.close(() => r()));
}

// 2. 超时返回错误
{
  const { server, base } = await startServer(80);
  const token = await login(base, "sso-10086");
  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "打开上岗证查询" }),
  });
  const { events } = await readSse(chat, () => false);
  const ui = events.find((e) => e.type === "ui_action");
  const final = events.at(-1);
  check("浏览器超时后 Tool 返回错误", !!ui && final?.type === "final" && String(final?.text ?? "").includes("unavailable"), JSON.stringify(final));
  await new Promise<void>((r) => server.closeAllConnections?.() ?? server.close(() => r()));
}

// 3. 跨员工 requestId 不串线
{
  const { server, base } = await startServer(150);
  const aToken = await login(base, "sso-10086");
  const bToken = await login(base, "sso-20001");
  const aChat = fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${aToken}` },
    body: JSON.stringify({ question: "打开上岗证查询" }),
  });
  await new Promise((r) => setTimeout(r, 50));
  const bCross = await fetch(`${base}/api/ui-action/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bToken}` },
    body: JSON.stringify({ requestId: "nav-any", result: { ok: true, message: "跨员工结果" } }),
  });
  check("跨员工结果不被接受", bCross.status === 404);
  const aResp = await aChat;
  const cursor = await readSse(aResp, event => event.type === "ui_action");
  const aUi = cursor.events.find((e) => e.type === "ui_action");
  const bCrossReal = await fetch(`${base}/api/ui-action/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bToken}` },
    body: JSON.stringify({ requestId: String(aUi?.requestId ?? ""), result: { ok: true, message: "跨员工结果" } }),
  });
  check("员工B不能回传员工A的真实requestId", bCrossReal.status === 404);
  await continueSse(cursor, () => false);
  await new Promise<void>((r) => server.closeAllConnections?.() ?? server.close(() => r()));
}

console.log(`\nWeb Navigation Bridge 测试：通过${passed}，失败${failed}`);
process.exitCode = failed > 0 ? 1 : 0;




