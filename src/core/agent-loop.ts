/**
 * core/agent-loop.ts
 * AgentLoop：无状态单次 Run 执行器（纯执行器，不持有状态）。
 *
 * 语义约定（与方案 §3 一致）：
 * - prompts：本轮新增输入
 * - context：此前已经存在的历史上下文
 * - newMessages：本轮运行产生的全部新增消息（包含 prompts 本身、
 *   各轮 AssistantMessage、ToolResultMessage），由调用方（Agent）一次性写回
 *
 * 执行链：历史 Context + 本轮 Prompts → LLM → ToolCall（如有）→ Tool Execution
 * → ToolResult → 下一 Turn LLM → …… → Final AssistantMessage
 *
 * 停止策略只有两种：模型自然停止（stop / length / error）、maxTurns 用尽。
 * 不实现消息队列、shouldStopAfterTurn、prepareNextTurn、工具并行执行。
 *
 * 边界保证（审查修复 F2/F3/F6）：
 * - F2：非 toolCalls 完成时剥离残缺 toolCalls（不执行、不入历史），
 *   保证历史消息中 tool_calls 与 tool 的配对完整
 * - F3：maxTurns 耗尽时生成明确终止说明，返回文本 / 事件 / 历史三者一致
 * - F6：beforeToolCall / afterToolCall 自身异常不击穿 Run；
 *   结果处理失败时丢弃原始内容，替换为安全错误说明
 */
import type { AgentEvent } from "./events.ts";
import type {
  AgentContext,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolHooks,
  ToolOutput,
  ToolResultMessage,
  ToolSchema,
} from "./types.ts";

export interface AgentLoopConfig<C = unknown> {
  /** 本次 Run 唯一标识（由 Agent 生成，贯穿全部事件与日志）。 */
  runId: string;
  systemPrompt: string;
  tools: ToolDefinition<any, C>[];
  streamFn: StreamFn;
  hooks?: ToolHooks<C>;
  toolContext: C;
  maxTurns: number;
  emit: (e: AgentEvent) => void;
}

export interface AgentLoopResult {
  /** 本轮全部新增消息（含本轮 UserMessage），需写回 Agent 状态。 */
  newMessages: AgentMessage[];
  /** 最终 AssistantMessage 的文本。 */
  finalText: string;
  /** 本次 Run 的实际模型调用次数。 */
  modelCalls: number;
  /** 本次 Run 的实际工具调用次数。 */
  toolCalls: number;
  /** maxTurns 耗尽终止（模型持续发起工具调用直到轮次用完）。 */
  endedByMaxTurns: boolean;
}

function toToolSchema(t: ToolDefinition<any, unknown>): ToolSchema {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

function summarize(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeParse(raw: string): { ok: boolean; value: unknown } {
  const s = raw.trim();
  if (!s) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: undefined };
  }
}

export async function runAgentLoop<C>(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig<C>
): Promise<AgentLoopResult> {
  const newMessages: AgentMessage[] = [...prompts];
  // 本轮运行使用的工作消息 = 历史上下文 + 本轮 prompts（不修改调用方数组）
  const workingMessages: AgentMessage[] = [...context.messages, ...prompts];
  let finalText = "";
  // F3：区分"自然停止（含 error 停止）"与"maxTurns 耗尽"
  let endedByStop = false;
  let toolStep = 0;
  let modelCalls = 0;
  /** 上一轮模型调用时的消息数（用于计算增量）。 */
  let prevMessageCount: number | null = null;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    // ---- 1. 调用模型（StreamFn 契约：永不 reject；此处再兜一层）----
    const turnNo = turn + 1;
    const messageCount = workingMessages.length;
    const toolSchemas = config.tools.map(toToolSchema);
    config.emit({
      type: "model_call_start",
      runId: config.runId,
      turn: turnNo,
      messageCount,
      messageCountDelta: prevMessageCount === null ? messageCount : messageCount - prevMessageCount,
      hasSystemPrompt: config.systemPrompt.length > 0,
      toolSchemaCount: toolSchemas.length,
      toolSchemas,
      // 观测快照：本轮实际传给模型的 System Prompt 与完整上下文消息。
      // 浅拷贝——之后运行时对 workingMessages 的 push 不影响已发射快照；
      // 消息内容来自运行时本身，不产生额外模型调用或工具执行。
      systemPromptText: config.systemPrompt,
      contextMessages: workingMessages.map((m) => ({ ...m })),
    });
    prevMessageCount = messageCount;
    modelCalls++;
    const modelStartedAt = Date.now();
    let text = "";
    let stopReason: AssistantMessage["stopReason"] = "stop";
    let errorMessage: string | undefined;
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    const toolCallsByIndex = new Map<number, ToolCall>();

    try {
      for await (const ev of config.streamFn({
        systemPrompt: config.systemPrompt,
        messages: workingMessages,
        tools: toolSchemas,
      })) {
        switch (ev.type) {
          case "text_delta":
            text += ev.text;
            config.emit({ type: "message_delta", text: ev.text });
            break;
          case "tool_call_start":
            toolCallsByIndex.set(ev.index, {
              id: ev.toolCallId,
              name: ev.name,
              arguments: "",
            });
            break;
          case "tool_call_delta": {
            const tc = toolCallsByIndex.get(ev.index);
            if (tc) tc.arguments += ev.argumentsDelta;
            break;
          }
          case "message_end":
            stopReason = ev.stopReason;
            if (ev.errorMessage) errorMessage = ev.errorMessage;
            if (ev.usage) usage = ev.usage;
            if (ev.finishReason !== undefined) finishReason = ev.finishReason;
            break;
        }
      }
    } catch (err) {
      // StreamFn 违反契约抛出异常：同样编码为 error，不让 Run 崩溃
      stopReason = "error";
      errorMessage = `StreamFn 违反契约抛出异常：${String(err)}`;
    }
    const modelDurationMs = Date.now() - modelStartedAt;

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => tc);

    // ---- 2. 构造本轮 AssistantMessage ----
    if (stopReason === "error") {
      config.emit({
        type: "model_call_end",
        runId: config.runId,
        turn: turnNo,
        durationMs: modelDurationMs,
        stopReason: "error",
        toolCallCount: 0,
        output: { content: text, toolCalls },
        usage,
        errorMessage,
        finishReason,
      });
      const content = text
        ? `${text}\n【模型调用失败】${errorMessage ?? ""}`
        : (errorMessage ?? "模型调用失败");
      const errorAssistant: AssistantMessage = {
        role: "assistant",
        content,
        stopReason: "error",
      };
      workingMessages.push(errorAssistant);
      newMessages.push(errorAssistant);
      config.emit({ type: "assistant_message", message: errorAssistant });
      config.emit({ type: "agent_error", message: content });
      finalText = content;
      endedByStop = true;
      break;
    }

    // F2：非 toolCalls 完成时，已收到的工具调用片段不可信（参数可能被截断），
    // 不执行、不入历史——否则会出现无配对 ToolResult 的 tool_calls，
    // 序列化后的下一次请求大概率被服务端拒绝
    let effectiveToolCalls = toolCalls;
    let content = text;
    if (stopReason !== "toolCalls" && toolCalls.length > 0) {
      effectiveToolCalls = [];
      if (stopReason === "length") {
        const note = "（回复因长度限制被截断，未完成的工具调用已丢弃）";
        content = text ? `${text}${note}` : `${note.slice(1, -1)}。`;
      }
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content,
      stopReason,
      toolCalls: effectiveToolCalls.length > 0 ? effectiveToolCalls : undefined,
    };
    workingMessages.push(assistant);
    newMessages.push(assistant);
    config.emit({ type: "assistant_message", message: assistant });
    config.emit({
      type: "model_call_end",
      runId: config.runId,
      turn: turnNo,
      durationMs: modelDurationMs,
      stopReason,
      toolCallCount: effectiveToolCalls.length,
      output: { content: text, toolCalls },
      usage,
      errorMessage,
      finishReason,
    });
    finalText = content;

    // ---- 3. 停止判定：模型自然停止（stop / length）或无工具调用 ----
    if (stopReason !== "toolCalls" || effectiveToolCalls.length === 0) {
      endedByStop = true;
      break;
    }

    // ---- 4. 顺序执行工具：execute → before/after hooks → ToolResult ----
    for (const tc of toolCalls) {
      const parsed = safeParse(tc.arguments);
      const argsForEvent = parsed.ok ? parsed.value : tc.arguments;
      toolStep++;
      config.emit({
        type: "tool_execution_start",
        runId: config.runId,
        toolCallId: tc.id,
        toolName: tc.name,
        args: argsForEvent,
        turn: turnNo,
        step: toolStep,
      });

      const tool = config.tools.find((t) => t.name === tc.name);
      let outputText: string;
      let isError = false;
      let details: ToolOutput["details"] | undefined;
      let note: string | undefined;
      const toolStartedAt = Date.now();

      if (!tool) {
        outputText = `未知工具「${tc.name}」，可用工具：${config.tools
          .map((t) => t.name)
          .join("、")}`;
        isError = true;
        note = "工具未注册";
      } else if (!parsed.ok) {
        outputText = `工具「${tc.name}」的参数不是合法 JSON：${tc.arguments}`;
        isError = true;
        note = "参数解析失败";
      } else {
        // beforeToolCall（v1 业务层未实现逻辑，core 保留扩展点）
        // F6：前置校验自身异常时按"阻止"处理，绝不让未校验的调用直接执行
        let before: { block?: boolean; reason?: string } | undefined;
        try {
          before = config.hooks?.beforeToolCall?.(
            tc.name,
            parsed.value,
            config.toolContext
          );
        } catch {
          before = {
            block: true,
            reason: "前置校验执行异常，本次工具调用已被阻止",
          };
        }
        if (before?.block) {
          outputText = `工具调用被安全策略阻止：${before.reason ?? "未说明原因"}`;
          isError = true;
          note = "被安全策略阻止";
        } else {
          try {
            const out = await tool.execute(parsed.value as any, config.toolContext);
            outputText = out.output;
            isError = out.isError === true;
            details = out.details;
          } catch (err) {
            outputText = `工具「${tc.name}」执行异常：${String(err)}`;
            isError = true;
          }
        }
      }
      const toolDurationMs = Date.now() - toolStartedAt;

      // afterToolCall：ToolResult 回填模型之前执行（如 PII 脱敏管线）
      // 记录处理前文本用于观测（tool_execution_end.rawText）：
      // 工具 execute 原始结果与组装入上下文的结果需要区分。
      const rawText = outputText;
      if (config.hooks?.afterToolCall) {
        try {
          outputText = config.hooks.afterToolCall(
            tc.name,
            parsed.ok ? parsed.value : tc.arguments,
            outputText,
            config.toolContext
          );
        } catch {
          // F6：结果处理失败时丢弃原始内容（可能未经脱敏），
          // 替换为安全错误说明——未处理内容绝不流入下一轮模型请求
          outputText = "工具结果处理失败，原始内容已出于安全考虑丢弃。";
          isError = true;
          note = "结果处理失败，原始内容已丢弃";
        }
      }

      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: outputText,
        isError,
      };
      workingMessages.push(result);
      newMessages.push(result);
      config.emit({
        type: "tool_execution_end",
        runId: config.runId,
        toolCallId: tc.id,
        toolName: tc.name,
        isError,
        summary: summarize(outputText),
        turn: turnNo,
        step: toolStep,
        durationMs: toolDurationMs,
        details,
        note,
        contextText: outputText,
        // 处理前后相同时省略 rawText，避免重复保存大段文本；
        // 工具内部已裁剪的结果只能如实记录可获得的文本
        rawText: rawText !== outputText ? rawText : undefined,
      });
    }
    // 继续下一 Turn（若还有额度）
  }

  // F3：maxTurns 耗尽（模型持续发起工具调用直到轮次用完）时，
  // 生成明确终止说明写入 AssistantMessage——返回文本、事件、历史三者一致，
  // 不返回空答案
  if (!endedByStop) {
    const content = `已达最大执行轮次（${config.maxTurns} 轮），本轮未能生成最终回复，请简化问题后重试。`;
    const terminated: AssistantMessage = {
      role: "assistant",
      content,
      stopReason: "error",
    };
    workingMessages.push(terminated);
    newMessages.push(terminated);
    config.emit({ type: "assistant_message", message: terminated });
    config.emit({ type: "agent_error", message: content });
    finalText = content;
  }

  return { newMessages, finalText, modelCalls, toolCalls: toolStep, endedByMaxTurns: !endedByStop };
}
