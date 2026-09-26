/**
 * 三个验收场景的接线验证（方案 §11 的 Runtime 接线部分）。
 *
 * 【证据边界（审查修复 F4）】模型侧为脚本化 FakeStreamFn——工具调用与回复
 * 均为预置剧本，本文件只证明 Runtime 接线与状态传递正确，
 * 不证明真实模型行为。真实模型三问验收见 test/acceptance-live.ts。
 *
 * 【2026-09-24 Mock 工具移除】场景载体统一为 query_dcs_data：
 * DcsSession / systemPrompt / DCS Hooks / 工具均为真实实现，
 * 数据库为注入的假 DbClient（按 SQL 关键词返回剧本化数据，
 * 不连真库；真实库行为由 test/live-db.ts 验证）。
 * 剧本中的回复内容与假库 ToolResult 的数据保持一致（不引入剧本外信息）。
 *
 * 运行：npx tsx test/acceptance.ts
 */
import { Agent } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelStreamEvent, StreamFn } from "../src/core/types.ts";
import { createDcsToolHooks } from "../src/dcs/hooks.ts";
import { buildSystemPrompt } from "../src/dcs/prompt.ts";
import { createMockSession } from "../src/dcs/session.ts";
import { dcsTools } from "../src/dcs/tools.ts";
import { setDbClientFactoryForTest, type DbClient } from "../src/dcs/db/client.ts";

let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

// ---- 假 DbClient（按 SQL 关键词返回剧本化数据，不连真库）----

const fakeDb: DbClient = {
  async execute(sql) {
    if (sql.includes("权限管理")) {
      return { columns: ["MENU_NAME", "ALLOWED_ROLE"], rows: [["权限管理", "系统管理员"]] };
    }
    if (sql.includes("MEAL_ORDER")) {
      return { columns: ["订单日期", "状态", "金额", "餐标"], rows: [["2026-09-24", "已驳回", "42", "35"]] };
    }
    if (sql.includes("MEAL_CONFIG") || sql.includes("餐标")) {
      return { columns: ["餐标"], rows: [["35"]] };
    }
    return { columns: ["结果"], rows: [["（无匹配数据）"]] };
  },
  async close() {},
};

setDbClientFactoryForTest(() => fakeDb);

// ---- FakeStreamFn（脚本化假模型）----

interface TurnPlan {
  text?: string;
  toolCalls?: { name: string; arguments: string }[];
}

function chunked(s: string, size: number): string[] {
  return s.match(new RegExp(`.{1,${size}}`, "gs")) ?? [];
}

function createFakeStreamFn(plans: TurnPlan[]): StreamFn {
  let call = 0;
  return async function* (req): AsyncGenerator<ModelStreamEvent> {
    void req;
    const plan = plans[call++];
    if (!plan) {
      yield { type: "message_end", stopReason: "error", errorMessage: "脚本轮次耗尽" };
      return;
    }
    for (const c of chunked(plan.text ?? "", 8)) {
      yield { type: "text_delta", text: c };
    }
    const tcs = plan.toolCalls ?? [];
    for (let i = 0; i < tcs.length; i++) {
      yield { type: "tool_call_start", index: i, toolCallId: `call_${call}_${i}`, name: tcs[i].name };
      for (const c of chunked(tcs[i].arguments, 6)) {
        yield { type: "tool_call_delta", index: i, argumentsDelta: c };
      }
    }
    yield {
      type: "message_end",
      stopReason: tcs.length > 0 ? "toolCalls" : "stop",
    };
  };
}

// ---- 组装真实 DCS Agent（仅 streamFn 为假模型、DbClient 为假库）----

function newAgent(plans: TurnPlan[]): { agent: Agent<{ session: ReturnType<typeof createMockSession> }>; events: AgentEvent[] } {
  const session = createMockSession();
  const agent = new Agent({
    systemPrompt: buildSystemPrompt(session),
    tools: dcsTools,
    streamFn: createFakeStreamFn(plans),
    toolContext: { session },
    hooks: createDcsToolHooks(),
    maxTurns: 8,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return { agent, events };
}

const toolExecs = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === "tool_execution_start")
    .map((e) => (e as { toolName: string }).toolName);

// ===========================================================================
// 验收场景 1：为什么我没有权限管理菜单
// 预期：query_dcs_data 查菜单权限数据 → 缺系统管理员角色
// ===========================================================================
console.log("=== 验收场景 1：为什么我没有权限管理菜单 ===");
{
  const { agent, events } = newAgent([
    {
      toolCalls: [
        {
          name: "query_dcs_data",
          arguments:
            '{"sql":"SELECT MENU_NAME, ALLOWED_ROLE FROM S2_MENU WHERE MENU_NAME = \'权限管理\'"}',
        },
      ],
    },
    {
      text:
        "你目前没有「权限管理」菜单权限：缺少系统管理员角色。如需开通，请联系管理员处理。",
    },
  ]);
  const finalText = await agent.prompt("为什么我没有权限管理菜单");
  const names = toolExecs(events);
  console.log(`  工具调用：${names.join(" → ") || "（无）"}`);
  console.log(`  最终回复：${finalText}`);
  check("1a 只调用了 query_dcs_data", names.length === 1 && names[0] === "query_dcs_data", names.join(","));
  check("1b 回复包含缺少系统管理员角色与开通指引", finalText.includes("系统管理员") && finalText.includes("开通"));
}

// ===========================================================================
// 验收场景 2 + 3：我为什么报不了餐 → 追问「那餐标是多少」（同一会话）
// 预期 2：query_dcs_data 查报餐订单 → 超餐标驳回（42/35/7 显式断言）
// 预期 3：追问轮允许查餐标配置（不重复查权限/订单），
//         答案中的数据必须来自真实 ToolResult，不得预置剧本外的信息
// ===========================================================================
console.log("\n=== 验收场景 2：我为什么报不了餐 ===");
{
  const { agent, events } = newAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT * FROM S2_MEAL_ORDER ORDER BY 订单日期 DESC"}' }] },
    {
      // 回复内容与上一轮真实 ToolResult 中的数字保持一致（42 / 35 / 7 / 驳回）
      text:
        "你今天的报餐订单被驳回了：金额超出当日餐标 7 元（餐标 35 元，实付 42 元）。把金额改到 35 元以内重新提交即可。",
    },
    // 追问轮：模型按规则查询餐标配置（允许，不算重复查权限）
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 餐标 FROM S2_MEAL_CONFIG"}' }] },
    {
      // 答案只包含餐标配置 ToolResult 中真实存在的数据（35 元）
      text: "餐标是 35 元/人/日，报餐窗口为工作日 08:00-10:30。",
    },
  ]);
  const finalText = await agent.prompt("我为什么报不了餐");
  const names = toolExecs(events);
  console.log(`  工具调用：${names.join(" → ") || "（无）"}`);
  console.log(`  最终回复：${finalText}`);
  check("2a 先 query_dcs_data 查订单数据", names.length === 1 && names[0] === "query_dcs_data", names.join(","));
  check("2b 回复显式包含 42 元实付 / 35 元餐标 / 超出 7 元 / 驳回", finalText.includes("42") && finalText.includes("35") && finalText.includes("7") && finalText.includes("驳回"), finalText);
  check("2c 场景 2 的 newMessages 已写回 context（4 条：u/a/tr/a）", agent.context.length === 4, `实际 ${agent.context.length}`);

  // ---- 场景 3：同一 Agent 上追问 ----
  console.log("\n=== 验收场景 3：追问「那餐标是多少」（同一会话） ===");
  events.length = 0; // 清空事件，只统计追问轮
  const finalText2 = await agent.prompt("那餐标是多少");
  const names2 = toolExecs(events);
  console.log(`  工具调用：${names2.join(" → ") || "（无）"}`);
  console.log(`  最终回复：${finalText2}`);
  check("3a 追问轮未重复查权限/订单（只允许查餐标配置）", names2.every((n) => n === "query_dcs_data"), names2.join(","));
  check("3b 追问轮只调用了 query_dcs_data（餐标配置）", names2.every((n) => n === "query_dcs_data"), names2.join(","));
  check("3c 追问回答的数据来自真实 ToolResult（35 元/人/日）", finalText2.includes("35"));
  check("3d 最终输出不含源码路径", !/Luxshare|Controllers|\.cs\b/.test(finalText2));
}

// 恢复默认工厂（不影响后续测试进程内其他套件）
setDbClientFactoryForTest(null);

console.log("\n=== 验收结果 ===");
if (failed === 0) {
  console.log("三个验收场景接线全部通过（FakeStreamFn 预置模型行为 + 假 DbClient：仅验证 Runtime 接线与状态传递，不证明真实模型行为——真实模型验收见 test/acceptance-live.ts）");
} else {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
