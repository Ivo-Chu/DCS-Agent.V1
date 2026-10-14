/**
 * core/model/openai-compatible.ts
 * OpenAI 兼容客户端（OpenAI 兼容接口，SSE 流式）。
 *
 * v1 契约（与方案 §4 一致）：
 * StreamFn 永不抛异常、永不 reject；
 * API / 网络 / SSE / 鉴权等一切失败统一编码为 stopReason:"error" 的
 * AssistantMessage（由 AgentLoop 负责），错误说明放在 message_end.errorMessage。
 *
 * AgentMessage → OpenAI messages 的转换只发生在此处（LLM 调用边界）。
 */
import type {
  AgentMessage,
  ModelStreamEvent,
  StreamFn,
  TokenUsage,
  ToolSchema,
} from "../types.ts";

export interface OpenAiStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * 每次模型调用的取消信号提供者（超时控制用）。
   * 每次调用时求值；返回的 signal 一旦 aborted，
   * 该 signal 上的后续请求也会立即中止——可用于阻止旧 Run 发起新模型请求。
   * 不改变 StreamFn 对外契约（core 接口零改动）。
   */
  signalProvider?: () => AbortSignal | undefined;
}

export const DEFAULT_OPENAI_MODEL = "Qwen3.5-35B";

interface OpenAiToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

function toOpenAiMessages(
  systemPrompt: string,
  messages: AgentMessage[]
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: OpenAiMessage = {
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      out.push(msg);
    } else {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  return out;
}

function mapFinishReason(reason: string | null | undefined): "stop" | "length" | "toolCalls" {
  if (reason === "tool_calls" || reason === "function_call") return "toolCalls";
  if (reason === "length") return "length";
  return "stop";
}

/** 从 OpenAI 兼容 usage 对象提取 Token 用量（未提供的字段不填，不估算）。 */
function parseUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const input = num(u.prompt_tokens);
  const output = num(u.completion_tokens);
  // 缓存字段：OpenAI prompt_tokens_details.cached_tokens / 部分厂商 cache_read_input_tokens
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheRead = num(details?.cached_tokens) ?? num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

export function createOpenAiStreamFn(options: OpenAiStreamOptions = {}): StreamFn {
  const apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "";
  const baseUrl =
    options.baseUrl ?? process.env.LLM_BASE_URL ?? "";
  const model = options.model ?? process.env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL;

  const stream: StreamFn = async function* (req): AsyncGenerator<ModelStreamEvent> {
    if (!apiKey || !baseUrl) {
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: `模型调用失败：未配置 ${!apiKey ? "LLM_API_KEY" : "LLM_BASE_URL"}`,
        usage: undefined,
      };
      return;
    }

    const body: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(req.systemPrompt, req.messages),
      stream: true,
      // 请求 Provider 在流式响应中返回 token usage（OpenAI 兼容扩展；
      // 目标网关兼容性需单独验证，不为采集 Usage 额外重试请求）
      stream_options: { include_usage: true },
    };
    if (model === "Qwen3.5-35B") {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    if (req.tools.length > 0) {
      body.tool_choice = "auto";
      body.tools = req.tools.map((t: ToolSchema) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    // 每次调用求值（超时 abort 后 signal 保持 aborted，
    // 旧 Run 的后续模型请求会立即中止）
    const signal = options.signalProvider?.();

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: `模型调用失败（${signal?.aborted ? "已取消" : "网络错误"}）：${String(err)}`,
      };
      return;
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        detail = "<无响应体>";
      }
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: `模型调用失败（HTTP ${response.status}）：${detail}`,
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: "模型调用失败：响应无内容流",
      };
      return;
    }

    // ---- SSE 解析 ----
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | null | undefined = undefined;
    let usage: TokenUsage | undefined;
    // F1（审查修复）：损坏的数据帧不得静默跳过；心跳/注释/空行仍可忽略
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          // SSE 注释（": keepalive"）与非 data 行可忽略
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let json: {
            choices?: {
              delta?: {
                content?: string | null;
                tool_calls?: OpenAiToolCall[];
              };
              finish_reason?: string | null;
            }[];
            error?: { message?: string };
            usage?: unknown;
          };
          try {
            json = JSON.parse(payload);
          } catch {
            // 损坏的数据帧：数据完整性已不可信，按 §4 契约编码为 error。
            // R5（审查修复）：立即产出错误并结束——不等待下一块数据（对端
            // 可能保持连接不再发送，旧实现会永远卡在额外一次流读取上）
            yield {
              type: "message_end",
              stopReason: "error",
              errorMessage: "模型调用失败（SSE 数据帧损坏）",
            };
            return;
          }
          if (json.error?.message) {
            yield {
              type: "message_end",
              stopReason: "error",
              errorMessage: `模型调用失败（API 错误）：${json.error.message}`,
            };
            return;
          }
          // 流式 usage：部分 Provider 仅在最后一块返回 usage（choices 为空）
          const parsedUsage = parseUsage(json.usage);
          if (parsedUsage) usage = parsedUsage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            yield { type: "text_delta", text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (tc.id || tc.function?.name) {
                yield {
                  type: "tool_call_start",
                  index,
                  toolCallId: tc.id ?? `call_${index}`,
                  name: tc.function?.name ?? "",
                };
              }
              if (tc.function?.arguments) {
                yield {
                  type: "tool_call_delta",
                  index,
                  argumentsDelta: tc.function.arguments,
                };
              }
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      }
    } catch (err) {
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: `模型调用失败（流中断）：${String(err)}`,
      };
      return;
    }

    if (finishReason == null) {
      // F1（审查修复）：EOF 但从未收到合法完成标志——流被提前截断，
      // 不能通过 mapFinishReason(undefined) 误判为正常 stop
      yield {
        type: "message_end",
        stopReason: "error",
        errorMessage: "模型调用失败（SSE 流提前结束：未收到完成标志）",
      };
      return;
    }
    yield { type: "message_end", stopReason: mapFinishReason(finishReason), usage, finishReason: finishReason ?? undefined };
  };
  return Object.assign(stream, {
    observability: Object.freeze({ model, provider: "openai-compatible" }),
  });
}
