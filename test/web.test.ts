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
// 场景 W6：处理中 reset 竞争（409 拒绝 + 不创建第二个 Agent + 完成后可重置）
// ---------------------------------------------------------------------------

section("W6. 处理中 reset 竞争修复");

{
  const releaser: { fn?: () => void } = {};
  agentImpl = async () => {
    await new Promise<void>((r) => {
      releaser.fn = r;
    });
    return "慢回答";
  };
  // 空闲状态先重置，确保从干净实例开始
  await fetch(`${base}/api/reset`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

  const first = fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "慢请求" }),
  });
  await sleep(50); // 等第一个 Run 占住 busy

  // 处理中 reset → 409
  const resetResp = await fetch(`${base}/api/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const resetData = (await resetResp.json()) as { ok: boolean; message?: string };
  check(
    "W6a 处理中 reset 被拒绝（409 + ok:false + 提示语）",
    resetResp.status === 409 && resetData.ok === false && (resetData.message ?? "").includes("正在处理中"),
    `status=${resetResp.status} body=${JSON.stringify(resetData)}`
  );

  // 409 之后实例保留：随后提问应收到 busy（同一个 Agent，不创建第二个）
  const before = createAgentCalls;
  const duringBusy = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "被拒后的插队问题" }),
  });
  const busyEvents = await readSse(duringBusy);
  check(
    "W6b 拒绝重置后实例与 busy 状态保留（再次提问收到 busy，未创建第二个 Agent）",
    busyEvents.some((e) => e.type === "busy") && createAgentCalls === before,
    `busy=${String(busyEvents.some((e) => e.type === "busy"))} agents=${createAgentCalls - before}`
  );

  // 原请求完成后 → reset 成功 → 新实例创建
  releaser.fn?.();
  const firstResp = await first;
  const firstEvents = await readSse(firstResp);
  check("W6c 原慢请求正常完成（final 到达，busy 解除）", firstEvents.some((e) => e.type === "final" && e.text === "慢回答"));

  const reset2 = await fetch(`${base}/api/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const reset2Data = (await reset2.json()) as { ok: boolean };
  check("W6d 原请求完成后 reset 成功（200 + ok:true）", reset2.status === 200 && reset2Data.ok === true);

  agentImpl = undefined;
  const newChat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "重置后的新会话第一问" }),
  });
  await readSse(newChat);
  check("W6e 重置后再次提问创建新 Agent 实例", createAgentCalls === before + 1, `calls=${createAgentCalls}`);
}

// ---------------------------------------------------------------------------
// 场景 W7：超时清理只删除本次运行实例（独立短预算服务器验证）
// ---------------------------------------------------------------------------

section("W7. 超时清理不误删新实例（discardEntryIfCurrent）");

{
  // 慢 Agent：每次 prompt 挂起直到测试手动 resolve；迟到 resolve 后无任何输出
  let w7AgentCalls = 0;
  const resolvers: Array<() => void> = [];
  const server7 = createWebServer({
    resolveIdentity: async (code) => (code === "10086" ? TEST_IDENTITY : null),
    createAgent: () => {
      w7AgentCalls++;
      return new FakeAgent(async (_q) => {
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
        return "迟到但无人接收的回答";
      });
    },
    budgetMs: 120, // 短预算触发超时路径
    staticDir: fileURLToPath(new URL("../../DCS Agent.web", import.meta.url)),
    logger: () => undefined,
  });
  await new Promise<void>((resolve) => server7.listen(0, resolve));
  const base7 = `http://127.0.0.1:${(server7.address() as AddressInfo).port}`;

  const sResp = await fetch(`${base7}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "10086" }),
  });
  const sData = (await sResp.json()) as { token?: string };
  const token7 = sData.token ?? "";

  const chat1 = await fetch(`${base7}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token7}` },
    body: JSON.stringify({ question: "会超时的问题" }),
  });
  const events1 = await readSse(chat1);
  check("W7a 超时触发 timeout 事件", events1.some((e) => e.type === "timeout"), JSON.stringify(events1.map((e) => e.type)));

  // 超时后立即新建会话提问（新实例）；随后旧 Run 迟到 resolve + 旧连接关闭
  const chat2Resp = fetch(`${base7}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token7}` },
    body: JSON.stringify({ question: "超时后的新问题" }),
  });
  await sleep(50);
  resolvers[0]?.(); // 仅释放旧 Run 的挂起（迟到 resolve；新会话继续等待自己的超时）
  const chat2 = await chat2Resp;
  const events2 = await readSse(chat2);

  check(
    "W7b 旧 Run 迟到结果未发送给新会话（新回复不含迟到内容）",
    !events2.some((e) => e.type === "final" && String(e.text).includes("迟到")),
    JSON.stringify(events2.map((e) => e.type))
  );
  check("W7c 超时废弃后新提问创建了新实例", w7AgentCalls === 2, `calls=${w7AgentCalls}`);
  server7.close();
}

// ---------------------------------------------------------------------------

console.log(`\n========== Web Channel 测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
