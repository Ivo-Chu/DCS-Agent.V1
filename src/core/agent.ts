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

    const config: AgentLoopConfig<C> = {
      systemPrompt: this.opts.systemPrompt,
      tools: this.opts.tools,
      streamFn: this.opts.streamFn,
      hooks: this.opts.hooks,
      toolContext: this.opts.toolContext,
      maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
      emit: (e) => this.emitter.emit(e),
    };

    const { newMessages, finalText } = await runAgentLoop(
      [userMessage],
      { messages: this.context },
      config
    );

    // newMessages（本轮 UserMessage + AssistantMessage + ToolResult 等）
    // 一次性合并进长期历史 context
    this.context.push(...newMessages);

    this.emitter.emit({ type: "agent_end", finalText });
    return finalText;
  }
}
