/**
 * DCS Agent v1 — CLI REPL 入口。
 * 组装 core（Agent Runtime）与 dcs（Domain Layer）：
 * DcsSession + DCS Prompt + DCS Tools + DCS Hooks + LLM StreamFn + Agent。
 */
import * as readline from "node:readline";
import { createDcsAgent } from "./dcs/agent-factory.ts";
import { loadEnvLocal } from "./dcs/env-local.ts";
import { attachRunObserver } from "./observability/observer.ts";

loadEnvLocal();
import { createMockSession } from "./dcs/session.ts";
import { closeDbClient } from "./dcs/db/client.ts";

async function main(): Promise<void> {
  if (!process.env.LLM_API_KEY) {
    console.error("未设置环境变量 LLM_API_KEY，无法启动 DCS Agent。");
    console.error('PowerShell：$env:LLM_API_KEY = "sk-xxxxxxxx"');
    console.error('bash：export LLM_API_KEY="sk-xxxxxxxx"');
    process.exit(1);
  }

  // DCS Domain Layer 组装（统一走 agent-factory；CLI 保持默认模拟身份）
  const session = createMockSession();
  const agent = createDcsAgent({ session, holder: { controller: new AbortController() } });

  // R3（审查修复）：统计本轮已流式打印的字符数，
  // prompt() 结束后补打 finalText 中未流式显示过的后缀
  //（截断说明 / maxTurns 终止说明 / 错误附注等 Runtime 后补文本）
  let streamedLen = 0;

  // CLI 流式答案输出（工具展示与结束统计统一由 observability observer 负责，
  // 收敛旧 [工具调用]/[工具结果]/[统计] 双重展示；保留原有流式答案）
  agent.subscribe((e) => {
    switch (e.type) {
      case "message_delta":
        streamedLen += e.text.length;
        process.stdout.write(e.text);
        break;
      case "assistant_message":
        // 工具调用轮结束后换行，隔开下一轮流式输出
        if (e.message.stopReason === "toolCalls") process.stdout.write("\n");
        break;
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
      let reply = "";
      // 日志观测：中文终端日志 + logs/*.jsonl（同一事件流，不影响流式回答）
      // 模型/提供方标识由 run_start 事件携带（factory 统一从 Provider 配置获取）
      const observer = attachRunObserver(agent, {
        channel: "CLI",
        write: (text) => { process.stderr.write(text + "\n"); },
      });
      try {
        // F6 修复后 prompt() 不应再 reject；此处仅防御性兜底
        reply = await agent.prompt(text);
      } catch (err) {
        console.error(`\n[致命错误] ${String(err)}`);
      } finally {
        // 幂等结束（异常路径 core 可能未发 run_end；正常时 end 是 no-op）
        void observer.end("detached").catch(() => undefined);
      }
      // R3：补打 Runtime 后补、未流式显示过的文本（如截断/终止说明）。
      // 正常流式回复时 finalText 与已打印内容一致，后缀为空、不会重复打印
      const suffix = reply.slice(streamedLen);
      if (suffix.length > 0) process.stdout.write(suffix);
      process.stdout.write("\n\n");
      ask();
    });
  };
  ask();
}

main();
