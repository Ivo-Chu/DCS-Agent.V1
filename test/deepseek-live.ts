/**
 * DeepSeek StreamFn 真实 key 单测（方案 §12 步骤 2）。
 *
 * 判定规则（审查修复 F4）：
 * - 未设置 DEEPSEEK_API_KEY → 输出 SKIPPED（未验证）并退出，不以假模型代替、不假装通过；
 * - 必须出现工具调用的用例：模型未发起工具调用 / id / name / 参数不完整 → FAIL（exit 1），
 *   不允许仅 warn 后仍打印成功横幅；
 * - 全部用例通过才输出 PASS 横幅。
 *
 * 运行：npm run test:live
 * 内容：
 * 1. 纯文本流式调用 → 事件流打印 → 确认 SSE 解析正常
 * 2. 工具调用流式 → 确认 tool_call 增量聚合出完整 id / name / 可解析 JSON 参数
 * 3. 错误契约 → 不可达地址确认失败编码为 stopReason:"error"、永不 reject
 */
import type { AgentMessage, ModelStreamEvent, StreamFn } from "../src/core/types.ts";
import { createDeepSeekStreamFn } from "../src/core/model/deepseek.ts";
import { dcsTools } from "../src/dcs/tools.ts";

interface ToolCallRecord {
  id: string;
  name: string;
  args: string;
}

interface DrainResult {
  stopReason: string;
  text: string;
  toolCalls: ToolCallRecord[];
  errorMessage?: string;
}

let failed = 0;

function pass(name: string): void {
  console.log(`    ✓ ${name}`);
}

function fail(name: string, detail?: string): void {
  failed++;
  console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
}

async function drain(
  label: string,
  streamFn: StreamFn,
  messages: AgentMessage[],
  withTools: boolean
): Promise<DrainResult> {
  console.log(`\n===== ${label} =====`);
  let text = "";
  let stopReason = "";
  let errorMessage: string | undefined;
  const byIndex = new Map<number, ToolCallRecord>();
  for await (const ev of streamFn({
    systemPrompt: "你是测试助手，请简短回答。",
    messages,
    tools: withTools
      ? dcsTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      : [],
  })) {
    if (ev.type === "text_delta") {
      text += ev.text;
      process.stdout.write(ev.text);
    } else if (ev.type === "tool_call_start") {
      byIndex.set(ev.index, { id: ev.toolCallId, name: ev.name, args: "" });
      console.log(`\n[tool_call_start] ${ev.toolCallId} ${ev.name}`);
    } else if (ev.type === "tool_call_delta") {
      const rec = byIndex.get(ev.index);
      if (rec) {
        rec.args += ev.argumentsDelta;
        process.stdout.write(ev.argumentsDelta);
      }
    } else {
      stopReason = ev.stopReason;
      if (ev.errorMessage) {
        errorMessage = ev.errorMessage;
        console.log(`\n[errorMessage] ${ev.errorMessage}`);
      }
    }
  }
  console.log(`\n[stopReason] ${stopReason}`);
  console.log(`[assembled text] ${text.slice(0, 200)}`);
  const toolCalls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (toolCalls.length > 0) {
    console.log(`[toolCalls] ${toolCalls.map((t) => `${t.id}:${t.name}`).join(", ")}`);
  }
  return { stopReason, text, toolCalls, errorMessage };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("========== SKIPPED（未验证） ==========");
    console.log("未设置 DEEPSEEK_API_KEY：真实模型单测未执行。");
    console.log("本脚本不接受假模型代替，跳过 ≠ 通过。");
    console.log("设置后重试：$env:DEEPSEEK_API_KEY = 'sk-xxxxxxxx'（PowerShell）");
    console.log("            export DEEPSEEK_API_KEY='sk-xxxxxxxx'（bash）");
    console.log("然后运行：npm run test:live");
    process.exit(0);
  }

  const good = createDeepSeekStreamFn();

  // 1. 纯文本
  const r1 = await drain(
    "1. 纯文本流式",
    good,
    [{ role: "user", content: "用一句话介绍你自己。" }],
    false
  );
  r1.stopReason === "stop" && r1.text.trim().length > 0
    ? pass("1a 正常完成（stopReason=stop，文本非空）")
    : fail(
        "1a 正常完成（stopReason=stop，文本非空）",
        `stopReason=${r1.stopReason} text="${r1.text.slice(0, 50)}" err=${r1.errorMessage ?? ""}`
      );

  // 2. 工具调用（必须出现，缺失即 FAIL）
  const r2 = await drain(
    "2. 工具调用流式",
    good,
    [{ role: "user", content: "为什么我没有权限管理菜单？" }],
    true
  );
  if (r2.toolCalls.length === 0) {
    fail("2a 模型发起了工具调用", "模型未发起任何工具调用（此用例必须出现工具调用，缺失即 FAIL）");
  } else {
    pass(`2a 模型发起了工具调用（${r2.toolCalls.length} 个）`);
    const allComplete = r2.toolCalls.every((t) => t.id.length > 0 && t.name.length > 0);
    allComplete
      ? pass("2b 每个工具调用都有完整 id 与 name")
      : fail("2b 每个工具调用都有完整 id 与 name", JSON.stringify(r2.toolCalls));
    const allParseable = r2.toolCalls.every((t) => {
      try {
        JSON.parse(t.args);
        return true;
      } catch {
        return false;
      }
    });
    allParseable
      ? pass("2c 工具参数为完整可解析 JSON")
      : fail("2c 工具参数为完整可解析 JSON", r2.toolCalls.map((t) => t.args).join(" | "));
    r2.stopReason === "toolCalls"
      ? pass("2d stopReason=toolCalls")
      : fail("2d stopReason=toolCalls", `实际 ${r2.stopReason}`);
  }

  // 3. 错误契约
  const bad = createDeepSeekStreamFn({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:1" });
  const r3 = await drain(
    "3. 错误契约（不可达地址）",
    bad,
    [{ role: "user", content: "测试" }],
    false
  );
  r3.stopReason === "error" && (r3.errorMessage ?? "").length > 0
    ? pass("3a 失败编码为 stopReason:error（含错误说明，永不 reject）")
    : fail("3a 失败编码为 stopReason:error", `stopReason=${r3.stopReason}`);

  console.log("\n========== 结果 ==========");
  if (failed > 0) {
    console.log(`FAIL：${failed} 项未通过`);
    process.exit(1);
  }
  console.log("PASS：DeepSeek 真实 key 单测全部通过");
}

main();
