/**
 * wecom/agent-runner.ts — Step 8：完整超时控制。
 *
 * 每次 Run 生成唯一 runId 与独立 AbortController：
 * - 开始后立即发送"正在查询，请稍候。"（流式占位，finish=false）
 * - 超时（默认 90s）：Abort 当前及后续模型请求（signal 保持 aborted，
 *   旧 Run 无法再发起新的模型请求）→ 废弃可能被污染的 Agent 实例
 *   → 发送受控超时提示（finish=true）→ Promise 结束（会话回 IDLE）
 * - 迟到结果：Run 已结束后 model resolve 的结果直接丢弃，绝不发送
 * - 成功：最终回复 finish=true
 *
 * 员工可见输出只有占位语 / 最终回复 / 超时提示 / 失败提示，
 * 不含思考过程、Tool 参数、ToolResult、内部异常、源码路径、Stack Trace。
 *
 * 本模块不 import WeCom SDK / dcs，全部依赖注入，可确定性测试。
 */
import { randomUUID } from "node:crypto";

/** 每用户的 Agent 及其取消信号持有器（Agent 由 Channel 层创建）。 */
export interface UserAgentSlot {
  /** 现有 Agent 实例（类型放宽，避免本模块依赖 core）。 */
  agent: { prompt(question: string): Promise<string> };
  /** 当前 Run 的取消控制器；每次 Run 开始时替换。 */
  controller: AbortController;
}

export interface AgentRunnerDeps {
  /** 获取（或创建）某用户的 Agent 槽位。 */
  getSlot(userId: string): UserAgentSlot;
  /** 丢弃某用户的 Agent 实例（会话隔离回收 / 超时防污染）。 */
  discardAgent(userId: string): void;
  /** 流式回复：finish=false 为占位/更新，finish=true 结束。 */
  replyStream(token: unknown, streamId: string, content: string, finish: boolean): Promise<void>;
  /** 生成流式消息 ID。 */
  newStreamId(): string;
  /** 总处理时间预算（毫秒），默认 90 秒。 */
  budgetMs?: number;
  /** 定时器注入（测试用），默认 setTimeout。 */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export const PROCESSING_PLACEHOLDER = "正在查询，请稍候。";
export const TIMEOUT_REPLY = "这次查询超时，请稍后重试。";
export const RUN_ERROR_REPLY = "处理出现问题，请稍后重试。";
export const EMPTY_REPLY = "这次查询未能生成回复，请稍后重试。";

export class AgentRunner {
  private readonly deps: Required<Pick<AgentRunnerDeps, "getSlot" | "discardAgent" | "replyStream" | "newStreamId">> &
    Pick<AgentRunnerDeps, "budgetMs" | "schedule">;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
  }

  /**
   * 执行一次完整 Run。Promise 结束 = 本轮处理完成（成功/失败/超时）。
   * runId 用于阻止迟到结果进入有效回复链。
   */
  run(userId: string, question: string, token: unknown): Promise<void> {
    const runId = randomUUID();
    const budgetMs = this.deps.budgetMs ?? 90_000;
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

    return new Promise<void>((resolve) => {
      let finished = false;
      let cancelTimer: (() => void) | null = null;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        cancelTimer?.();
        resolve();
      };

      void (async () => {
        const slot = this.deps.getSlot(userId);
        // 新 Run 新控制器：旧 Run 的 aborted signal 不会影响新 Run
        slot.controller = new AbortController();
        const streamId = this.deps.newStreamId();

        try {
          await this.deps.replyStream(token, streamId, PROCESSING_PLACEHOLDER, false);
        } catch {
          // 占位失败不阻断主流程（最终回复仍尝试发送）
        }

        cancelTimer = schedule(() => {
          if (finished) return;
          // 超时：Abort 模型请求（含旧 Run 后续请求）→ 废弃 Agent → 超时提示 → 结束
          slot.controller.abort();
          this.deps.discardAgent(userId);
          finish();
          void this.deps
            .replyStream(token, streamId, TIMEOUT_REPLY, true)
            .catch(() => undefined);
        }, budgetMs);

        try {
          const answer = await slot.agent.prompt(question);
          if (finished) return; // 迟到结果：Run 已结束（超时），直接丢弃
          const content = answer.trim().length > 0 ? answer : EMPTY_REPLY;
          finish();
          void this.deps.replyStream(token, streamId, content, true).catch(() => undefined);
        } catch {
          if (finished) return;
          finish();
          void this.deps.replyStream(token, streamId, RUN_ERROR_REPLY, true).catch(() => undefined);
        }
      })();
      void runId; // runId 语义由 finished 标志实现（同 Run 内闭环）
    });
  }
}
