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
  /**
   * 可选结构化观测细节（仅用于日志/诊断，不进入模型上下文）。
   * 数值必须来自工具真实执行结果；字段全部可选，不知道就不填。
   * 不得包含敏感明文（员工记录、凭据、完整源码等）。
   */
  details?: ToolExecutionDetails;
}

/** 工具执行的结构化观测细节（可选，工具自行上报，全部字段可缺省）。 */
export interface ToolExecutionDetails {
  /** 数据库工具：返回行数（0 行是正常结果，不是失败）。 */
  rowCount?: number;
  /** 数据库工具：返回字段名。 */
  columns?: string[];
  /** 数据库工具：结果是否被截断。 */
  truncated?: boolean;
  /** 数据库工具：SQL 错误码（如 ORA-00904）。 */
  errorCode?: string;
  /** 源码调查工具：扫描文件数。 */
  scannedFiles?: number;
  /** 源码调查工具：命中数量。 */
  hitCount?: number;
  /** 源码调查工具：是否达到单次命中上限。 */
  hitLimitReached?: boolean;
  /** 知识库工具：返回片段数量。 */
  chunkCount?: number;
  /** 空结果标记（查询成功但 0 行 / 无命中）。 */
  empty?: boolean;
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

export type ToolChoice = "auto" | "required";
export interface RunFinish { text: string; reason: string }
/** 单次 Run 的调用/结束扩展点；业务状态由调用方创建，不存入 Agent。 */
export interface RunPolicy {
  bufferText?: boolean;
  systemPromptSuffix?: string;
  prepareTurn?(turn: number): { toolNames?: string[]; toolChoice?: ToolChoice; finish?: RunFinish };
  onToolResult?(call: ToolCall, result: ToolResultMessage): void;
  checkFinish?(info: { turn: number; remainingTurns: number }): { retry: string } | { finish: RunFinish } | undefined;
  afterTools?(): RunFinish | undefined;
  snapshot?(): Record<string, unknown>;
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
      /** Provider 返回的真实 Token 用量（未提供时缺省，不得估算冒充）。 */
      usage?: TokenUsage;
      /**
       * Provider 原始 finish_reason（可选观测元数据）。
       * 与归一化的 stopReason 分开保留——调试需要区分
       * content_filter / stop 等原始原因；不影响停止策略。
       */
      finishReason?: string;
    };

/**
 * 模型 Token 用量（来自 Provider 真实返回，未提供的字段为 undefined/不填）。
 * 语义约定：cacheReadTokens / cacheWriteTokens 是否已包含在 inputTokens 内
 * 由 Provider 定义；统计层不得再相加造成重复计数。
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * 模型调用抽象。
 * v1 契约：永不抛异常、永不 reject；
 * API / 网络 / SSE 等失败统一编码为 stopReason:"error"。
 */
export type StreamFn = ((req: {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
  toolChoice?: ToolChoice;
}) => AsyncGenerator<ModelStreamEvent>) & {
  /** Provider 创建时确定的观测信息；自定义实现未提供时保持未知。 */
  readonly observability?: Readonly<{ model: string; provider: string }>;
};
