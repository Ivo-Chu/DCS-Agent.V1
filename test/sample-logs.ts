/**
 * 日志样例生成（模拟数据：Fake 模型 + Fake 工具，无真实模型/数据库）。
 *
 * 生成三类样例到 logs/samples/（交付用）：
 * 1. NORMAL 终端输出样例（sample-normal.txt）
 * 2. DEBUG 终端输出样例（sample-debug.txt）
 * 3. 完整 JSONL 样例（sample-run-normal.jsonl / sample-run-debug.jsonl）
 *
 * 运行：npx tsx test/sample-logs.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/core/agent.ts";
import type { ModelStreamEvent, StreamFn, ToolDefinition, ToolOutput } from "../src/core/types.ts";
import { attachRunObserver } from "../src/observability/observer.ts";

const samplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "logs", "samples");
fs.mkdirSync(samplesDir, { recursive: true });

let secondCall = false;
const streamFn: StreamFn = async function* (): AsyncGenerator<ModelStreamEvent> {
  if (!secondCall) {
    secondCall = true;
    yield { type: "tool_call_start", index: 0, toolCallId: "call_sample_1", name: "query_dcs_data" };
    yield {
      type: "tool_call_delta",
      index: 0,
      argumentsDelta: JSON.stringify({
        sql: "SELECT CODE, NAME, \"ROOMNAME\" FROM S2_R_ROOM WHERE CODE = '10086' AND NAME = '张三'",
      }),
    };
    yield {
      type: "message_end",
      stopReason: "toolCalls",
      usage: { inputTokens: 6200, outputTokens: 45, cacheReadTokens: 3000, cacheWriteTokens: 7 },
      finishReason: "tool_calls",
    };
    return;
  }
  yield { type: "text_delta", text: "查到：10086 张三，房间 A 栋 301。" };
  yield {
    type: "message_end",
    stopReason: "stop",
    usage: { inputTokens: 6800, outputTokens: 32, cacheReadTokens: 5100 },
    finishReason: "stop",
  };
};

const dbTool: ToolDefinition<{ sql: string }, unknown> = {
  name: "query_dcs_data",
  label: "DCS数据库查询",
  description: "假数据库工具（样例）",
  parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  async execute(): Promise<ToolOutput> {
    return {
      output:
        "查询成功：返回 1 行。\nCODE | NAME | ROOMNAME\n10086 | 张三 | A栋301\n" +
        "诊断：扫描 3 个索引分区，耗时 42ms，缓冲区命中。".padEnd(220, "尾"),
      details: { rowCount: 1, columns: ["CODE", "NAME", "ROOMNAME"], truncated: false, empty: false },
    };
  },
};

for (const level of ["normal", "debug"] as const) {
  secondCall = false;
  const agent = new Agent<unknown>({
    systemPrompt: "样例 systemPrompt",
    tools: [dbTool],
    streamFn,
    toolContext: {},
    maxTurns: 4,
  });
  let consoleText = "";
  const jsonlDir = path.join(samplesDir, level);
  fs.rmSync(jsonlDir, { recursive: true, force: true });
  const observer = attachRunObserver(agent, {
    channel: "CLI",
    level,
    logsDir: jsonlDir,
    write: (t) => {
      consoleText += t + "\n";
    },
  });
  const reply = await agent.prompt("查一下我的宿舍房间");
  await observer.end("detached");
  // 去掉 ANSI 颜色码，便于阅读
  const plain = consoleText.replace(/\[[0-9;]*m/g, "");
  fs.writeFileSync(
    path.join(samplesDir, `sample-${level}.txt`),
    `> 你> 查一下我的宿舍房间\n> 助手> ${reply}\n\n--- ${level.toUpperCase()} 终端日志 ---\n${plain}`,
    "utf8"
  );
  const files = fs.readdirSync(jsonlDir).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    fs.copyFileSync(path.join(jsonlDir, f), path.join(samplesDir, `sample-run-${level}.jsonl`));
  }
  fs.rmSync(jsonlDir, { recursive: true, force: true });
  console.log(`已生成 ${level} 样例（${files.length} 个 JSONL）`);
}

console.log(`样例目录：${samplesDir}`);
