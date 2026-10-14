/**
 * observability/observer.ts — Run 观测编排器（Agent Events → Console + JSONL）。
 *
 * 架构（唯一数据流，不额外调用模型/工具）：
 *
 *              Agent Runtime
 *                    │ AgentEvent
 *                    ▼
 *           attachRunObserver（本模块）
 *                    │  脱敏（redact.ts：仅凭据）
 *           ┌────────┴────────┐
 *           ▼                 ▼
 *    Console Formatter    JSONL Writer
 *    （中文终端日志）      （logs/*.jsonl）
 *
 * 每个 prompt() 一个 observer 实例（per-Run 状态，天然并发隔离）；
 * 同一 Agent 上多个 observer 并存时，通过 runId 只消费本次 Run 的事件。
 * observer 只消费事件，不产生副作用影响 Agent；自身异常全部吞掉。
 *
 * 2026-10-13 修复（审核 F3/F4/F5）：
 * - F3：observer 提供幂等的 end(reason) 结束入口——通道超时/断开路径
 *   调用 end() 记录准确结束原因并 flush；run_end 与 end 重复到达只终结
 *   一次，迟到事件不重开已结束日志。
 * - F4：重复调用指纹使用【原始参数的内存稳定规范化】（键排序），不使用
 *   脱敏摘要；SQL 字面值不同即不同调用；无法可靠比较时跳过。
 * - F5：Usage 逐轮跟踪完整性——任一轮缺失时总量标为未知（null）并
 *   保留已知小计与覆盖轮数；缓存读取/写入分别累计。
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../core/events.ts";
import type { ContextMessageSnapshot } from "../core/events.ts";
import {
  formatModelCallEnd,
  formatModelCallStart,
  formatRunEnd,
  formatRunStart,
  formatToolCall,
  resolveLogLevel,
  type LogLevel,
  type RunSummary,
} from "./formatter.ts";
import { JsonlWriter } from "./jsonl-writer.ts";
import { redactArgs, redactSql, redactText, redactValue } from "./redact.ts";

/** 订阅源最小契约（core Agent 与测试 FakeAgent 均满足）。 */
export interface Subscribable {
  subscribe(fn: (e: AgentEvent) => void): () => void;
}

export interface RunObserverOptions {
  /** 通道标识（cli / web / wecom）。 */
  channel: string;
  /**
   * 模型名兜底（run_start 事件已携带 model 时优先用事件值）。
   * 兼容旧调用方；新代码应从事件取实际配置。
   */
  model?: string;
  /** 终端输出级别（默认读 DCS_LOG_LEVEL）。 */
  level?: LogLevel;
  /** JSONL 输出目录（默认项目根 logs/，与启动 cwd 无关）。 */
  logsDir?: string;
  /** 终端写入（默认 process.stdout.write）；传 null 关闭终端输出。 */
  write?: ((text: string) => void) | null;
  /** 是否写 JSONL（默认 true）。 */
  jsonl?: boolean;
}

/** 通道超时/断开等异常结束时调用 end() 的结束原因（run_end 事件之外的原因）。 */
export type ObserverEndReason = "timeout" | "disconnected" | "detached";

export interface RunObserverHandle {
  /** 仅退订（不再消费后续事件），不记录结束。正常路径 run_end 已终结后调用。 */
  detach(): void;
  /**
   * 幂等结束：记录准确结束原因并 flush（返回 flush 完成的 Promise，
   * 测试可 await；不得为等待日志无限拖延回复）。
   * 正常 run_end 已终结后再次调用是 no-op。
   */
  end(reason: ObserverEndReason): Promise<void>;
}

/** 项目根默认日志目录（从 import.meta.url 定位，与启动 cwd 无关）。 */
const DEFAULT_LOGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "logs"
);

/** JSONL 单次结果文本落盘上限（超过明确标注截断与长度，禁止无提示丢失）。 */
const RESULT_TEXT_MAX = 8000;

/**
 * 原始参数的内存稳定规范化（键排序后的 JSON 序列化）。
 * 用于重复调用指纹：对象键顺序不同但值相同 → 同一指纹；
 * SQL 字面值不同 → 不同指纹。只存内存，不落盘。
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 截断标注：保留头部，明确标记截断与原始长度。 */
function capped(text: string, max: number): { text: string; truncated: boolean; fullLength: number } {
  const fullLength = text.length;
  if (fullLength <= max) return { text, truncated: false, fullLength };
  return { text: `${text.slice(0, max)}…<已截断，共 ${fullLength} 字>`, truncated: true, fullLength };
}

/** JSONL 单条上下文消息上限（超过明确标注截断与长度）。 */
const CONTEXT_MESSAGE_MAX = 8000;

/**
 * 脱敏上下文消息快照（日志副本，不修改运行时消息）：
 * 业务数据（员工工号/姓名/查询明细）保留，仅遮蔽凭据；单条超上限标注截断。
 */
function redactContextMessages(
  messages: ContextMessageSnapshot[]
): { messages: (ContextMessageSnapshot & { truncated?: boolean; fullLength?: number })[]; truncatedCount: number } {
  let truncatedCount = 0;
  const out = messages.map((m) => {
    const c = capped(redactText(m.content), CONTEXT_MESSAGE_MAX);
    if (c.truncated) truncatedCount++;
    return {
      ...m,
      content: c.text,
      toolCalls: m.toolCalls?.map((tc) => ({
        ...tc,
        arguments: redactText(tc.arguments),
      })),
      ...(c.truncated ? { truncated: true, fullLength: c.fullLength } : {}),
    };
  });
  return { messages: out, truncatedCount };
}

interface PendingTool {
  turn: number;
  step: number;
  argsSummary: string;
  sql?: string;
  query?: string;
}

/** 逐轮 Usage 跟踪（完整性：部分缺失时总量标未知，保留已知小计与覆盖轮数）。 */
interface UsageTracker {
  /** 已观察到的模型调用轮数（model_call_end 计数）。 */
  turns: number;
  /** 有对应字段数据的轮数。 */
  inputTurns: number;
  outputTurns: number;
  cacheReadTurns: number;
  cacheWriteTurns: number;
  /** 已知小计（仅含提供数据的轮次；未提供轮次不计 0）。 */
  inputSum: number;
  outputSum: number;
  cacheReadSum: number;
  cacheWriteSum: number;
}

/**
 * 为一次 Run 挂载观测。observer 永不抛出；内部异常全部被吞掉。
 */
export function attachRunObserver(
  agent: Subscribable,
  opts: RunObserverOptions
): RunObserverHandle {
  const level = opts.level ?? resolveLogLevel();
  const write = opts.write === null ? null : (opts.write ?? ((t: string) => process.stdout.write(t + "\n")));
  const useJsonl = opts.jsonl !== false;
  const logsDir = opts.logsDir ?? DEFAULT_LOGS_DIR;

  let writer: JsonlWriter | null = null;
  const pendingTools = new Map<string, PendingTool>();
  const toolFingerprints = new Map<string, number>();
  let runId: string | null = null;
  let startedAt = 0;
  /** 终结标志：run_end 或 end() 任一到达即置位，只终结一次。 */
  let finished = false;
  /** 终端行 runId 前缀（共享终端多 Run 并发可归属）。 */
  const tag = (): string => (runId ? `[${runId}] ` : "");

  const usage: UsageTracker = {
    turns: 0,
    inputTurns: 0,
    outputTurns: 0,
    cacheReadTurns: 0,
    cacheWriteTurns: 0,
    inputSum: 0,
    outputSum: 0,
    cacheReadSum: 0,
    cacheWriteSum: 0,
  };
  const summary: RunSummary = {
    status: "completed",
    reason: "completed",
    modelCalls: 0,
    toolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    emptyResults: 0,
    duplicateToolCalls: 0,
    totalInputTokens: null,
    totalOutputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputCoverage: null,
    outputCoverage: null,
    cacheReadCoverage: null,
    cacheWriteCoverage: null,
    modelDurationMs: 0,
    toolDurationMs: 0,
    elapsedMs: 0,
  };

  const jsonl = (record: Record<string, unknown>): void => {
    writer?.write(record);
  };
  const out = (text: string): void => {
    if (write) {
      try {
        write(text.split("\n").map((line) => tag() + line).join("\n"));
      } catch {
        // 终端写入失败不影响主流程
      }
    }
  };

  /** 汇总 Usage：任一轮缺失 → 总量 null + coverage 记录已知小计/覆盖轮数。 */
  const finalizeUsage = (): void => {
    if (usage.turns > 0 && usage.inputTurns === usage.turns) {
      summary.totalInputTokens = usage.inputSum;
      summary.inputCoverage = null;
    } else if (usage.inputTurns > 0) {
      summary.totalInputTokens = null;
      summary.inputCoverage = { known: usage.inputSum, turns: usage.inputTurns, of: usage.turns };
    }
    if (usage.turns > 0 && usage.outputTurns === usage.turns) {
      summary.totalOutputTokens = usage.outputSum;
      summary.outputCoverage = null;
    } else if (usage.outputTurns > 0) {
      summary.totalOutputTokens = null;
      summary.outputCoverage = { known: usage.outputSum, turns: usage.outputTurns, of: usage.turns };
    }
    // 缓存字段：Provider 逐轮可选；不与 input 重复相加，分别累计
    for (const kind of ["cacheRead", "cacheWrite"] as const) {
      const turns = usage[kind + "Turns" as "cacheReadTurns" | "cacheWriteTurns"];
      const sum = usage[kind + "Sum" as "cacheReadSum" | "cacheWriteSum"];
      if (usage.turns > 0 && turns === usage.turns) summary[`${kind}Tokens`] = sum;
      else if (turns > 0) summary[`${kind}Coverage`] = { known: sum, turns, of: usage.turns };
    }
  };

  const finalizeDuplicates = (): void => {
    summary.duplicateToolCalls = [...toolFingerprints.values()]
      .filter((n) => n > 1)
      .reduce((acc, n) => acc + n - 1, 0);
  };

  /**
   * 终结（幂等）：正常 run_end 与 end() 重复到达只执行一次。
   * 迟到事件在 finished 后被丢弃，不会重新打开已结束日志。
   * record 使用工厂函数：在 finalizeUsage/finalizeDuplicates 之后构建，
   * 确保 JSONL 落盘的是汇总后的最终值。
   */
  let endPromise: Promise<void> | null = null;
  const finalize = (buildRecord: () => Record<string, unknown>): Promise<void> => {
    if (endPromise) return endPromise;
    finished = true;
    finalizeUsage();
    finalizeDuplicates();
    summary.jsonlPath = writer?.displayPath;
    out(formatRunEnd(summary));
    jsonl(buildRecord());
    unsub();
    endPromise = writer ? writer.flush().catch(() => undefined) : Promise.resolve();
    return endPromise;
  };

  const unsub = agent.subscribe((e) => {
    // 并发隔离：只消费本次 Run 的事件（run_start 确定 runId 后过滤）
    if (finished) return;
    if (e.type === "run_start") {
      if (runId !== null) return; // 已有归属，忽略其他 Run
      runId = e.runId;
    } else if (runId !== null && "runId" in e && e.runId !== runId) {
      return;
    } else if (runId === null) {
      // run_start 尚未到达，忽略其他事件
      return;
    }
    try {
      switch (e.type) {
        case "run_start": {
          startedAt = new Date(e.startedAt).getTime();
          if (useJsonl) writer = new JsonlWriter(logsDir, e.runId, new Date(e.startedAt));
          // 模型名优先取事件实际配置（factory 统一提供），兜底通道传入值
          const model = e.model ?? opts.model ?? "未知";
          out(formatRunStart({
            runId: e.runId,
            startedAt: e.startedAt,
            channel: opts.channel,
            model,
            provider: e.provider,
          }));
          jsonl({
            timestamp: e.startedAt,
            runId: e.runId,
            event: "run_start",
            channel: opts.channel,
            model,
            provider: e.provider ?? null,
          });
          break;
        }
        case "model_call_start": {
          summary.modelCalls++;
          usage.turns++;
          const sysPrompt = e.systemPromptText !== undefined
            ? redactText(e.systemPromptText)
            : undefined;
          const ctx = e.contextMessages !== undefined
            ? redactContextMessages(e.contextMessages)
            : undefined;
          out(formatModelCallStart({
            turn: e.turn,
            messageCount: e.messageCount,
            messageCountDelta: e.messageCountDelta,
            toolSchemaCount: e.toolSchemaCount,
            systemPromptText: sysPrompt,
            contextMessages: ctx?.messages,
          }, level));
          jsonl({
            timestamp: new Date().toISOString(),
            runId: e.runId,
            event: "model_call_start",
            turn: e.turn,
            messageCount: e.messageCount,
            messageCountDelta: e.messageCountDelta,
            hasSystemPrompt: e.hasSystemPrompt,
            toolSchemaCount: e.toolSchemaCount,
            // 本轮实际发送给模型的完整上下文（凭据脱敏后的日志副本；
            // 快照在发射时固定，之后的运行时变化不影响本记录）
            systemPromptText: sysPrompt ?? null,
            contextMessages: ctx?.messages ?? null,
            contextTruncatedMessages: ctx?.truncatedCount ?? 0,
          });
          break;
        }
        case "model_call_end": {
          summary.modelDurationMs += e.durationMs;
          if (e.usage?.inputTokens !== undefined) {
            usage.inputTurns++;
            usage.inputSum += e.usage.inputTokens;
          }
          if (e.usage?.outputTokens !== undefined) {
            usage.outputTurns++;
            usage.outputSum += e.usage.outputTokens;
          }
          if (e.usage?.cacheReadTokens !== undefined) {
            usage.cacheReadTurns++;
            usage.cacheReadSum += e.usage.cacheReadTokens;
          }
          if (e.usage?.cacheWriteTokens !== undefined) {
            usage.cacheWriteTurns++;
            usage.cacheWriteSum += e.usage.cacheWriteTokens;
          }

          out(formatModelCallEnd({
            turn: e.turn,
            durationMs: e.durationMs,
            stopReason: e.stopReason,
            finishReason: e.finishReason,
            toolCallCount: e.toolCallCount,
            usage: e.usage,
            errorMessage: e.errorMessage ? redactText(e.errorMessage) : undefined,
          }, level));
          jsonl({
            timestamp: new Date().toISOString(),
            runId: e.runId,
            event: "model_call_end",
            turn: e.turn,
            durationMs: e.durationMs,
            stopReason: e.stopReason,
            finishReason: e.finishReason ?? null,
            toolCallCount: e.toolCallCount,
            inputTokens: e.usage?.inputTokens ?? null,
            outputTokens: e.usage?.outputTokens ?? null,
            cacheReadTokens: e.usage?.cacheReadTokens ?? null,
            cacheWriteTokens: e.usage?.cacheWriteTokens ?? null,
            errorMessage: e.errorMessage ? redactText(e.errorMessage) : undefined,
          });
          break;
        }
        case "tool_execution_start": {
          summary.toolCalls++;
          const argsSummary = redactArgs(e.toolName, e.args);
          const rec = typeof e.args === "object" && e.args !== null
            ? (e.args as Record<string, unknown>)
            : {};
          const sql = typeof rec.sql === "string" ? redactSql(rec.sql) : undefined;
          const query = typeof rec.query === "string" ? redactText(rec.query) : undefined;
          pendingTools.set(e.toolCallId, {
            turn: e.turn,
            step: e.step,
            argsSummary,
            sql,
            query,
          });
          // 重复调用统计：工具名 + 原始参数的内存稳定规范化指纹
          // （不持久化、不使用脱敏摘要；SQL 字面值不同即不同调用）
          let fp: string | null = null;
          try {
            fp = `${e.toolName}:${canonicalize(e.args)}`;
          } catch {
            fp = null; // 无法可靠比较时跳过（不猜测）
          }
          if (fp !== null) {
            toolFingerprints.set(fp, (toolFingerprints.get(fp) ?? 0) + 1);
          }
          // 工具开始时立即给出简洁提示（不等执行完）
          out(`  ▶ 工具调用 [${String(e.step).padStart(2, "0")}] ${e.toolName}`);
          jsonl({
            timestamp: new Date().toISOString(),
            runId: e.runId,
            event: "tool_start",
            turn: e.turn,
            step: e.step,
            toolCallId: e.toolCallId,
            tool: e.toolName,
            args: argsSummary,
          });
          break;
        }
        case "tool_execution_end": {
          const pending = pendingTools.get(e.toolCallId);
          pendingTools.delete(e.toolCallId);
          summary.toolDurationMs += e.durationMs;
          if (e.isError) summary.failedToolCalls++;
          else summary.successfulToolCalls++;
          if (e.details?.empty === true) summary.emptyResults++;

          // ToolResult 三层：
          // 1. summary —— 原有消费者摘要（120 字，NORMAL 终端展示）；
          // 2. contextText —— 组装入上下文的完整结果（afterToolCall 处理后）；
          // 3. rawText —— 工具 execute 原始结果（处理前；相同时省略）。
          // DEBUG/JSONL 使用脱敏后的完整文本（有上限，超限明确标注）。
          const contextText = e.contextText ?? e.summary;
          const contextCapped = capped(redactText(contextText), RESULT_TEXT_MAX);
          const rawCapped = e.rawText !== undefined
            ? capped(redactText(e.rawText), RESULT_TEXT_MAX)
            : null;

          const view = {
            step: e.step,
            turn: e.turn,
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            argsSummary: pending?.argsSummary ?? "",
            sql: pending?.sql,
            query: pending?.query,
            isError: e.isError,
            durationMs: e.durationMs,
            resultSummary: redactText(e.summary),
            contextText: contextCapped.text,
            contextTruncated: contextCapped.truncated,
            contextLength: contextCapped.fullLength,
            rawText: rawCapped?.text,
            details: e.details,
            note: e.note,
          };
          out(formatToolCall(view, level));
          jsonl({
            timestamp: new Date().toISOString(),
            runId: e.runId,
            event: "tool_end",
            turn: e.turn,
            step: e.step,
            toolCallId: e.toolCallId,
            tool: e.toolName,
            durationMs: e.durationMs,
            isError: e.isError,
            rowCount: e.details?.rowCount ?? null,
            columns: e.details?.columns ?? null,
            truncated: e.details?.truncated ?? null,
            errorCode: e.details?.errorCode ?? null,
            scannedFiles: e.details?.scannedFiles ?? null,
            hitCount: e.details?.hitCount ?? null,
            hitLimitReached: e.details?.hitLimitReached ?? null,
            chunkCount: e.details?.chunkCount ?? null,
            empty: e.details?.empty ?? null,
            note: e.note,
            // 组装入上下文的完整结果（凭据脱敏后；超限标注截断与长度）
            resultText: contextCapped.text,
            resultTruncated: contextCapped.truncated,
            resultLength: contextCapped.fullLength,
            // 工具原始结果（仅当处理前后不同；相同标注一致不重复保存）
            rawResult: rawCapped?.text ?? null,
            resultChanged: rawCapped !== null,
            // 旧摘要字段保留（兼容原有消费者）
            resultSummary: redactText(e.summary),
          });
          break;
        }
        case "run_end": {
          // 计数权威来源：core run_end 事件（真实执行计数）
          summary.status = e.status;
          summary.reason = e.reason;
          summary.elapsedMs = e.elapsedMs;
          summary.modelCalls = e.modelCalls;
          summary.toolCalls = e.toolCalls;
          void finalize(() => ({
            timestamp: new Date().toISOString(),
            runId: e.runId,
            event: "run_end",
            status: e.status,
            reason: e.reason,
            elapsedMs: e.elapsedMs,
            modelCalls: e.modelCalls,
            toolCalls: e.toolCalls,
            successfulToolCalls: summary.successfulToolCalls,
            failedToolCalls: summary.failedToolCalls,
            emptyResults: summary.emptyResults,
            duplicateToolCalls: summary.duplicateToolCalls,
            totalInputTokens: summary.totalInputTokens,
            totalOutputTokens: summary.totalOutputTokens,
            cacheReadTokens: summary.cacheReadTokens,
            cacheWriteTokens: summary.cacheWriteTokens,
            inputCoverage: summary.inputCoverage,
            outputCoverage: summary.outputCoverage,
            cacheReadCoverage: summary.cacheReadCoverage,
            cacheWriteCoverage: summary.cacheWriteCoverage,
            modelDurationMs: summary.modelDurationMs,
            toolDurationMs: summary.toolDurationMs,
          }));
          break;
        }
        default:
          break;
      }
    } catch {
      // observer 自身异常绝不向上传播
    }
  });

  return {
    detach(): void {
      unsub();
    },
    end(reason: ObserverEndReason): Promise<void> {
      // 幂等：正常 run_end 已终结后再次 end() 是 no-op
      if (finished) return endPromise ?? Promise.resolve();
      // run_start 未到达（runId 未知）：无日志可终结，直接退订
      if (runId === null) {
        finished = true;
        unsub();
        return Promise.resolve();
      }
      summary.status = "failed";
      summary.reason = reason;
      summary.elapsedMs = Math.max(0, Date.now() - startedAt);
      return finalize(() => ({
        timestamp: new Date().toISOString(),
        runId,
        event: "run_end",
        status: "failed",
        reason,
        elapsedMs: summary.elapsedMs,
        modelCalls: summary.modelCalls,
        toolCalls: summary.toolCalls,
        successfulToolCalls: summary.successfulToolCalls,
        failedToolCalls: summary.failedToolCalls,
        emptyResults: summary.emptyResults,
        duplicateToolCalls: summary.duplicateToolCalls,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        cacheWriteTokens: summary.cacheWriteTokens,
        inputCoverage: summary.inputCoverage,
        outputCoverage: summary.outputCoverage,
            cacheReadCoverage: summary.cacheReadCoverage,
            cacheWriteCoverage: summary.cacheWriteCoverage,
        modelDurationMs: summary.modelDurationMs,
        toolDurationMs: summary.toolDurationMs,
        note: `通道层结束（${reason}）：Run 未完成或结束事件未到达`,
      }));
    },
  };
}

/** 供测试复用：参数脱敏副本（结构化凭据遮蔽验证）。 */
export { redactValue };
