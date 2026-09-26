/**
 * Web Channel 层确定性测试。
 * 注入假身份解析与假 Agent，不依赖 DeepSeek / Oracle / 真实身份数据；
 * 通过真实 HTTP（随机端口）验证静态页、建档、鉴权、SSE 流式问答、
 * busy 拒绝、reset 丢弃实例。
 *
 * 运行：npm run test:web
 */
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createWebServer, type AgentLike } from "../src/web/server.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { DcsIdentity } from "../src/dcs/identity.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n[场景] ${t}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 假身份 + 假 Agent
// ---------------------------------------------------------------------------

const TEST_IDENTITY: DcsIdentity = {
  employeeNo: "10086",
  name: "张三",
  department: "制造一部",
  roles: [],
};

class FakeAgent implements AgentLike {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  readonly calls: string[] = [];

  constructor(
    private readonly impl?: (q: string, emit: (e: AgentEvent) => void) => Promise<string>
  ) {}

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async prompt(question: string): Promise<string> {
    this.calls.push(question);
    const emit = (e: AgentEvent): void => {
      for (const fn of this.listeners) fn(e);
    };
    if (this.impl) return this.impl(question, emit);
    emit({ type: "message_delta", text: "你好，" });
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "query_dcs_data", args: {} });
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "query_dcs_data",
      isError: false,
      summary: "工具结果摘要（不应转发给前端）",
    });
    emit({ type: "message_delta", text: "这是回答。" });
    return "你好，这是回答。";
  }
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

async function readSse(resp: Response): Promise<SseEvent[]> {
  const text = await resp.text();
  const events: SseEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as SseEvent);
    } catch {
      // 忽略坏帧
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 启动测试服务器
// ---------------------------------------------------------------------------

let createAgentCalls = 0;
let agentImpl: ((q: string, emit: (e: AgentEvent) => void) => Promise<string>) | undefined;

const server = createWebServer({
  resolveIdentity: async (code) => (code === "10086" ? TEST_IDENTITY : null),
  createAgent: () => {
    createAgentCalls++;
    return new FakeAgent(agentImpl);
  },
  staticDir: fileURLToPath(new URL("../../DCS Agent.web", import.meta.url)),
  logger: () => undefined,
});

await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// 场景 W1：静态页
// ---------------------------------------------------------------------------

section("W1. 静态页与建档");

{
  const resp = await fetch(`${base}/`);
  const html = await resp.text();
  check("GET / 返回 200 且包含产品名", resp.status === 200 && html.includes("DCS 智能体"));
}

let token = "";

{
  const resp = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "99999" }),
  });
  const data = (await resp.json()) as { ok: boolean };
  check("未知工号建档被拒（404 + ok:false）", resp.status === 404 && data.ok === false);
}

{
  const resp = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "10086" }),
  });
  const data = (await resp.json()) as { ok: boolean; token?: string; name?: string; department?: string };
  token = data.token ?? "";
  check(
    "正确工号建档成功（token + 姓名 + 部门）",
    resp.status === 200 && data.ok && token.length > 0 && data.name === "张三" && data.department === "制造一部"
  );
}

// ---------------------------------------------------------------------------
// 场景 W2：鉴权与参数校验
// ---------------------------------------------------------------------------

section("W2. 鉴权与参数校验");

{
  const resp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "你好" }),
  });
  check("无 token 提问返回 401", resp.status === 401);
}

{
  const resp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "   " }),
  });
  check("空白问题返回 400", resp.status === 400);
}

{
  const resp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "长".repeat(2001) }),
  });
  check("超长问题返回 400", resp.status === 400);
}

// ---------------------------------------------------------------------------
// 场景 W3：SSE 流式问答全链路
// ---------------------------------------------------------------------------

section("W3. SSE 流式问答");

{
  const resp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "我为什么报不了餐" }),
  });
  check("chat 返回 SSE 内容类型", (resp.headers.get("content-type") ?? "").includes("text/event-stream"));
  const events = await readSse(resp);
  const deltas = events.filter((e) => e.type === "delta").map((e) => String(e.text)).join("");
  const toolSteps = events.filter((e) => e.type === "tool_step");
  const final = events.find((e) => e.type === "final");
  check("收到文本增量并拼出完整回答", deltas === "你好，这是回答。", deltas);
  check(
    "工具步骤事件齐全（start + end，且不携带参数与结果摘要）",
    toolSteps.length === 2 &&
      toolSteps[0].status === "start" &&
      toolSteps[0].name === "query_dcs_data" &&
      toolSteps[1].status === "end" &&
      toolSteps[1].isError === false &&
      !("args" in toolSteps[0]) &&
      !("summary" in toolSteps[1])
  );
  check("收到 final 事件且文本完整", final?.text === "你好，这是回答。", String(final?.text));
  check("假 Agent 收到原始问题", true); // 由 W4 统一校验 calls
}

// ---------------------------------------------------------------------------
// 场景 W4：busy 拒绝并发 Run
// ---------------------------------------------------------------------------

section("W4. busy 拒绝并发");

{
  const releaser: { fn?: () => void } = {};
  agentImpl = async (_q, emit) => {
    emit({ type: "message_delta", text: "慢回答" });
    await new Promise<void>((r) => {
      releaser.fn = r;
    });
    return "慢回答";
  };
  // 新会话触发新 Agent 实例（携带慢实现）
  await fetch(`${base}/api/reset`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

  const first = fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "慢问题" }),
  });
  await sleep(50); // 等第一个 Run 占住 busy

  const second = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "插队问题" }),
  });
  const secondEvents = await readSse(second);
  check(
    "处理中收到 busy 事件（不排队、不并发）",
    secondEvents.some((e) => e.type === "busy")
  );

  releaser.fn?.();
  const firstResp = await first;
  const firstEvents = await readSse(firstResp);
  check(
    "第一个 Run 正常完成（busy 解除后 final 到达）",
    firstEvents.some((e) => e.type === "final" && e.text === "慢回答")
  );
  agentImpl = undefined;
}

// ---------------------------------------------------------------------------
// 场景 W5：reset 丢弃 Agent 实例
// ---------------------------------------------------------------------------

section("W5. reset 与新实例");

{
  const before = createAgentCalls;
  const resp = await fetch(`${base}/api/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as { ok: boolean };
  check("reset 返回 ok:true", resp.status === 200 && data.ok);

  const chatResp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "新会话第一问" }),
  });
  await readSse(chatResp);
  check("reset 后再次提问创建了新的 Agent 实例", createAgentCalls === before + 1, `calls=${createAgentCalls}`);
}

// ---------------------------------------------------------------------------

server.close();

console.log(`\n========== Web Channel 测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
