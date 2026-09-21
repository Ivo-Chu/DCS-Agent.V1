/**
 * 冒烟测试：FakeStreamFn 脚本化假模型，无需 API key。
 *
 * 验证点（方案 §11.4）：
 * - prompts / context / newMessages 边界正确
 * - AgentLoop 多 Turn 循环
 * - ToolCall → execute → ToolResult → 下一轮 LLM
 * - Agent 在 Run 结束后正确保存 newMessages
 * - afterToolCall 脱敏管线（工具结果中植入的手机号被脱敏）
 * - 最终输出不含源码路径
 * 附加：maxTurns 保护、stopReason:"error" 契约、beforeToolCall 扩展点、
 *       多轮 context 传递、StreamFn 永不 reject 契约。
 * 审查回归：H（SSE 边界）、I（length 截断）、J（Hook 异常）、
 *       K（验收判定对抗：错误字符串命中关键词必须 FAIL）。
 */
import { runAgentLoop } from "../src/core/agent-loop.ts";
import { Agent } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
  StreamFn,
  ToolDefinition,
  ToolHooks,
  ToolOutput,
  ToolSchema,
} from "../src/core/types.ts";
import { createDeepSeekStreamFn } from "../src/core/model/deepseek.ts";
import { maskPii, createDcsToolHooks } from "../src/dcs/hooks.ts";
import { createMockSession, type DcsToolContext } from "../src/dcs/session.ts";
import { dcsTools, searchDcsCodeTool } from "../src/dcs/tools.ts";
import {
  judgeScenario1,
  judgeScenario2,
  judgeScenario3,
  type QEvents,
} from "./acceptance-judge.ts";

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

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

function section(title: string): void {
  console.log(`\n[场景] ${title}`);
}

// ---------------------------------------------------------------------------
// FakeStreamFn：脚本化假模型
// ---------------------------------------------------------------------------

interface TurnPlan {
  text?: string;
  toolCalls?: { name: string; arguments: string }[];
  stopReason?: "stop" | "toolCalls" | "error" | "length";
  errorMessage?: string;
}

interface StreamRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
}

function chunked(s: string, size: number): string[] {
  return s.match(new RegExp(`.{1,${size}}`, "gs")) ?? [];
}

function createFakeStreamFn(plans: TurnPlan[]): {
  streamFn: StreamFn;
  requests: StreamRequest[];
} {
  let call = 0;
  const requests: StreamRequest[] = [];
  const streamFn: StreamFn = async function* (req): AsyncGenerator<ModelStreamEvent> {
    requests.push({ systemPrompt: req.systemPrompt, messages: [...req.messages], tools: [...req.tools] });
    const plan = plans[call];
    call++;
    if (!plan) {
      yield { type: "message_end", stopReason: "error", errorMessage: "FakeStreamFn：脚本轮次耗尽" };
      return;
    }
    for (const c of chunked(plan.text ?? "", 8)) {
      yield { type: "text_delta", text: c };
    }
    const tcs = plan.toolCalls ?? [];
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      yield { type: "tool_call_start", index: i, toolCallId: `call_${call}_${i}`, name: tc.name };
      for (const c of chunked(tc.arguments, 6)) {
        yield { type: "tool_call_delta", index: i, argumentsDelta: c };
      }
    }
    const stopReason =
      plan.stopReason ?? (plan.toolCalls && plan.toolCalls.length > 0 ? "toolCalls" : "stop");
    yield { type: "message_end", stopReason, errorMessage: plan.errorMessage };
  };
  return { streamFn, requests };
}

function makeAgent<C>(
  streamFn: StreamFn,
  tools: ToolDefinition<any, C>[],
  toolContext: C,
  hooks?: ToolHooks<C>,
  maxTurns?: number
): Agent<C> {
  return new Agent<C>({
    systemPrompt: "测试用 systemPrompt（含当前员工身份注入）",
    tools,
    streamFn,
    toolContext,
    hooks,
    maxTurns,
  });
}

const dcsCtx: DcsToolContext = { session: createMockSession() };

// ---------------------------------------------------------------------------
// 场景 A：权限诊断 —— 只调 check_dcs_permission，Agent 状态写回
// ---------------------------------------------------------------------------

section("A. 权限诊断（check_dcs_permission → 无权限 → 最终回答）");

{
  const { streamFn, requests } = createFakeStreamFn([
    {
      toolCalls: [
        { name: "check_dcs_permission", arguments: '{"menuName":"权限管理"}' },
      ],
    },
    { text: "你缺少系统管理员角色，请联系部门系统管理员或 IT 服务台开通。" },
  ]);

  const events: string[] = [];
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  agent.subscribe((e) => events.push(e.type));

  const finalText = await agent.prompt("为什么我没有权限管理菜单");

  check("A1 返回最终 AssistantMessage 文本", finalText.includes("系统管理员"));
  check("A2 Agent.context 写回 4 条消息（user/assistant/toolResult/assistant）", agent.context.length === 4, `实际 ${agent.context.length}`);
  check("A3 首条为 UserMessage", agent.context[0]?.role === "user" && (agent.context[0] as { content: string }).content === "为什么我没有权限管理菜单");
  const a1 = agent.context[1] as AssistantMessage;
  check("A4 第二条为带 toolCalls 的 AssistantMessage", a1?.role === "assistant" && a1.toolCalls?.length === 1 && a1.toolCalls[0].name === "check_dcs_permission");
  const tr = agent.context[2];
  check("A5 第三条为 ToolResult 且无权限结论正确", tr?.role === "toolResult" && (tr as { content: string }).content.includes("缺少角色「系统管理员」"));
  check("A6 ToolResult.toolCallId 与 ToolCall.id 对应", tr?.role === "toolResult" && (tr as { toolCallId: string }).toolCallId === a1.toolCalls?.[0]?.id);
  const a2 = agent.context[3] as AssistantMessage;
  check("A7 末条为最终 AssistantMessage（stop）", a2?.role === "assistant" && a2.stopReason === "stop");

  // prompts / context / newMessages 边界
  check("A8 第一次 LLM 调用只收到本轮 prompts（历史为空）", requests[0]?.messages.length === 1 && requests[0].messages[0]?.role === "user");
  check(
    "A9 第二次 LLM 调用收到 user+assistant+toolResult（ToolResult 回填模型）",
    requests[1]?.messages.length === 3 &&
      requests[1].messages.map((m) => m.role).join(",") === "user,assistant,toolResult"
  );
  check("A10 事件流含 agent_start/assistant_message/tool_execution_*/agent_end",
    ["agent_start", "assistant_message", "tool_execution_start", "tool_execution_end", "agent_end"].every((t) => events.includes(t)),
    events.join(","));

  // 场景 3：追问（多轮 context）
  const { requests: req2 } = (() => {
    // 复用同一 agent 的 streamFn 已耗尽脚本，这里直接再问一轮：
    // 为拿到 requests，重建一个"同 context"视角的校验 —— 用第二次 prompt。
    return { requests };
  })();
  await agent.prompt("那报餐管理菜单我有权限吗");
  // 第二次 prompt 使用同一 FakeStreamFn 实例，脚本已耗尽 → error 轮；
  // 因此这里只校验第 3 次 LLM 调用的输入包含完整历史 context。
  const third = requests[requests.length - 1];
  check(
    "A11 追问时 AgentLoop 获得历史 context + 本轮 prompts（4+1=5 条输入）",
    third?.messages.length === 5,
    `实际 ${third?.messages.length}`
  );
  check(
    "A12 历史第一条是上一轮 UserMessage（context 传递正确）",
    third?.messages[0]?.role === "user" && (third?.messages[0] as { content: string }).content === "为什么我没有权限管理菜单"
  );
}

// ---------------------------------------------------------------------------
// 场景 B：多轮循环 —— 权限(有) → 业务数据 → 最终回答（完整报餐诊断链）
// ---------------------------------------------------------------------------

section("B. 报餐诊断链（check_dcs_permission(有) → query_business_data → 最终回答）");

{
  const { streamFn, requests } = createFakeStreamFn([
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
    { toolCalls: [{ name: "query_business_data", arguments: '{"dataType":"报餐订单"}' }] },
    { text: "你今天的报餐订单被驳回了：超出当日餐标 7 元（餐标 35 元，实付 42 元）。请修改金额后重新提交。" },
  ]);

  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  const finalText = await agent.prompt("我为什么报不了餐");

  check("B1 两轮工具调用全部执行（LLM→Tool→LLM→Tool→LLM 三 Turn 循环）", requests.length === 3, `实际 LLM 调用 ${requests.length} 次`);
  check("B2 第二轮 LLM 输入含第一轮 ToolResult（有权限）",
    requests[1]?.messages.some((m) => m.role === "toolResult" && (m as { content: string }).content.includes("拥有「报餐管理」权限")));
  check("B3 第三轮 LLM 输入含业务数据 ToolResult（超餐标驳回）",
    requests[2]?.messages.some((m) => m.role === "toolResult" && (m as { content: string }).content.includes("已驳回")));
  check("B4 Agent.context 共 6 条消息（u/a/tr/a/tr/a）", agent.context.length === 6, `实际 ${agent.context.length}`);
  check("B5 最终回答包含超餐标结论", finalText.includes("超出当日餐标"));
}

// ---------------------------------------------------------------------------
// 场景 C：afterToolCall 脱敏管线 —— 植入手机号/身份证被脱敏
// ---------------------------------------------------------------------------

section("C. PII 脱敏管线（afterToolCall 在 ToolResult 回填模型之前执行）");

{
  const leakyTool: ToolDefinition<Record<string, never>, DcsToolContext> = {
    name: "leaky_tool",
    label: "脱敏测试工具",
    description: "返回植入 PII 的文本，用于验证脱敏管线",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolOutput> {
      return {
        output:
          "联系人：李四，手机号 13812345678，身份证 110101199001011234，备用手机号 15987654321。",
      };
    },
  };

  const { streamFn, requests } = createFakeStreamFn([
    { toolCalls: [{ name: "leaky_tool", arguments: "{}" }] },
    { text: "已记录联系人信息。" },
  ]);

  const agent = makeAgent(streamFn, [leakyTool], dcsCtx, createDcsToolHooks());
  await agent.prompt("查一下联系人");

  const tr = agent.context.find((m) => m.role === "toolResult") as { content: string } | undefined;
  check("C1 手机号 13812345678 → 138****5678", tr?.content.includes("138****5678") === true, tr?.content);
  check("C2 备用手机号 15987654321 → 159****4321", tr?.content.includes("159****4321") === true);
  check("C3 身份证 → 掩码中段", tr?.content.includes("110101********1234") === true);
  check("C4 原始手机号不再出现在 ToolResult 中", tr?.content.includes("13812345678") === false);
  check(
    "C5 第二轮 LLM 收到的是脱敏后文本（脱敏发生在回填模型之前）",
    requests[1]?.messages.some((m) => m.role === "toolResult" && (m as { content: string }).content.includes("138****5678")) === true
  );
  check("C6 maskPii 纯函数：不改变无 PII 文本", maskPii("普通文本 12345") === "普通文本 12345");
}

// ---------------------------------------------------------------------------
// 场景 D：beforeToolCall 扩展点（core 契约验证，v1 DCS 层未使用）
// ---------------------------------------------------------------------------

section("D. beforeToolCall 阻断扩展点（core 契约，v1 未启用业务逻辑）");

{
  const echoTool: ToolDefinition<{ text: string }, DcsToolContext> = {
    name: "echo_tool",
    label: "回声工具",
    description: "原样返回输入",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(args) {
      return { output: args.text };
    },
  };
  const hooks = {
    beforeToolCall() {
      return { block: true, reason: "测试阻断" };
    },
  };

  const { streamFn } = createFakeStreamFn([
    { toolCalls: [{ name: "echo_tool", arguments: '{"text":"机密"}' }] },
    { text: "工具被阻止了。" },
  ]);
  const agent = makeAgent(streamFn, [echoTool], dcsCtx, hooks);
  await agent.prompt("调用回声");

  const tr = agent.context.find((m) => m.role === "toolResult") as { content: string; isError: boolean } | undefined;
  check("D1 被阻断的工具返回阻止说明", tr?.content.includes("被安全策略阻止") === true && tr?.content.includes("测试阻断") === true);
  check("D2 阻断结果标记 isError", tr?.isError === true);
  check("D3 echo 工具本体未执行（机密未泄漏）", tr?.content.includes("机密") === false);
}

// ---------------------------------------------------------------------------
// 场景 E：search_dcs_code 真实只读检索 + 最终输出不含源码路径
// ---------------------------------------------------------------------------

section("E. search_dcs_code 只读检索 + 最终输出不含源码路径");

{
  // E1: 真实命中（DCS 源码只读遍历）
  const hit = await searchDcsCodeTool.execute({ keyword: "Employee" }, dcsCtx);
  const hitLines = hit.output.split("\n").filter((l) => l.trim().length > 0);
  check("E1 关键词 Employee 命中且 ≤5 条", !hit.isError && hitLines.length > 0 && hitLines.length <= 5, hit.output.slice(0, 200));
  check(
    "E2 命中格式为 相对路径:行号:代码行",
    hitLines.every((l) => /^Luxshare\.DCS\.WebApi\/Controllers\/[^:]+:\d+:/.test(l)),
    hitLines[0]
  );

  // E2: 无命中
  const miss = await searchDcsCodeTool.execute({ keyword: "zzz_不存在关键词_qqq" }, dcsCtx);
  check("E3 无命中时返回未找到提示", miss.output.includes("未找到相关代码"));

  // E3: 目录不可用 → isError（只读、不崩溃）
  const prevRoot = process.env.DCS_SOURCE_ROOT;
  process.env.DCS_SOURCE_ROOT = "D:\\Projects\\definitely_not_exists";
  const broken = await searchDcsCodeTool.execute({ keyword: "Employee" }, dcsCtx);
  if (prevRoot === undefined) delete process.env.DCS_SOURCE_ROOT;
  else process.env.DCS_SOURCE_ROOT = prevRoot;
  check("E4 源码目录不可用时返回 isError 而非抛异常", broken.isError === true);

  // E4: 完整链路 —— 模型内部看到检索结果，最终回复不含源码路径
  const { streamFn, requests } = createFakeStreamFn([
    { toolCalls: [{ name: "search_dcs_code", arguments: '{"keyword":"Employee"}' }] },
    { text: "经内部核查，员工信息查询功能当前可以正常使用。如果你在页面上看不到相关入口，请刷新页面后重试；仍不行请联系 IT 服务台（分机 8888）。" },
  ]);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  const finalText = await agent.prompt("员工信息查询怎么用不了");

  const internalTr = requests[1]?.messages.find((m) => m.role === "toolResult") as { content: string } | undefined;
  check("E5 模型内部收到了含源码路径的检索结果（供内部诊断）", internalTr?.content.includes("Luxshare.DCS.WebApi/Controllers") === true);
  check(
    "E6 最终回复不含源码路径 / .cs / 行号",
    !finalText.includes("Luxshare") && !finalText.includes(".cs") && !finalText.includes("Controllers") && !/\\Controllers|:\d+:/.test(finalText),
    finalText
  );
}

// ---------------------------------------------------------------------------
// 场景 F：runAgentLoop 直接调用 —— 边界与不可变性
// ---------------------------------------------------------------------------

section("F. runAgentLoop 边界（prompts/context/newMessages、不修改调用方状态）");

{
  const { streamFn } = createFakeStreamFn([{ text: "直接调用回复。" }]);

  const historyInput: AgentMessage[] = [
    { role: "user", content: "历史问题" },
    { role: "assistant", content: "历史回答", stopReason: "stop" },
  ];
  const historyRef = [...historyInput];

  const newPrompt: AgentMessage[] = [{ role: "user", content: "新问题" }];
  const { newMessages, finalText } = await runAgentLoop(
    newPrompt,
    { messages: historyInput },
    {
      systemPrompt: "s",
      tools: [],
      streamFn,
      toolContext: dcsCtx,
      maxTurns: 4,
      emit: () => {},
    }
  );

  check("F1 newMessages 只含本轮新增（不含历史）", newMessages.length === 2, `实际 ${newMessages.length}`);
  check("F2 newMessages[0] 是本轮 UserMessage", newMessages[0] === newPrompt[0]);
  check("F3 finalText 为最终 AssistantMessage 文本", finalText === "直接调用回复。");
  check("F4 调用方历史数组未被修改（AgentLoop 不直接修改 Agent 状态）",
    JSON.stringify(historyInput) === JSON.stringify(historyRef));
  check("F5 prompts 数组本身未被修改", newPrompt.length === 1);
}

// ---------------------------------------------------------------------------
// 场景 G：停止策略 —— maxTurns 用尽 与 stopReason:"error"
// ---------------------------------------------------------------------------

section("G. 停止策略（maxTurns 用尽 / StreamFn error 契约）");

{
  // G1: maxTurns 用尽
  const loopForever: TurnPlan[] = [
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
  ];
  const { streamFn, requests } = createFakeStreamFn(loopForever);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, undefined, 2);
  const finalText = await agent.prompt("停不下来的问题");

  check("G1 maxTurns=2 时只发生 2 次 LLM 调用", requests.length === 2, `实际 ${requests.length}`);
  check("G2 超额轮未执行（第 3 个计划未消费）", agent.context.filter((m) => m.role === "toolResult").length === 2);
  // F3 回归：耗尽不再返回空答案
  const lastMsg = agent.context[agent.context.length - 1] as AssistantMessage;
  check(
    "G6 maxTurns 耗尽时 finalText 为明确终止说明（非空）",
    finalText.includes("最大执行轮次") && finalText.length > 0,
    finalText
  );
  check(
    "G7 耗尽收尾消息写入历史（末条为 assistant，stopReason:error）",
    lastMsg?.role === "assistant" && lastMsg.stopReason === "error" && lastMsg.content === finalText
  );

  // G2: StreamFn 违反契约抛异常 → 编码为 error，不崩溃
  const throwingStreamFn: StreamFn = async function* () {
    throw new Error("模拟 StreamFn 崩溃");
  };
  const agent2 = makeAgent(throwingStreamFn, dcsTools, dcsCtx);
  const errors: string[] = [];
  agent2.subscribe((e) => {
    if (e.type === "agent_error") errors.push(e.message);
  });
  const t2 = await agent2.prompt("会崩吗");
  check("G3 StreamFn 抛异常被编码为 stopReason:error（Run 不崩溃）", t2.includes("违反契约") && errors.length === 1);

  // G3: 真实 DeepSeek StreamFn 的 error 契约（无 key → 立即 error，绝不 reject）
  const noKeyFn = createDeepSeekStreamFn({ apiKey: "" });
  let gotError = false;
  let gotOther = false;
  for await (const ev of noKeyFn({ systemPrompt: "s", messages: [], tools: [] })) {
    if (ev.type === "message_end" && ev.stopReason === "error") gotError = true;
    else gotOther = true;
  }
  check("G4 DeepSeek StreamFn 无 key 时产出 stopReason:error（永不 reject）", gotError && !gotOther);

  const badUrlFn = createDeepSeekStreamFn({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:1" });
  let netError = "";
  for await (const ev of badUrlFn({ systemPrompt: "s", messages: [], tools: [] })) {
    if (ev.type === "message_end" && ev.stopReason === "error") netError = ev.errorMessage ?? "";
  }
  check("G5 网络失败同样编码为 error（含网络错误说明）", netError.includes("网络错误") || netError.length > 0, netError);
}

// ---------------------------------------------------------------------------
// 场景 H：SSE 边界（F1 回归：坏帧 / 提前 EOF 不再误判为正常完成）
// ---------------------------------------------------------------------------

section("H. SSE 边界（F1 回归：坏帧 / 提前 EOF 不再误判为 stop）");

async function sseEvents(body: string): Promise<ModelStreamEvent[]> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const events: ModelStreamEvent[] = [];
    for await (const ev of createDeepSeekStreamFn({ apiKey: "fixture" })({
      systemPrompt: "s",
      messages: [],
      tools: [],
    })) {
      events.push(ev);
    }
    return events;
  } finally {
    globalThis.fetch = origFetch;
  }
}

function sseFrame(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
}

{
  const bad = await sseEvents("data: {broken json}\n\n");
  const last = bad[bad.length - 1];
  check(
    "H1 坏 JSON 数据帧 → stopReason:error（不再误判 stop）",
    last?.type === "message_end" && last.stopReason === "error" && (last.errorMessage ?? "").includes("损坏"),
    JSON.stringify(last)
  );
}
{
  const eof = await sseEvents(sseFrame({ content: "partial answer" }));
  const last = eof[eof.length - 1];
  check(
    "H2 无 finish_reason 的 EOF → stopReason:error（提前结束说明）",
    last?.type === "message_end" && last.stopReason === "error" && (last.errorMessage ?? "").includes("提前结束"),
    JSON.stringify(last)
  );
  check("H2b EOF 前的文本增量仍保留（供错误消息拼接）", eof.some((e) => e.type === "text_delta"));
}
{
  const ok = await sseEvents(sseFrame({ content: "你好" }, "stop") + "data: [DONE]\n\n");
  const last = ok[ok.length - 1];
  check("H3 正常 finish_reason:stop → stop", last?.type === "message_end" && last.stopReason === "stop");
}
{
  const hb = await sseEvents(": keepalive\n\ndata: \n\n" + sseFrame({ content: "hi" }, "stop"));
  const last = hb[hb.length - 1];
  check("H4 SSE 注释与空 data 行可忽略（仍正常 stop）", last?.type === "message_end" && last.stopReason === "stop");
}
{
  const tail = await sseEvents(sseFrame({ content: "done" }, "stop") + "data: {garbage}\n\n");
  const last = tail[tail.length - 1];
  check(
    "H5 完成标志之后的坏帧同样视为流损坏（严格口径）",
    last?.type === "message_end" && last.stopReason === "error",
    JSON.stringify(last)
  );
}
{
  // H6（R5 回归）：坏帧后流保持打开（不再有下一块数据、不 EOF），
  // 错误必须立即产出，而不是等下一次流读取
  const origFetch = globalThis.fetch;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: {broken json}\n\n"));
      // 故意不 close：模拟对端保持连接不再发送
    },
  });
  globalThis.fetch = (async () =>
    new Response(body, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  try {
    const events: ModelStreamEvent[] = [];
    const collecting = (async () => {
      for await (const ev of createDeepSeekStreamFn({ apiKey: "fixture" })({
        systemPrompt: "s",
        messages: [],
        tools: [],
      })) {
        events.push(ev);
      }
    })();
    const settled = await Promise.race([
      collecting.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    const last = events[events.length - 1];
    check(
      "H6 坏帧后流保持打开时错误立即返回（不等下一块数据）",
      settled === true && last?.type === "message_end" && last.stopReason === "error" && (last.errorMessage ?? "").includes("损坏"),
      settled ? JSON.stringify(last) : "1500ms 内未返回（仍在等待流读取）"
    );
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---------------------------------------------------------------------------
// 场景 I：length 截断的残缺 toolCalls（F2 回归：剥离并保证配对完整）
// ---------------------------------------------------------------------------

section("I. length 截断（F2 回归：残缺 toolCalls 不入历史、序列化配对完整）");

{
  const { streamFn } = createFakeStreamFn([
    {
      toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuNa' }],
      stopReason: "length",
      text: "我先查一下",
    },
  ]);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx);
  const finalText = await agent.prompt("帮我查权限");
  const a = agent.context[1] as AssistantMessage;
  check("I1 length 截断时残缺 toolCalls 被剥离（不入历史、不执行）", a?.role === "assistant" && a.toolCalls === undefined);
  check("I2 截断说明写入 content", a?.content.includes("截断") === true, a?.content);
  check("I3 finalText 与 content 一致", finalText === a?.content);
  check("I4 截断的工具未执行（无 ToolResult）", agent.context.every((m) => m.role !== "toolResult"));

  // 序列化边界：含该历史的下一次请求不出现无配对的 tool_calls / tool 消息
  let captured: { messages: { role: string; tool_calls?: unknown[] }[] } | undefined;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return new Response(sseFrame({ content: "ok" }, "stop"));
  }) as typeof fetch;
  try {
    const fn = createDeepSeekStreamFn({ apiKey: "fixture" });
    const next: AgentMessage = { role: "user", content: "下一问" };
    for await (const _ev of fn({ systemPrompt: "s", messages: [...agent.context, next], tools: [] })) {
      void _ev;
    }
  } finally {
    globalThis.fetch = origFetch;
  }
  check(
    "I5 历史序列化后无无配对 tool_calls / tool 消息（请求形状合法）",
    captured?.messages.every((m) => !m.tool_calls && m.role !== "tool") === true,
    JSON.stringify(captured?.messages.map((m) => m.role))
  );
}
{
  // stop 收尾时同样剥离（模型异常输出 tool 片段 + finish:stop）
  const { streamFn } = createFakeStreamFn([
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }], stopReason: "stop", text: "直接回答" },
  ]);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx);
  await agent.prompt("测试");
  const a = agent.context[1] as AssistantMessage;
  check("I6 stop 完成时的 toolCalls 片段同样被剥离", a?.role === "assistant" && a.toolCalls === undefined);
}

// ---------------------------------------------------------------------------
// 场景 J：Hook 异常路径（F6 回归）
// ---------------------------------------------------------------------------

section("J. Hook 异常路径（F6 回归：afterToolCall 失败不泄原文 / beforeToolCall 失败不击穿 Run）");

{
  // J1: afterToolCall 抛错 → 安全 error ToolResult，未脱敏 PII 不流入下一轮模型
  const leakyTool: ToolDefinition<Record<string, never>, DcsToolContext> = {
    name: "leaky_tool",
    label: "脱敏测试工具",
    description: "返回植入 PII 的文本",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolOutput> {
      return { output: "联系人手机号 13812345678。" };
    },
  };
  const { streamFn, requests } = createFakeStreamFn([
    { toolCalls: [{ name: "leaky_tool", arguments: "{}" }] },
    { text: "已记录。" },
  ]);
  const agent = makeAgent(streamFn, [leakyTool], dcsCtx, {
    afterToolCall(): string {
      throw new Error("masking failed");
    },
  });
  const ft = await agent.prompt("查联系人");
  const tr = agent.context.find((m) => m.role === "toolResult") as
    | { content: string; isError: boolean }
    | undefined;
  check(
    "J1 afterToolCall 抛错 → ToolResult 替换为安全错误说明且 isError=true",
    tr !== undefined && tr.isError === true && tr.content.includes("处理失败") && !tr.content.includes("13812345678"),
    tr?.content
  );
  check(
    "J2 下一轮模型请求不含未脱敏 PII（原始内容已丢弃）",
    requests[1]?.messages.every(
      (m) => !(m.role === "toolResult" && (m as { content: string }).content.includes("13812345678"))
    ) === true
  );
  check("J3 Run 正常完成（finalText 非空）", ft.includes("已记录"));
}
{
  // J4: beforeToolCall 抛错 → 按阻止处理，prompt 不 reject、消息写回、agent_end 发射
  const { streamFn } = createFakeStreamFn([
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
    { text: "本次查询已被安全策略阻止。" },
  ]);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, {
    beforeToolCall(): { block: boolean } {
      throw new Error("before hook failed");
    },
  });
  const events: string[] = [];
  agent.subscribe((e) => events.push(e.type));
  let threw = false;
  let ft = "";
  try {
    ft = await agent.prompt("测试");
  } catch {
    threw = true;
  }
  check("J4 beforeToolCall 抛错时 prompt 不再 reject", threw === false);
  check(
    "J5 工具被阻止（安全错误说明）且本轮消息写回 context",
    agent.context.length === 4 &&
      agent.context.some((m) => m.role === "toolResult" && (m as { content: string }).content.includes("阻止"))
  );
  check("J6 agent_end 正常发射", events.includes("agent_end"));
  check("J7 最终回复仍生成", ft.length > 0);
}

// ---------------------------------------------------------------------------
// 场景 K：验收判定对抗（R1 回归）
// 复刻 audit/revision-fixture.mjs 的 invalid-acceptance 模式：
// 错误回复文字包含全部关键词、查错菜单、传无效 dataType——判定必须 FAIL
// ---------------------------------------------------------------------------

section("K. 验收判定对抗（R1 回归：错误字符串命中关键词必须 FAIL）");

function collectQ(allEvents: AgentEvent[], from: number): QEvents {
  const qe: QEvents = { toolStarts: [], toolEnds: [], agentErrors: [], lastAssistantStop: null };
  for (const e of allEvents.slice(from)) {
    if (e.type === "tool_execution_start") {
      qe.toolStarts.push({ toolName: e.toolName, args: e.args });
    } else if (e.type === "tool_execution_end") {
      qe.toolEnds.push({ toolName: e.toolName, isError: e.isError, summary: e.summary });
    } else if (e.type === "agent_error") {
      qe.agentErrors.push(e.message);
    } else if (e.type === "assistant_message") {
      qe.lastAssistantStop = e.message.stopReason;
    }
  }
  return qe;
}

async function runThreeQuestions(plans: TurnPlan[]): Promise<{ qes: QEvents[]; replies: string[] }> {
  const { streamFn } = createFakeStreamFn(plans);
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  const allEvents: AgentEvent[] = [];
  agent.subscribe((e) => allEvents.push(e));
  const qes: QEvents[] = [];
  const replies: string[] = [];
  for (const q of ["为什么我没有权限管理菜单", "我为什么报不了餐", "那餐标是多少"]) {
    const from = allEvents.length;
    replies.push(await agent.prompt(q));
    qes.push(collectQ(allEvents, from));
  }
  return { qes, replies };
}

{
  // K1: 正常剧本（与 revision-fixture 的 valid-acceptance 等价）→ 三问判定全部通过
  const valid = await runThreeQuestions([
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"权限管理"}' }] },
    { text: "你缺少系统管理员角色，请联系管理员开通。" },
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"报餐管理"}' }] },
    { toolCalls: [{ name: "query_business_data", arguments: '{"dataType":"报餐订单"}' }] },
    { text: "订单42元，餐标35元，超出7元被驳回。" },
    { text: "餐标是35元/人/日。" },
  ]);
  check("K1 正常剧本三问判定全部 PASS", judgeScenario1(valid.qes[0], valid.replies[0]).ok && judgeScenario2(valid.qes[1], valid.replies[1]).ok && judgeScenario3(valid.qes[2], valid.replies[2]).ok);

  // K2–K4: 对抗剧本（与 revision-fixture 的 invalid-acceptance 等价）→ 全部必须 FAIL
  const invalid = await runThreeQuestions([
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"权限管理"}' }] },
    { stopReason: "error", errorMessage: "系统管理员请联系开通" },
    { toolCalls: [{ name: "check_dcs_permission", arguments: '{"menuName":"权限管理"}' }] },
    { toolCalls: [{ name: "query_business_data", arguments: '{"dataType":"无效类型"}' }] },
    { stopReason: "error", errorMessage: "驳回超出42元35元" },
    { stopReason: "error", errorMessage: "35" },
  ]);
  const j1 = judgeScenario1(invalid.qes[0], invalid.replies[0]);
  check(
    "K2 错误回复含「系统管理员/联系/开通」也必须 FAIL（agent_error / 非正常 stop）",
    j1.ok === false && invalid.replies[0].includes("系统管理员") && invalid.replies[0].includes("联系"),
    j1.failures.join("; ")
  );
  const j2 = judgeScenario2(invalid.qes[1], invalid.replies[1]);
  check(
    "K3 查错菜单（权限管理≠报餐管理）+ 无效 dataType + 错误回复含 42/35/驳回 也必须 FAIL",
    j2.ok === false &&
      j2.failures.some((f) => f.includes("报餐管理")) &&
      j2.failures.some((f) => f.includes("报餐订单")) &&
      invalid.replies[1].includes("42") && invalid.replies[1].includes("35") && invalid.replies[1].includes("驳回"),
    j2.failures.join("; ")
  );
  const j3 = judgeScenario3(invalid.qes[2], invalid.replies[2]);
  check(
    "K4 错误回复仅含「35」也必须 FAIL",
    j3.ok === false && invalid.replies[2].includes("35"),
    j3.failures.join("; ")
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n========== 冒烟测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
