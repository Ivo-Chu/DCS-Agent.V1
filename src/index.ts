/**
 * DCS Agent v1 — CLI REPL 入口。
 * 组装 core（Agent Runtime）与 dcs（Domain Layer）：
 * DcsSession + DCS Prompt + DCS Tools + DCS Hooks + DeepSeek StreamFn + Agent。
 */
import * as readline from "node:readline";
import { createDcsAgent } from "./dcs/agent-factory.ts";
import { loadEnvLocal } from "./dcs/env-local.ts";

loadEnvLocal();
import { createMockSession } from "./dcs/session.ts";
import { closeDbClient } from "./dcs/db/client.ts";

/** 内部源码调查工具名（展示层泛化用；完整结果仍回填模型）。 */
const INTERNAL_SEARCH_TOOL = "investigate_dcs_code";

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("未设置环境变量 DEEPSEEK_API_KEY，无法启动 DCS Agent。");
    console.error('PowerShell：$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"');
    console.error('bash：export DEEPSEEK_API_KEY="sk-xxxxxxxx"');
    process.exit(1);
  }

  // DCS Domain Layer 组装（统一走 agent-factory；CLI 保持默认模拟身份）
  const session = createMockSession();
  const agent = createDcsAgent({ session, holder: { controller: new AbortController() } });

  // R3（审查修复）：统计本轮已流式打印的字符数，
  // prompt() 结束后补打 finalText 中未流式显示过的后缀
  //（截断说明 / maxTurns 终止说明 / 错误附注等 Runtime 后补文本）
  let streamedLen = 0;
  // 方案 v2 §9：简单统计（CLI 测试入口，与 wecom:bot 同口径）
  let statTurns = 0;
  let statToolCalls = 0;

  // CLI 是事件唯一消费者
  agent.subscribe((e) => {
    switch (e.type) {
      case "message_delta":
        streamedLen += e.text.length;
        process.stdout.write(e.text);
        break;
      case "assistant_message":
        statTurns++;
        // 工具调用轮结束后换行，隔开下一轮流式输出
        if (e.message.stopReason === "toolCalls") process.stdout.write("\n");
        break;
      case "tool_execution_start":
        // R4（审查修复）：员工界面不打印原始工具参数——
        // 模型可能用文件路径/类名作检索关键词，参数明文会把内部路径带到终端
        console.log(`\n[工具调用] ${e.toolName}`);
        break;
      case "tool_execution_end": {
        statToolCalls++;
        // F5 + R4（审查修复）：展示层口径——内部源码调查的结果
        // 无论成败均不显示原始摘要（错误信息同样可能携带内部路径）
        const shown =
          e.toolName === INTERNAL_SEARCH_TOOL
            ? e.isError
              ? "内部检索失败"
              : "内部检索已完成"
            : e.summary;
        console.log(
          `[工具结果] ${e.isError ? "失败" : "完成"} ${e.toolName}：${shown}`
        );
        break;
      }
      case "agent_error":
        console.error(`\n[错误] ${e.message}`);
        break;
      default:
        break;
    }
  });

  console.log("=== DCS 智能服务助手 v1 ===");
  console.log(
    `当前员工：${session.user.name}（${session.user.employeeNo}，${session.user.department}）`
  );
  console.log("输入问题开始咨询，输入 exit 退出。\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (): void => {
    rl.question("你> ", async (line) => {
      const text = line.trim();
      if (!text) {
        ask();
        return;
      }
      if (text === "exit" || text === "quit") {
        rl.close();
        // 关闭 DB 连接池后退出（未配置数据库时为 no-op），否则常驻连接会让进程挂住
        void closeDbClient()
          .catch(() => undefined)
          .finally(() => process.exit(0));
        return;
      }
      process.stdout.write("助手> ");
      streamedLen = 0;
      statTurns = 0;
      statToolCalls = 0;
      let reply = "";
      try {
        // F6 修复后 prompt() 不应再 reject；此处仅防御性兜底
        reply = await agent.prompt(text);
      } catch (err) {
        console.error(`\n[致命错误] ${String(err)}`);
      }
      // R3：补打 Runtime 后补、未流式显示过的文本（如截断/终止说明）。
      // 正常流式回复时 finalText 与已打印内容一致，后缀为空、不会重复打印
      const suffix = reply.slice(streamedLen);
      if (suffix.length > 0) process.stdout.write(suffix);
      process.stdout.write("\n\n");
      console.log(`[统计] turns=${statTurns} toolCalls=${statToolCalls}`);
      ask();
    });
  };
  ask();
}

main();
