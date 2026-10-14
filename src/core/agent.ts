/**
 * core/agent.ts
 * Agent：有状态外层对象。
 *
 * 职责（与方案 §3 一致）：
 * - 持有历史 context / systemPrompt / tools / toolContext / hooks / streamFn / maxTurns
 * - 提供 subscribe()
 * - 提供 prompt()
 *
 * Agent 本身不实现 LLM → Tool → LLM 循环（那是 AgentLoop 的职责）。
 *
 * prompt() 的消息所有权：
 * 1. 创建本轮 UserMessage，作为 prompts 传给 AgentLoop
 * 2. 将已有历史消息作为 context 传给 AgentLoop
 * 3. AgentLoop 执行完整循环，返回本轮全部 newMessages
 * 4. Agent 将 newMessages 一次性合并进自己的历史 context
 * 5. Agent 返回最终 AssistantMessage 的文本
 */
import { Emitter, type AgentEvent } from "./events.ts";
import { runAgentLoop, type AgentLoopConfig } from "./agent-loop.ts";
import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  StreamFn,
  ToolDefinition,
  ToolHooks,
  UserMessage,
} from "./types.ts";

const DEFAULT_MAX_TURNS = 8;

export interface AgentOptions<C = unknown> {
  systemPrompt: string;
  tools: ToolDefinition<any, C>[];
  streamFn: StreamFn;
  toolContext: C;
  hooks?: ToolHooks<C>;
  maxTurns?: number;
  /**
   * 可选 runId 生成器（测试注入用；默认 randomUUID().slice(0,8)）。
   * 完整 UUID 过长不利于日志文件名与终端显示，取前 8 位（同 Run 内唯一性足够，
   * 文件名另含时间戳；并发 Run 冲突概率可忽略）。
   */
  runIdFactory?: () => string;
}

export class Agent<C = unknown> {
  private readonly emitter = new Emitter();
  private readonly opts: AgentOptions<C>;

  /** 长期历史上下文（由 prompt() 写回维护）。 */
  readonly context: AgentMessage[] = [];

  constructor(opts: AgentOptions<C>) {
    this.opts = opts;
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    return this.emitter.subscribe(fn);
  }

  async prompt(text: string): Promise<string> {
    const userMessage: UserMessage = { role: "user", content: text };
    this.emitter.emit({ type: "agent_start", prompt: text });

    const runId = (this.opts.runIdFactory?.() ?? randomUUID().slice(0, 8));
    const startedAt = Date.now();
    const modelInfo = this.opts.streamFn.observability;
    this.emitter.emit({
      type: "run_start",
      runId,
      startedAt: new Date(startedAt).toISOString(),
      model: modelInfo?.model,
      provider: modelInfo?.provider,
    });

    const config: AgentLoopConfig<C> = {
      runId,
      systemPrompt: this.opts.systemPrompt,
      tools: this.opts.tools,
      streamFn: this.opts.streamFn,
      hooks: this.opts.hooks,
      toolContext: this.opts.toolContext,
      maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
      emit: (e) => this.emitter.emit(e),
    };

    let result;
    try {
      result = await runAgentLoop([userMessage], { messages: this.context }, config);
    } catch (err) {
      // 防御性兜底（F6 后 prompt 不应再 reject）：run_end 必须发射，异常原样上抛
      this.emitter.emit({
        type: "run_end",
        runId,
        status: "failed",
        reason: "unexpected",
        elapsedMs: Date.now() - startedAt,
        modelCalls: 0,
        toolCalls: 0,
      });
      throw err;
    }
    const { newMessages, finalText, modelCalls, toolCalls, endedByMaxTurns } = result;

    // newMessages（本轮 UserMessage + AssistantMessage + ToolResult 等）
    // 一次性合并进长期历史 context
    this.context.push(...newMessages);

    // 结束原因：maxTurns 耗尽 / 模型失败 / 正常完成
    const lastAssistant = [...newMessages].reverse().find((m) => m.role === "assistant");
    const stopReason = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
    const reason = endedByMaxTurns ? "max_turns" : stopReason === "error" ? "model_error" : "completed";
    this.emitter.emit({
      type: "run_end",
      runId,
      status: reason === "completed" ? "completed" : "failed",
      reason,
      elapsedMs: Date.now() - startedAt,
      modelCalls,
      toolCalls,
    });
    this.emitter.emit({ type: "agent_end", finalText });
    return finalText;
  }
}
