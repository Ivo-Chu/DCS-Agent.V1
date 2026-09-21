/**
 * 真实 DeepSeek 三问验收（方案 §11 / §12 步骤 5 的自动化版本）。
 *
 * 与 test/acceptance.ts（FakeStreamFn 接线验证）的区别：
 * - 模型为真实 DeepSeek（需 DEEPSEEK_API_KEY），不使用任何假模型代替；
 * - 工具调用序列、最终回复全部由真实模型决策产生，此处只记录与判定；
 * - 三问在同一 Agent 会话中依次提出（场景 3 依赖场景 2 的历史上下文）。
 *
 * 判定规则（R1 审查修复，逻辑见 test/acceptance-judge.ts，
 * 已由 smoke.ts 场景 K 的对抗测试离线验证）：
 * - 每问必须正常结束：无 agent_error、末条 AssistantMessage 为自然 stop——
 *   API 错误文字即使包含全部关键词也必须 FAIL；
 * - 必要工具必须真实执行成功（tool_execution_end 存在且 isError=false），
 *   并核对 menuName / dataType 与结果摘要中的关键事实；
 * - 未设置 DEEPSEEK_API_KEY → 输出"未验证（SKIPPED）"并退出，跳过 ≠ 通过。
 *
 * R2（审查修复）：打印每问的实际回复全文与工具调用成败，
 * 兑现"证据留存"承诺——正常通过与失败时日志中都有真实回答可查。
 *
 * 运行：npm run test:accept:live
 */
import { Agent } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/events.ts";
import { createDeepSeekStreamFn } from "../src/core/model/deepseek.ts";
import { createDcsToolHooks } from "../src/dcs/hooks.ts";
import { buildSystemPrompt } from "../src/dcs/prompt.ts";
import { createMockSession } from "../src/dcs/session.ts";
import { dcsTools } from "../src/dcs/tools.ts";
import {
  judgeScenario1,
  judgeScenario2,
  judgeScenario3,
  type JudgeResult,
  type QEvents,
} from "./acceptance-judge.ts";

let failed = 0;

function report(label: string, r: JudgeResult): void {
  if (r.ok) {
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.log(`    ✗ ${label}`);
    for (const f of r.failures) console.log(`        - ${f}`);
  }
}

/** 从事件流收集判定输入。 */
function collect(events: AgentEvent[]): QEvents {
  const qe: QEvents = { toolStarts: [], toolEnds: [], agentErrors: [], lastAssistantStop: null };
  for (const e of events) {
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

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("========== 未验证（SKIPPED） ==========");
    console.log("未设置 DEEPSEEK_API_KEY：真实 DeepSeek 三问验收未执行。");
    console.log("本验收不接受假模型代替；此前的 FakeStreamFn 结果只证明接线，不证明模型行为。");
    console.log("设置后运行：$env:DEEPSEEK_API_KEY = 'sk-xxxxxxxx'（PowerShell）或 export DEEPSEEK_API_KEY='sk-xxxxxxxx'（bash）");
    console.log("然后执行：npm run test:accept:live");
    process.exit(0);
  }

  const session = createMockSession();
  const agent = new Agent({
    systemPrompt: buildSystemPrompt(session),
    tools: dcsTools,
    streamFn: createDeepSeekStreamFn(),
    toolContext: { session },
    hooks: createDcsToolHooks(),
    maxTurns: 8,
  });

  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));

  const run = async (question: string): Promise<string> => {
    events.length = 0;
    console.log(`\n你> ${question}`);
    const reply = await agent.prompt(question);
    // R2：打印实际回复全文（证据留存）
    console.log(`助手> ${reply}`);
    // R2：工具调用与成败（参数由 judge 核对，此处只列名称与状态）
    for (const e of events) {
      if (e.type === "tool_execution_start") {
        console.log(`  [工具] ${e.toolName} 开始`);
      } else if (e.type === "tool_execution_end") {
        console.log(`  [工具] ${e.toolName} ${e.isError ? "失败" : "成功"}`);
      }
    }
    return reply;
  };

  console.log("========== DCS Agent 真实三问验收（DeepSeek） ==========");
  console.log(`当前员工：${session.user.name}（${session.user.employeeNo}，${session.user.department}）`);

  // ---- 场景 1：权限诊断 ----
  console.log("\n=== 场景 1：为什么我没有权限管理菜单 ===");
  const reply1 = await run("为什么我没有权限管理菜单");
  const qe1 = collect(events);
  console.log(`[历史消息数] ${agent.context.length}`);
  report("场景 1 判定", judgeScenario1(qe1, reply1));

  // ---- 场景 2：报餐诊断（先权限后业务数据） ----
  console.log("\n=== 场景 2：我为什么报不了餐 ===");
  const before2 = agent.context.length;
  const reply2 = await run("我为什么报不了餐");
  const qe2 = collect(events);
  console.log(`[历史消息数] ${agent.context.length}（提问前 ${before2}）`);
  report("场景 2 判定", judgeScenario2(qe2, reply2));

  // ---- 场景 3：追问餐标（同一会话，验证历史上下文生效） ----
  console.log("\n=== 场景 3：追问「那餐标是多少」（同一会话） ===");
  const before3 = agent.context.length;
  const reply3 = await run("那餐标是多少");
  const qe3 = collect(events);
  console.log(`[历史消息数] ${agent.context.length}（提问前 ${before3}）`);
  report("场景 3 判定", judgeScenario3(qe3, reply3));
  if (agent.context.length <= before3) {
    failed++;
    console.log("    ✗ 历史上下文未增长（newMessages 未写回）");
  } else {
    console.log("    ✓ 历史上下文持续累积（newMessages 写回）");
  }

  // ---- 汇总 ----
  console.log("\n========== 验收结果 ==========");
  if (failed > 0) {
    console.log(`FAIL：${failed} 项判定未通过（真实 DeepSeek）`);
    process.exit(1);
  }
  console.log("PASS：三个验收场景全部通过（真实 DeepSeek）");
  console.log("[证据留存] 各场景实际回复全文、工具调用成败、历史消息数见上方日志。");
}

main();
