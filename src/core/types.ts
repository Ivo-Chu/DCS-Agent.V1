/**
 * core/types.ts
 * 通用 Agent Runtime 类型定义。
 * 零业务依赖：本文件不出现任何业务身份或业务概念（DCS / 企微 / 工号等一概不出现）。
 */

/** 宽松的 JSON Schema 表示，原样传给 LLM。 */
export type JsonSchema = Record<string, unknown>;

/** 工具执行结果。 */
export interface ToolOutput {
  /** 返回给模型的文本结果（写入消息前会经过 afterToolCall 处理）。 */
  output: string;
  /** 是否为错误结果。 */
  isError?: boolean;
}

/** 模型发起的一次工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 参数字符串（来自模型流式输出，未解析）。 */
  arguments: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  stopReason: "stop" | "length" | "toolCalls" | "error";
  /** 本轮模型请求的工具调用（如有）。 */
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  /** 已经过 afterToolCall 处理（如 PII 脱敏）的结果文本。 */
  content: string;
  isError: boolean;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** 历史上下文（Agent 持有，AgentLoop 只读）。 */
export interface AgentContext {
  messages: AgentMessage[];
}

/**
 * 通用工具定义。
 * 泛型 C 携带调用方上下文（例如 DCS 层的 DcsToolContext），
 * core 不知道、也不需要知道 C 的具体内容。
 */
export interface ToolDefinition<P = unknown, C = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  execute(args: P, ctx: C): Promise<ToolOutput>;
}

/** 传给 StreamFn 的工具 schema（已剥离 execute 与 ctx）。 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** 通用 Tool Hook 扩展点。 */
export interface ToolHooks<C = unknown> {
  beforeToolCall?(
    toolName: string,
    args: unknown,
    ctx: C
  ): { block?: boolean; reason?: string };
  afterToolCall?(
    toolName: string,
    args: unknown,
    resultText: string,
    ctx: C
  ): string;
}

/** 模型流式事件（StreamFn 的产出）。 */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; toolCallId: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | {
      type: "message_end";
      stopReason: AssistantMessage["stopReason"];
      /** stopReason 为 "error" 时的错误说明。 */
      errorMessage?: string;
    };

/**
 * 模型调用抽象。
 * v1 契约：永不抛异常、永不 reject；
 * API / 网络 / SSE 等失败统一编码为 stopReason:"error"。
 */
export type StreamFn = (req: {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
}) => AsyncGenerator<ModelStreamEvent>;
