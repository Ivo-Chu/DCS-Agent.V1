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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import {
  dcsTools,
  investigateDcsCodeTool,
  queryDcsDataTool,
} from "../src/dcs/tools.ts";
import {
  setDbClientFactoryForTest,
  type DbClient,
} from "../src/dcs/db/client.ts";
import { guardSql } from "../src/dcs/db/guard.ts";
import { formatQueryResult } from "../src/dcs/db/format.ts";
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
// 假 DbClient（测试注入，不连真库）：按 SQL 关键词返回剧本化数据，
// 供场景 A/B/G/K 的 Agent 级测试使用（Mock 工具已删除，载体统一为 query_dcs_data；
// 真实库行为由场景 L 的纯函数/工具级测试与 test/live-db.ts 验证）
// ---------------------------------------------------------------------------

const makeFakeClient = (
  impl: (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>
): DbClient => ({
  async execute(sql) {
    return impl(sql);
  },
  async close() {},
});

/** 按剧本 SQL 关键词返回数据的假库（菜单 / 订单 / 餐标 / 考勤）。 */
const acceptanceFakeDb = makeFakeClient(async (sql) => {
  if (sql.includes("权限管理")) {
    return { columns: ["MENU_NAME", "ALLOWED_ROLE"], rows: [["权限管理", "系统管理员"]] };
  }
  if (sql.includes("报餐管理")) {
    return { columns: ["MENU_NAME", "ALLOWED_ROLE"], rows: [["报餐管理", "普通员工"]] };
  }
  if (sql.includes("MEAL_ORDER")) {
    return { columns: ["订单日期", "状态", "金额", "餐标"], rows: [["2026-09-24", "已驳回", "42", "35"]] };
  }
  if (sql.includes("MEAL_CONFIG")) {
    return { columns: ["餐标"], rows: [["35"]] };
  }
  if (sql.includes("ATTENDANCE")) {
    return { columns: ["打卡时间"], rows: [["08:59"]] };
  }
  return { columns: ["结果"], rows: [["（无匹配数据）"]] };
});

// 场景 A/B/G/K 统一注入假库（覆盖环境变量默认工厂，保证离线确定性）
setDbClientFactoryForTest(() => acceptanceFakeDb);

// ---------------------------------------------------------------------------
// 场景 A：权限诊断 —— 只调 query_dcs_data，Agent 状态写回
// ---------------------------------------------------------------------------

section("A. 权限诊断（query_dcs_data → 无权限 → 最终回答）");

{
  const { streamFn, requests } = createFakeStreamFn([
    {
      toolCalls: [
        {
          name: "query_dcs_data",
          arguments:
            '{"sql":"SELECT MENU_NAME, ALLOWED_ROLE FROM S2_MENU WHERE MENU_NAME = \'权限管理\'"}',
        },
      ],
    },
    { text: "你缺少系统管理员角色，请联系管理员开通。" },
  ]);

  const events: string[] = [];
  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  agent.subscribe((e) => events.push(e.type));

  const finalText = await agent.prompt("为什么我没有权限管理菜单");

  check("A1 返回最终 AssistantMessage 文本", finalText.includes("系统管理员"));
  check("A2 Agent.context 写回 4 条消息（user/assistant/toolResult/assistant）", agent.context.length === 4, `实际 ${agent.context.length}`);
  check("A3 首条为 UserMessage", agent.context[0]?.role === "user" && (agent.context[0] as { content: string }).content === "为什么我没有权限管理菜单");
  const a1 = agent.context[1] as AssistantMessage;
  check("A4 第二条为带 toolCalls 的 AssistantMessage", a1?.role === "assistant" && a1.toolCalls?.length === 1 && a1.toolCalls[0].name === "query_dcs_data");
  const tr = agent.context[2];
  check("A5 第三条为 ToolResult 且查询结果含权限数据", tr?.role === "toolResult" && (tr as { content: string }).content.includes("权限管理") && (tr as { content: string }).content.includes("系统管理员"));
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
// 场景 B：多轮循环 —— 菜单权限 → 报餐订单 → 最终回答（完整诊断链）
// ---------------------------------------------------------------------------

section("B. 报餐诊断链（query_dcs_data 查菜单 → 查订单 → 最终回答）");

{
  const { streamFn, requests } = createFakeStreamFn([
    {
      toolCalls: [
        {
          name: "query_dcs_data",
          arguments:
            '{"sql":"SELECT MENU_NAME, ALLOWED_ROLE FROM S2_MENU WHERE MENU_NAME = \'报餐管理\'"}',
        },
      ],
    },
    {
      toolCalls: [
        { name: "query_dcs_data", arguments: '{"sql":"SELECT * FROM S2_MEAL_ORDER ORDER BY 订单日期 DESC"}' },
      ],
    },
    { text: "你今天的报餐订单被驳回了：超出当日餐标 7 元（餐标 35 元，实付 42 元）。请修改金额后重新提交。" },
  ]);

  const agent = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
  const finalText = await agent.prompt("我为什么报不了餐");

  check("B1 两轮工具调用全部执行（LLM→Tool→LLM→Tool→LLM 三 Turn 循环）", requests.length === 3, `实际 LLM 调用 ${requests.length} 次`);
  check("B2 第二轮 LLM 输入含第一轮 ToolResult（菜单权限数据）",
    requests[1]?.messages.some((m) => m.role === "toolResult" && (m as { content: string }).content.includes("报餐管理")));
  check("B3 第三轮 LLM 输入含订单 ToolResult（已驳回 + 42/35）",
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
  // 方案 v2 §7：凭据脱敏（Password / Pwd / Secret / Token / ApiKey / AccessKey）
  const maskedConn = maskPii("Data Source=orcl;User Id=dcs;Password=SuperSecret123;");
  check("C7 凭据脱敏：connectionString 中 Password 值被脱敏", maskedConn.includes("Password=***") && !maskedConn.includes("SuperSecret123"), maskedConn);
  const maskedJson = maskPii('"ApiKey": "sk-abc123xyz"');
  check("C8 凭据脱敏：JSON 形态 ApiKey 值被脱敏", !maskedJson.includes("sk-abc123xyz"), maskedJson);
  const maskedSecret = maskPii("secret = hunter2 words");
  check("C9 凭据脱敏：secret 赋值被脱敏", !maskedSecret.includes("hunter2"), maskedSecret);
  check("C10 凭据脱敏：普通属性定义不受影响", maskPii("public string UserName { get; set; }") === "public string UserName { get; set; }");
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
// 场景 E：investigate_dcs_code（方案 v2：搜索+上下文融合、范围控制、安全边界、凭据脱敏链路）
// 自包含 fixture（临时目录），不依赖本机真实 DCS 源码路径。
// ---------------------------------------------------------------------------

section("E. investigate_dcs_code 源码调查（融合搜索/上下文/安全边界/脱敏链路）");

{
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-investigate-"));
  const prevRoot = process.env.DCS_SOURCE_ROOT;
  process.env.DCS_SOURCE_ROOT = fixtureRoot;
  try {
    const write = (rel: string, content: string): void => {
      const p = path.join(fixtureRoot, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
    };
    // 允许范围：WebApi / WebApp / Common
    write(
      "Luxshare.DCS.WebApi/Controllers/DimissionController.cs",
      [
        "using System;",
        "",
        "namespace Luxshare.DCS.WebApi.Controllers",
        "{",
        "    public class DimissionController : BaseApiController",
        "    {",
        "        // 离职流程：协调员信息显示逻辑",
        "        public object GetCoordinator()",
        "        {",
        "            return new { coordinator = \"黄石智通\" };",
        "        }",
        "    }",
        "}",
      ].join("\n")
    );
    write(
      "Luxshare.DCS.WebApp/Areas/BookDinnerSys/Views/Index.cshtml",
      ["<h2>报餐管理</h2>", "<p>提交报餐申请，超出餐标将被驳回</p>"].join("\n")
    );
    write("Common/EmployeeHelper.cs", "public static class EmployeeHelper { /* Employee util */ }\n");
    // 应被排除：白名单外项目 / 黑名单目录 / minified
    write("Libraries/BigLib.cs", "// 协调员：白名单外项目，不应被命中\n");
    write("Luxshare.DCS.WebApi/bin/Junk.cs", "// 协调员：黑名单目录，不应被命中\n");
    write("Luxshare.DCS.WebApp/Scripts/jquery.library.js", "// 协调员：黑名单目录，不应被命中\n");
    write("Luxshare.DCS.WebApi/bundle.min.js", "// 协调员：minified，不应被命中\n");
    // 凭据相关：Web.config（允许调查，但值须脱敏）与 secrets.json（直接拒绝）
    write(
      "Luxshare.DCS.WebApi/Web.config",
      [
        "<configuration>",
        "  <connectionStrings>",
        "    <add name=\"Oracle\" connectionString=\"Data Source=orcl;User Id=dcs;Password=SuperSecret123;\" />",
        "  </connectionStrings>",
        "</configuration>",
      ].join("\n")
    );
    write("Luxshare.DCS.WebApi/secrets.json", '{"apiKey": "sk-should-never-leak"}\n');

    // ---- 范围控制（测试重点 1/2）----
    const hit = await investigateDcsCodeTool.execute({ query: "协调员" }, dcsCtx);
    check(
      "E1 全局搜索命中允许项目的业务代码",
      !hit.isError && hit.output.includes("DimissionController.cs"),
      hit.output.slice(0, 200)
    );
    check("E2 顶层白名单外项目（Libraries）不被搜索", !hit.output.includes("BigLib"));
    check(
      "E3 黑名单目录（bin/Scripts）与 minified 文件不被搜索",
      !hit.output.includes("Junk") && !hit.output.includes("jquery.library") && !hit.output.includes("bundle.min")
    );
    const area = await investigateDcsCodeTool.execute({ query: "报餐" }, dcsCtx);
    check(
      "E4 WebApp/Areas 业务视图（.cshtml）可被搜索",
      !area.isError && area.output.includes("BookDinnerSys"),
      area.output.slice(0, 200)
    );

    // ---- 渐进式上下文（测试重点 3/4/5）----
    const ctx3 = await investigateDcsCodeTool.execute({ query: "GetCoordinator" }, dcsCtx);
    check(
      "E5 默认上下文：命中行带 > 标记与行号，前后各 3 行（第 8 行命中，5-11 行可见）",
      !ctx3.isError &&
        />\s*8\s*\|\s*public object GetCoordinator\(\)/.test(ctx3.output) &&
        ctx3.output.includes("public class DimissionController") &&
        ctx3.output.includes("return new { coordinator"),
      ctx3.output.slice(0, 400)
    );
    const ctx0 = await investigateDcsCodeTool.execute({ query: "GetCoordinator", contextLines: 0 }, dcsCtx);
    const ctx0HitLines = ctx0.output.split("\n").filter((l) => /^>\s*\d/.test(l));
    check("E6 contextLines=0 时仅返回命中行本身（体积受控）", ctx0HitLines.length === 1, ctx0.output);

    // ---- path 限定与聚焦（测试重点 3）----
    const scoped = await investigateDcsCodeTool.execute({ query: "Employee", path: "Common" }, dcsCtx);
    check(
      "E7 path 限定到目录：范围标注正确且只在该范围命中",
      !scoped.isError && scoped.output.includes("EmployeeHelper") && scoped.output.includes("范围：Common"),
      scoped.output.slice(0, 200)
    );

    // ---- 安全边界（测试重点 6/7/8）----
    const escape1 = await investigateDcsCodeTool.execute({ query: "x", path: "../outside" }, dcsCtx);
    check("E8 ../ 路径穿越被拒绝（isError）", escape1.isError === true);
    const escape2 = await investigateDcsCodeTool.execute({
      query: "x",
      path: path.join(os.tmpdir(), "elsewhere.cs"),
    }, dcsCtx);
    check("E9 DCS_SOURCE_ROOT 外绝对路径被拒绝", escape2.isError === true);
    const cred = await investigateDcsCodeTool.execute({
      query: "apiKey",
      path: "Luxshare.DCS.WebApi/secrets.json",
    }, dcsCtx);
    check("E10 凭据文件（secrets.json）被拒绝访问", cred.isError === true && !cred.output.includes("sk-should-never-leak"));

    // ---- 能力可用性（测试重点 11）----
    delete process.env.DCS_SOURCE_ROOT;
    const unavailable = await investigateDcsCodeTool.execute({ query: "Employee" }, dcsCtx);
    check(
      "E11 未配置 DCS_SOURCE_ROOT 时明确返回能力不可用",
      unavailable.isError === true && unavailable.output.includes("不可用")
    );
    process.env.DCS_SOURCE_ROOT = fixtureRoot;

    // ---- 完整链路：ToolResult 回填模型（含上下文），模型基于证据回答（测试重点 9/10）----
    const { streamFn, requests } = createFakeStreamFn([
      { toolCalls: [{ name: "investigate_dcs_code", arguments: '{"query":"协调员"}' }] },
      { text: "经源码调查，离职流程的协调员显示逻辑位于 DimissionController 的 GetCoordinator 方法：即使厂区勾选了无需协调员，该方法仍返回协调员信息，属于显示逻辑分支问题。建议将此定位结论反馈给管理员核实。" },
    ]);
    const agentE = makeAgent(streamFn, dcsTools, dcsCtx, createDcsToolHooks());
    const finalText = await agentE.prompt("黄石智通已勾选无需协调员，为什么离职流程还会显示协调员信息");
    const internalTr = requests[1]?.messages.find((m) => m.role === "toolResult") as { content: string } | undefined;
    check(
      "E12 模型内部收到含命中位置与上下文的调查结果（相对路径+行号+>标记）",
      internalTr?.content.includes("DimissionController.cs") === true && internalTr.content.includes(">") === true
    );
    check(
      "E13 能力释放：模型可基于源码证据给出定位结论（剧本即新原则预期行为）",
      finalText.includes("GetCoordinator") && finalText.includes("显示逻辑")
    );

    // ---- 凭据脱敏链路：Web.config 调查结果进模型前脱敏（测试重点 9）----
    const { streamFn: sfCfg, requests: reqCfg } = createFakeStreamFn([
      { toolCalls: [{ name: "investigate_dcs_code", arguments: '{"query":"connectionString","path":"Luxshare.DCS.WebApi/Web.config"}' }] },
      { text: "系统配置了 Oracle 数据库连接。" },
    ]);
    const agentCfg = makeAgent(sfCfg, dcsTools, dcsCtx, createDcsToolHooks());
    await agentCfg.prompt("系统连的什么数据库");
    const cfgTr = reqCfg[1]?.messages.find((m) => m.role === "toolResult") as { content: string } | undefined;
    check(
      "E14 Web.config 可被调查且进入模型前凭据已脱敏（Password=***，原值不出现）",
      cfgTr?.content.includes("connectionString") === true &&
        cfgTr.content.includes("Password=***") === true &&
        cfgTr.content.includes("SuperSecret123") === false,
      cfgTr?.content?.slice(0, 300)
    );
  } finally {
    if (prevRoot === undefined) delete process.env.DCS_SOURCE_ROOT;
    else process.env.DCS_SOURCE_ROOT = prevRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
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
      toolCalls: [{ name: "query_dcs_data", arguments: '{"sq' }],
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
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }], stopReason: "stop", text: "直接回答" },
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
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
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
// Mock 工具删除后，判定器核对 query_dcs_data 的执行与证据：
// 错误回复文字包含全部关键词、查错数据（考勤≠报餐）——判定必须 FAIL
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
  // K1: 正常剧本 → 三问判定全部通过
  const valid = await runThreeQuestions([
    {
      toolCalls: [
        {
          name: "query_dcs_data",
          arguments:
            '{"sql":"SELECT MENU_NAME, ALLOWED_ROLE FROM S2_MENU WHERE MENU_NAME = \'权限管理\'"}',
        },
      ],
    },
    { text: "你缺少系统管理员角色，请联系管理员开通。" },
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT * FROM S2_MEAL_ORDER ORDER BY 订单日期 DESC"}' }] },
    { text: "订单42元，餐标35元，超出7元被驳回。" },
    { text: "餐标是35元/人/日。" },
  ]);
  check("K1 正常剧本三问判定全部 PASS", judgeScenario1(valid.qes[0], valid.replies[0]).ok && judgeScenario2(valid.qes[1], valid.replies[1]).ok && judgeScenario3(valid.qes[2], valid.replies[2]).ok);

  // K2–K4: 对抗剧本 → 全部必须 FAIL
  const invalid = await runThreeQuestions([
    {
      toolCalls: [
        {
          name: "query_dcs_data",
          arguments:
            '{"sql":"SELECT MENU_NAME, ALLOWED_ROLE FROM S2_MENU WHERE MENU_NAME = \'权限管理\'"}',
        },
      ],
    },
    { stopReason: "error", errorMessage: "系统管理员请联系开通" },
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT * FROM S2_ATTENDANCE WHERE 打卡日期 = SYSDATE"}' }] },
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
    "K3 查错数据（考勤≠报餐订单）+ 错误回复含 42/35/驳回 也必须 FAIL",
    j2.ok === false &&
      j2.failures.some((f) => f.includes("报餐")) &&
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
// 场景 L：query_dcs_data（query-dcs-data-plan-v1：假 DbClient，无需真库）
// ---------------------------------------------------------------------------

section("L. query_dcs_data 数据库查询（护栏 / 格式化 / 错误透传 / 门控 / 脱敏链路）");

{
  // makeFakeClient 已提升至文件顶部（与场景 A/B/G/K 共享）；
  // 本场景逐项覆写工厂，结束时恢复默认。

  // ---- L1 guardSql 纯函数 ----
  check("L1 guard：SELECT / WITH 通过", guardSql("SELECT * FROM DUAL").ok && guardSql("WITH t AS (SELECT 1 FROM DUAL) SELECT * FROM t").ok);
  check("L2 guard：DELETE / UPDATE / INSERT / DDL 拒绝", !guardSql("DELETE FROM t").ok && !guardSql("UPDATE t SET a=1").ok && !guardSql("INSERT INTO t VALUES (1)").ok && !guardSql("DROP TABLE t").ok);
  check(
    "L3 guard：多语句拒绝；注释内分号与尾分号不影响合法单语句",
    !guardSql("SELECT 1 FROM DUAL; SELECT 2 FROM DUAL").ok &&
      guardSql("SELECT 1 /* ; */ FROM DUAL").ok &&
      guardSql("SELECT 1 FROM DUAL;").ok
  );
  check("L4 guard：FOR UPDATE 拒绝", !guardSql("SELECT * FROM t FOR UPDATE").ok);
  check("L5 guard：空 SQL 拒绝", !guardSql("   ").ok);

  // ---- L6-L7 正常查询与截断（工具 execute + 假 client）----
  setDbClientFactoryForTest(() =>
    makeFakeClient(async () => ({
      columns: ["EMPLOYEE_NO", "STATUS"],
      rows: [
        ["T000001", "在职"],
        ["T000002", null],
        ["T000003", "离职"],
      ],
    }))
  );
  const ok = await queryDcsDataTool.execute({ sql: "SELECT EMPLOYEE_NO, STATUS FROM S2_Employee" }, dcsCtx);
  check(
    "L6 正常查询：行数说明 + 列头 + 行数据 + NULL 渲染",
    !ok.isError && ok.output.includes("返回 3 行") && ok.output.includes("EMPLOYEE_NO | STATUS") && ok.output.includes("T000002 | NULL"),
    ok.output
  );

  setDbClientFactoryForTest(() =>
    makeFakeClient(async () => ({
      columns: ["ID"],
      rows: Array.from({ length: 105 }, (_, i) => [i + 1]),
    }))
  );
  const truncated = await queryDcsDataTool.execute({ sql: "SELECT ID FROM BIG_TABLE" }, dcsCtx);
  check(
    "L7 超 100 行截断并提示加 WHERE 收窄",
    truncated.output.includes("已截断至前 100 行") && truncated.output.includes("WHERE"),
    truncated.output.slice(0, 120)
  );

  // ---- L8 非 SELECT 经工具层拒绝 ----
  const rejected = await queryDcsDataTool.execute({ sql: "DELETE FROM S2_Employee" }, dcsCtx);
  check(
    "L8 非 SELECT 经工具层拒绝（isError:true 如实反映失败，返回修正提示，非异常）",
    rejected.isError === true && rejected.output.includes("SQL 被拒绝") && rejected.output.includes("SELECT"),
    rejected.output
  );

  // ---- L9 ORA 错误透传（供模型自修正）----
  setDbClientFactoryForTest(() =>
    makeFakeClient(async () => {
      throw new Error("ORA-00942: table or view does not exist");
    })
  );
  const oraErr = await queryDcsDataTool.execute({ sql: "SELECT * FROM NOT_EXIST_TABLE" }, dcsCtx);
  check(
    "L9 ORA 错误截断透传且 isError:true（真实失败如实标记，含错误码与重试提示，永不抛异常）",
    oraErr.isError === true && oraErr.output.includes("ORA-00942") && oraErr.output.includes("可修正 SQL 后重试"),
    oraErr.output
  );

  // ---- L10 未配置数据库 → 能力不可用 ----
  setDbClientFactoryForTest(() => null);
  const unavailable = await queryDcsDataTool.execute({ sql: "SELECT 1 FROM DUAL" }, dcsCtx);
  check(
    "L10 未配置 DCS_DB_* 时明确返回能力不可用（isError）",
    unavailable.isError === true && unavailable.output.includes("不可用") && unavailable.output.includes("DCS_DB_USER"),
    unavailable.output
  );

  // ---- L11 maskPii 链路：DB 结果中的手机号进入模型前脱敏 ----
  setDbClientFactoryForTest(() =>
    makeFakeClient(async () => ({
      columns: ["NAME", "PHONE"],
      rows: [["张三", "13812345678"]],
    }))
  );
  const { streamFn: sfDb, requests: reqDb } = createFakeStreamFn([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT NAME, PHONE FROM S2_Employee WHERE ..."}' }] },
    { text: "查询完成，联系方式已脱敏展示。" },
  ]);
  const agentDb = makeAgent(sfDb, dcsTools, dcsCtx, createDcsToolHooks());
  await agentDb.prompt("查一下我的联系方式");
  const dbTr = reqDb[1]?.messages.find((m) => m.role === "toolResult") as { content: string } | undefined;
  check(
    "L11 DB 查询结果进入模型前手机号已脱敏（maskPii 管线对 DB 工具生效）",
    dbTr?.content.includes("138****5678") === true && dbTr.content.includes("13812345678") === false,
    dbTr?.content?.slice(0, 200)
  );

  // ---- L12 format 纯函数：60KB 体积保险 ----
  // 注：单元格超 200 字符会先被 MAX_CELL_CHARS 截断，单列构造永远达不到 60KB；
  // 需用多列宽行（50 行 × 10 列 × 200 字符 ≈ 100KB）才能真实触发体积保险。
  const wideCols = Array.from({ length: 10 }, (_, i) => `C${i + 1}`);
  const wideRows = Array.from({ length: 50 }, () => wideCols.map(() => "X".repeat(200)));
  const wide = formatQueryResult(wideCols, wideRows);
  check(
    "L12 输出体积达 60KB 上限时截断并注明",
    wide.truncated && wide.output.includes("已截断") && wide.output.length <= 60 * 1024 + 100,
    `${wide.output.length} (truncated=${wide.truncated})`
  );

  // ---- L13 错误→修正→恢复全链路（isError 语义回归）----
  // 模型第一次 SQL 触发 ORA 错误（isError:true 进入事件与 ToolResult）→
  // 模型读到错误内容后改写 SQL → 第二次成功 → 正常作答。
  // 验收口径：中间工具失败 ≠ 运行失败，可恢复错误不得判整题失败。
  {
    let callCount = 0;
    setDbClientFactoryForTest(() =>
      makeFakeClient(async (sql) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        void sql;
        return { columns: ["NAME", "STATUS"], rows: [["张三", "正常"]] };
      })
    );
    const { streamFn: sfFix, requests: reqFix } = createFakeStreamFn([
      { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT * FROM WRONG_TABLE"}' }] },
      { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT NAME, STATUS FROM S2_Employee WHERE Code = \'10086\'"}' }] },
      { text: "你的状态正常，查询完成。" },
    ]);
    const agentFix = makeAgent(sfFix, dcsTools, dcsCtx, createDcsToolHooks());
    const fixEvents: AgentEvent[] = [];
    agentFix.subscribe((e) => fixEvents.push(e));
    const fixReply = await agentFix.prompt("查一下我的状态");
    const fixToolEnds = fixEvents.filter((e) => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }>[];
    // 最后一次 LLM 请求的上下文含全部 ToolResult（累积），按序取 [错误结果, 成功结果]
    const finalReq = reqFix[reqFix.length - 1];
    const fixToolResults = finalReq?.messages.filter((m) => m.role === "toolResult") as { content: string }[] | undefined;
    check(
      "L13a 第一次查询失败：事件与 ToolResult 均标记 isError（如实反映执行结果）",
      fixToolEnds[0]?.isError === true && fixToolResults?.[0]?.content.includes("ORA-00942") === true,
      `event.isError=${String(fixToolEnds[0]?.isError)} toolResult=${fixToolResults?.[0]?.content?.slice(0, 80)}`
    );
    check(
      "L13b 模型收到错误后改写 SQL，第二次查询成功（isError:false）",
      fixToolEnds[1]?.isError === false && fixToolResults?.[1]?.content.includes("正常") === true,
      `event.isError=${String(fixToolEnds[1]?.isError)} toolResult=${fixToolResults?.[1]?.content?.slice(0, 80)}`
    );
    check(
      "L13c 中间工具失败不终止运行：最终正常作答（可恢复错误 ≠ 运行失败）",
      fixReply.includes("正常") && fixToolEnds.length === 2,
      fixReply.slice(0, 80)
    );
  }

  // 恢复默认工厂，避免影响其他测试
  setDbClientFactoryForTest(null);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n========== 冒烟测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
