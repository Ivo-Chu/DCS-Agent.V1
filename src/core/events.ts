/**
 * core/events.ts
 * AgentEvent 最小生命周期集 + Emitter。
 * 只保留有真实消费者（CLI）的事件，不实现 turn_start / turn_end / progress 等。
 */
import type { AssistantMessage } from "./types.ts";

export type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | { type: "message_delta"; text: string }
  | { type: "assistant_message"; message: AssistantMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
    }
  | { type: "agent_end"; finalText: string }
  | { type: "agent_error"; message: string };

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
