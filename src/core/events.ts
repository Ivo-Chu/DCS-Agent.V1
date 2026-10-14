/**
 * core/events.ts
 * AgentEvent 生命周期事件集 + Emitter。
 *
 * 2026-10-12 日志系统改造：新增 run_start / model_call_start / model_call_end /
 * run_end 四类事件，tool_execution_* 增加 turn/step/durationMs/details 字段。
 * 原 7 个事件保持字段与语义不变（CLI / Web / 企微现有消费者无需修改）；
 * 新事件的唯一消费者是 observability 层（终端日志 + JSONL），不产生额外
 * 模型调用或工具执行。
 */
import type { AssistantMessage, TokenUsage, ToolExecutionDetails } from "./types.ts";

/**
 * 上下文消息快照（observability 专用，model_call_start 携带）。
 * 与 AgentMessage 同形但字段全部可选——快照只用于日志展示，
 * 不回流运行时，缺省字段不影响业务。
 */
export interface ContextMessageSnapshot {
  role: "user" | "assistant" | "toolResult";
  content: string;
  stopReason?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | {
      /** Run 开始（observability 专用；runId 贯穿本次 Run 全部事件）。 */
      type: "run_start";
      runId: string;
      startedAt: string;
      /**
       * 可选观测元数据：实际使用的模型名（由 Agent 组装方统一从
       * Provider 配置获取，通道不再各自读环境变量猜测）。
       */
      model?: string;
      /** 可选观测元数据：模型服务提供方标识（不含凭据与服务地址）。 */
      provider?: string;
    }
  | { type: "message_delta"; text: string }
  | { type: "assistant_message"; message: AssistantMessage }
  | {
      /** 一次真实模型调用开始（turn 为 1-based 轮次）。 */
      type: "model_call_start";
      runId: string;
      turn: number;
      /** 本轮传给模型的消息数量（不含 System Prompt）。 */
      messageCount: number;
      /** 相比上一轮模型调用增加的消息数（第一轮为总消息数）。 */
      messageCountDelta: number;
      /** System Prompt 是否存在。 */
      hasSystemPrompt: boolean;
      /** 本轮提供的 Tool Schema 数量。 */
      toolSchemaCount: number;
      /**
       * 可选观测字段：本轮实际传给模型的 System Prompt 文本。
       * 仅用于开发者日志（DEBUG 终端 / JSONL）；不含凭据。
       * 未提供时（旧调用方 / FakeAgent）日志如实显示不可用。
       */
      systemPromptText?: string;
      /**
       * 可选观测字段：本轮实际传给模型的完整上下文消息快照
       * （历史上下文 + 本轮 prompts + 之前各轮 assistant/toolResult）。
       * 仅用于开发者日志；快照在发射时浅拷贝，之后运行时的变化不影响日志。
       */
      contextMessages?: ContextMessageSnapshot[];
    }
  | {
      /** 一次真实模型调用结束（含失败；durationMs 为真实耗时）。 */
      type: "model_call_end";
      runId: string;
      turn: number;
      durationMs: number;
      stopReason: AssistantMessage["stopReason"];
      /** 本轮产生的 Tool Call 数量。 */
      toolCallCount: number;
      /** Provider 返回的真实 Token 用量（未提供则缺省，不得估算）。 */
      usage?: TokenUsage;
      /** stopReason 为 "error" 时的错误说明。 */
      errorMessage?: string;
      /** Provider 原始 finish_reason（可选观测元数据，与归一化 stopReason 分开）。 */
      finishReason?: string;
    }
  | {
      type: "tool_execution_start";
      runId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** 所属模型轮次（1-based）。 */
      turn: number;
      /** 整个 Run 内的工具调用编号（1-based，跨轮连续）。 */
      step: number;
    }
  | {
      type: "tool_execution_end";
      runId: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
      turn: number;
      step: number;
      /** 工具真实执行耗时（execute 本体，不含 afterToolCall）。 */
      durationMs: number;
      /** 工具上报的结构化细节（可选；已过滤敏感内容）。 */
      details?: ToolExecutionDetails;
      /** 工具内部转换/截断说明（可选，如 guard 拒绝、结果截断）。 */
      note?: string;
      /**
       * 组装入上下文的完整结果文本（afterToolCall 处理后，与写入消息的
       * content 一致）。供 DEBUG/JSONL 复盘；NORMAL 终端仍用 summary 摘要。
       * 注意：这是"组装入上下文"的结果——最后一轮工具结果可能没有后续
       * 模型调用，不能声称已实际发送给模型。
       */
      contextText?: string;
      /**
       * 工具 execute 的原始结果文本（afterToolCall 处理前）。
       * 仅当处理改变了内容时提供（与 contextText 相同时省略，
       * 避免重复保存大段文本）；工具内部已裁剪的结果只能如实记录
       * 可获得的文本，不虚构裁剪前内容。
       */
      rawText?: string;
    }
  | { type: "agent_end"; finalText: string }
  | { type: "agent_error"; message: string }
  | {
      /** Run 结束（所有路径均保证发射：正常 / maxTurns / 模型失败 / 异常）。 */
      type: "run_end";
      runId: string;
      status: "completed" | "failed";
      /**
       * 结束原因：
       * completed      模型自然停止（stop/length）
       * max_turns      达到最大执行轮次
       * model_error    模型接口失败
       * unexpected     其他异常（防御性兜底）
       */
      reason: "completed" | "max_turns" | "model_error" | "unexpected";
      elapsedMs: number;
      modelCalls: number;
      toolCalls: number;
    };

export type AgentEventFn = (e: AgentEvent) => void;

/** 极简同步事件发射器：单个消费者异常不阻断事件流。 */
export class Emitter {
  private listeners = new Set<AgentEventFn>();

  subscribe(fn: AgentEventFn): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(e: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // 消费者自身异常不应影响 Agent 主流程
      }
    }
  }
}
