/**
 * observability/formatter.ts — 中文终端日志格式化（Console Formatter）。
 *
 * 设计：
 * - 输入为已经脱敏的事件视图（ObservedEvent，见 observer.ts），本模块只负责排版；
 * - 两种级别：normal（默认）/ debug（增加 SQL 结构、结果预览、参数详情、停止原因）；
 * - 兼容不支持 ANSI 的终端：通过 NO_COLOR / DCS_LOG_COLOR=0 关闭颜色，默认仍带颜色
 *   但所有状态标识同时有符号（✓/✗/⚠），无色终端信息不丢失；
 * - 控制默认输出长度：结果摘要截断（normal 120 字 / debug 400 字）。
 */
import type { TokenUsage, ToolExecutionDetails } from "../core/types.ts";
import type { ContextMessageSnapshot } from "../core/events.ts";

export type LogLevel = "normal" | "debug";

export function resolveLogLevel(): LogLevel {
  return (process.env.DCS_LOG_LEVEL ?? "").toLowerCase() === "debug" ? "debug" : "normal";
}

// ---- 颜色（ANSI；NO_COLOR 约定 + DCS_LOG_COLOR=0 关闭）----
const colorEnabled =
  process.env.NO_COLOR === undefined && process.env.DCS_LOG_COLOR !== "0";
const paint = (code: string) => (s: string): string =>
  colorEnabled ? `[${code}m${s}[0m` : s;
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const dim = paint("90");
const cyan = paint("36");
const bold = paint("1");

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")}s` : `${ms}ms`;
}

export function fmtTokens(n: number | undefined): string {
  return n === undefined ? "未提供" : n.toLocaleString("en-US");
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function divider(label: string): string {
  const body = ` ${label} `;
  const total = 44;
  const side = Math.max(0, Math.floor((total - body.length) / 2));
  return `━`.repeat(side) + body + `━`.repeat(Math.max(0, total - side - body.length));
}

/** 工具名 → 图标与中文名（未知工具也有合理展示）。 */
function toolFace(toolName: string): { icon: string; label: string } {
  switch (toolName) {
    case "query_dcs_data":
      return { icon: "🗄", label: "数据库查询" };
    case "exec_command":
      return { icon: "🔍", label: "Shell调查" };
    case "search_dcs_code":
      return { icon: "🔍", label: "源码搜索" };
    case "read_dcs_code":
      return { icon: "📄", label: "源码读取" };
    case "read_dcs_result":
      return { icon: "📄", label: "查询结果读取" };
    case "search_dcs_knowledge":
      return { icon: "📚", label: "知识库检索" };
    default:
      return { icon: "🔧", label: toolName };
  }
}

// ---- 事件视图（observer 组装好、已脱敏后传给 formatter）----

export interface RunStartView {
  runId: string;
  startedAt: string;
  channel: string;
  model: string;
  provider?: string;
}

export interface ModelCallStartView {
  turn: number;
  messageCount: number;
  messageCountDelta: number;
  toolSchemaCount: number;
  /** 本轮 System Prompt 文本（已脱敏；可选，未提供则不展示）。 */
  systemPromptText?: string;
  /** 本轮完整上下文消息快照（已脱敏；可选）。 */
  contextMessages?: ContextMessageSnapshot[];
}

export interface ModelCallEndView {
  turn: number;
  durationMs: number;
  stopReason: string;
  /** Provider 原始 finish_reason（与归一化 stopReason 分开展示）。 */
  finishReason?: string;
  toolCallCount: number;
  usage?: TokenUsage;
  errorMessage?: string;
}

export interface ToolCallView {
  step: number;
  turn: number;
  toolCallId: string;
  toolName: string;
  /** 已脱敏的参数摘要（JSON 单行）。 */
  argsSummary: string;
  /** query_dcs_data 的 SQL（凭据脱敏后；业务字面值与双引号字段名保留）。 */
  sql?: string;
  /** investigate/search 的关键词。 */
  query?: string;
  isError: boolean;
  durationMs: number;
  /** 已脱敏的结果摘要（发给模型的 ToolResult 摘要）。 */
  resultSummary: string;
  /** 组装入上下文的完整结果（凭据脱敏后；超限标注截断）。 */
  contextText?: string;
  /** contextText 是否被日志体积上限截断。 */
  contextTruncated?: boolean;
  /** contextText 原始长度（截断时提供）。 */
  contextLength?: number;
  /** 工具原始结果（仅处理前后不同时提供）。 */
  rawText?: string;
  details?: ToolExecutionDetails;
  note?: string;
}

export interface RunSummary {
  status: "completed" | "failed";
  reason: string;
  modelCalls: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  emptyResults: number;
  duplicateToolCalls: number;
  /** 完整总量（任一轮缺失时为 null，用 coverage 表达已知小计）。 */
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** 部分缺失时的已知小计与覆盖轮数（null 表示完整或未提供）。 */
  cacheReadCoverage: { known: number; turns: number; of: number } | null;
  cacheWriteCoverage: { known: number; turns: number; of: number } | null;
  inputCoverage: { known: number; turns: number; of: number } | null;
  outputCoverage: { known: number; turns: number; of: number } | null;
  modelDurationMs: number;
  toolDurationMs: number;
  elapsedMs: number;
  jsonlPath?: string;
}

const REASON_TEXT: Record<string, string> = {
  completed: "正常完成",
  max_turns: "达到最大执行轮次",
  model_error: "模型接口失败",
  unexpected: "其他异常",
  timeout: "请求超时（通道层结束）",
  disconnected: "客户端断开（通道层结束）",
  detached: "观测被解除（通道层结束）",
};

export function formatRunStart(v: RunStartView): string {
  return [
    "",
    bold("▶ DCS Agent 开始执行"),
    `  时间：${fmtClock(v.startedAt)}`,
    `  通道：${v.channel}`,
    `  Run ID：${cyan(v.runId)}`,
    `  模型：${v.model}`,
    v.provider ? dim(`  Provider：${v.provider}`) : "",
  ].filter(Boolean).join("\n");
}

export function formatModelCallStart(v: ModelCallStartView, level: LogLevel = "normal"): string {
  const delta = v.turn === 1 ? "" : dim(`（+${v.messageCountDelta}）`);
  const lines = [
    "",
    bold(divider(`第 ${v.turn} 轮：模型调用`)),
    dim(`  上下文消息：${v.messageCount} 条${delta}，工具 Schema：${v.toolSchemaCount} 个`),
  ];
  // DEBUG：完整展示本轮实际发送给模型的上下文（System Prompt + 每条消息）。
  // NORMAL 保持简洁，不打扰常规使用。
  if (level === "debug" && (v.systemPromptText !== undefined || v.contextMessages !== undefined)) {
    lines.push(dim("  ── 本轮上下文（DEBUG）──"));
    if (v.systemPromptText !== undefined) {
      lines.push(dim(`  [system]（${v.systemPromptText.length} 字）`));
      for (const l of v.systemPromptText.split("\n")) lines.push(dim(`    ${l}`));
    }
    for (const [i, m] of (v.contextMessages ?? []).entries()) {
      const label = m.role === "toolResult"
        ? `toolResult(${m.toolName ?? "?"})${m.isError ? "✗" : ""}`
        : m.role;
      lines.push(dim(`  [${String(i + 1).padStart(2, "0")}] ${label}（${m.content.length} 字）`));
      for (const l of m.content.split("\n")) lines.push(dim(`    ${l}`));
      for (const tc of m.toolCalls ?? []) {
        lines.push(dim(`      ↳ toolCall ${tc.name}(${tc.arguments})`));
      }
    }
    lines.push(dim("  ── 上下文结束 ──"));
  }
  return lines.join("\n");
}

export function formatModelCallEnd(v: ModelCallEndView, level: LogLevel): string {
  if (v.stopReason === "error") {
    const lines = [
      red("  ✗ 模型调用失败"),
      `  耗时：${fmtMs(v.durationMs)}`,
      `  错误：${truncate(v.errorMessage ?? "未知错误", level === "debug" ? 300 : 120)}`,
    ];
    return lines.join("\n");
  }
  const lines = [
    `  ${dim("模型响应完成")}`,
    `  耗时：${fmtMs(v.durationMs)}`,
    `  输入 Token：${fmtTokens(v.usage?.inputTokens)}`,
    `  输出 Token：${fmtTokens(v.usage?.outputTokens)}`,
  ];
  if (v.usage?.cacheReadTokens !== undefined || v.usage?.cacheWriteTokens !== undefined) {
    lines.push(
      `  缓存 Token：读取 ${fmtTokens(v.usage.cacheReadTokens)} / 写入 ${fmtTokens(v.usage.cacheWriteTokens)}`
    );
  }
  if (v.toolCallCount > 0) {
    lines.push(`  返回：${v.toolCallCount} 个 Tool Call`);
  }
  if (level === "debug") {
    lines.push(dim(`  停止原因：${v.stopReason}`));
    if (v.finishReason !== undefined && v.finishReason !== v.stopReason) {
      lines.push(dim(`  Provider 原始停止原因：${v.finishReason}`));
    }
  }
  return lines.join("\n");
}

export function formatToolCall(v: ToolCallView, level: LogLevel): string {
  const face = toolFace(v.toolName);
  const stepTag = `[${String(v.step).padStart(2, "0")}]`;
  const lines: string[] = [`  ${bold(stepTag)} ${face.icon} ${bold(face.label)}`];
  if (v.sql) {
    // DEBUG 显示完整 SQL（凭据已脱敏，业务条件与字段名是排障必需）；
    // NORMAL 保持摘要
    lines.push(dim(`       SQL：${level === "debug" ? v.sql : truncate(v.sql, 100)}`));
  } else if (v.query !== undefined) {
    lines.push(dim(`       关键词：${level === "debug" ? v.query : truncate(v.query, 120)}`));
  } else {
    lines.push(dim(`       工具：${v.toolName}`));
  }
  if (level === "debug") {
    lines.push(dim(`       参数：${v.argsSummary}`));
    lines.push(dim(`       toolCallId：${v.toolCallId}（第 ${v.turn} 轮）`));
  }

  lines.push("");
  if (v.isError) {
    lines.push(`       ${red("✗ 执行失败")}`);
  } else if (v.details?.empty) {
    lines.push(`       ${yellow("⚠ 空结果")}`);
  } else {
    lines.push(`       ${green("✓ 执行成功")}`);
  }

  const d = v.details;
  if (d) {
    if (d.errorCode) lines.push(`       错误码：${d.errorCode}`);
    if (d.rowCount !== undefined) lines.push(`       返回：${d.rowCount} 行`);
    if (d.columns && d.columns.length > 0 && level === "debug") {
      lines.push(dim(`       字段：${d.columns.join(", ")}`));
    }
    if (d.truncated) lines.push(`       ${yellow("结果已截断")}`);
    if (d.scannedFiles !== undefined) lines.push(`       扫描文件：${d.scannedFiles.toLocaleString("en-US")}`);
    if (d.hitCount !== undefined) lines.push(`       命中：${d.hitCount} 处`);
    if (d.hitLimitReached) lines.push(`       ${yellow("已达单次命中上限")}`);
    if (d.chunkCount !== undefined) lines.push(`       返回片段：${d.chunkCount} 个`);
  }
  if (v.note) lines.push(dim(`       说明：${v.note}`));
  if (v.isError || level === "debug") {
    if (level === "debug" && v.contextText !== undefined) {
      // DEBUG：组装入上下文的完整结果（凭据脱敏后；截断有明确标注）
      lines.push(dim(`       结果（组装入上下文，${v.contextLength ?? v.contextText.length} 字）：${v.contextText}`));
      if (v.rawText !== undefined) {
        lines.push(dim(`       原始结果（处理前）：${v.rawText}`));
      }
    } else {
      lines.push(dim(`       结果：${truncate(v.resultSummary, 160)}`));
    }
  }
  lines.push(`       耗时：${fmtMs(v.durationMs)}`);
  return lines.join("\n");
}

export function formatRunEnd(s: RunSummary): string {
  const lines: string[] = ["", bold(divider("任务结束"))];
  lines.push(
    s.status === "completed"
      ? `  状态：${green("成功")}`
      : `  状态：${red("失败")}`
  );
  lines.push(`  原因：${REASON_TEXT[s.reason] ?? s.reason}`);
  lines.push("");
  lines.push(`  模型调用：${s.modelCalls} 次`);
  lines.push(`  工具调用：${s.toolCalls} 次（成功 ${s.successfulToolCalls} / 失败 ${s.failedToolCalls}）`);
  if (s.emptyResults > 0) lines.push(`  空结果：${s.emptyResults} 次`);
  if (s.duplicateToolCalls > 0) lines.push(`  重复调用：${s.duplicateToolCalls} 次`);
  const fmtTotal = (total: number | null, cov: { known: number; turns: number; of: number } | null): string => {
    if (total !== null) return total.toLocaleString("en-US");
    if (cov) return `未知（已知小计 ${cov.known.toLocaleString("en-US")}，覆盖 ${cov.turns}/${cov.of} 轮）`;
    return "未提供";
  };
  lines.push(`  总输入 Token：${fmtTotal(s.totalInputTokens, s.inputCoverage)}`);
  lines.push(`  总输出 Token：${fmtTotal(s.totalOutputTokens, s.outputCoverage)}`);
  if (s.cacheReadTokens !== null || s.cacheReadCoverage) {
    lines.push(`  缓存 Token（读取）：${fmtTotal(s.cacheReadTokens, s.cacheReadCoverage)}`);
  }
  if (s.cacheWriteTokens !== null || s.cacheWriteCoverage) {
    lines.push(`  缓存 Token（写入）：${fmtTotal(s.cacheWriteTokens, s.cacheWriteCoverage)}`);
  }
  lines.push(`  模型累计耗时：${fmtMs(s.modelDurationMs)}`);
  lines.push(`  工具累计耗时：${fmtMs(s.toolDurationMs)}`);
  lines.push(`  总执行时间：${fmtMs(s.elapsedMs)}`);
  if (s.jsonlPath) lines.push(dim(`  JSONL：${s.jsonlPath}`));
  lines.push("");
  return lines.join("\n");
}
