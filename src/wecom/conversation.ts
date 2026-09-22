/**
 * wecom/conversation.ts — Step 5/6：输入确认状态机 + 多员工会话隔离。
 *
 * 每个 userid 一条独立会话记录：
 * IDLE        → 收到消息 → 暂存 → 询问是否发送完毕 → COLLECTING
 * COLLECTING  → 继续收到消息 → 追加暂存 → 再次询问
 * COLLECTING  → 明确确认词（发送完毕/完毕/确认）→ 合并为完整问题 → PROCESSING
 * PROCESSING  → 收到任何新消息 → 不入 Agent、不排队 → 回复"上一问正在处理中"
 * PROCESSING  → Run 结束 → IDLE
 *
 * 空闲超过 idleMs（默认 30 分钟）→ 会话重置（清空暂存 + 丢弃 Agent 实例）。
 *
 * 本模块为纯逻辑（不 import WeCom SDK / core / dcs），动作通过
 * ConversationActions 注入，token 为不透明回复句柄（由 Channel 层解释），
 * 因此可用假动作做确定性测试。
 */

export type ConversationState = "IDLE" | "COLLECTING" | "PROCESSING";

/** 明确确认词（方案 §七：极少量、简单、可控；不做复杂意图识别）。 */
export const CONFIRM_WORDS = new Set(["发送完毕", "完毕", "确认"]);

export const CONFIRM_PROMPT =
  "问题描述发送完毕了吗？如果还有补充，请继续发送；发送完毕后请回复确认。";
export const BUSY_PROMPT = "上一问正在处理中，请稍后。";

/** 多条暂存消息的合并分隔符（方案 §七示例语义）。 */
const JOINER = "，";

export interface ConversationActions {
  /** 询问用户是否发送完毕（或继续补充）。 */
  askConfirm(token: unknown): Promise<void>;
  /** 处理中收到新消息时的提示。 */
  notifyBusy(token: unknown): Promise<void>;
  /**
   * 执行一次完整 Agent Run（含"正在查询"占位、最终回复、超时控制）。
   * Promise 结束即本轮处理完成（成功 / 失败 / 超时均算结束）。
   */
  runAgent(userId: string, question: string, token: unknown): Promise<void>;
}

interface UserRecord {
  state: ConversationState;
  buffer: string[];
  lastActive: number;
}

export interface ConversationManagerOptions {
  actions: ConversationActions;
  now?: () => number;
  /** 空闲回收阈值，默认 30 分钟。 */
  idleMs?: number;
  /** 会话重置时的回调（Channel 层用它丢弃该用户的 Agent 实例）。 */
  onReset?: (userId: string) => void;
}

export function isConfirmText(text: string): boolean {
  return CONFIRM_WORDS.has(text.trim());
}

export class ConversationManager {
  private readonly records = new Map<string, UserRecord>();
  private readonly actions: ConversationActions;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly onReset?: (userId: string) => void;

  constructor(opts: ConversationManagerOptions) {
    this.actions = opts.actions;
    this.now = opts.now ?? (() => Date.now());
    this.idleMs = opts.idleMs ?? 30 * 60 * 1000;
    this.onReset = opts.onReset;
  }

  /** 处理一条来自某用户的文本消息（token = 该消息的回复句柄）。 */
  async handle(userId: string, text: string, token: unknown): Promise<void> {
    if (!userId) return;
    const now = this.now();
    let rec = this.getRecord(userId);

    // 空闲回收：超过阈值 → 重置（含丢弃 Agent 实例）；处理中不受影响（Run 有自己的超时）
    if (rec.state !== "PROCESSING" && now - rec.lastActive > this.idleMs) {
      this.reset(userId);
      rec = this.getRecord(userId); // 重置后取新记录，避免写入已被删除的孤儿记录
    }
    rec.lastActive = now;

    // 处理中：任何新消息不进入 Agent、不排队
    if (rec.state === "PROCESSING") {
      await this.actions.notifyBusy(token);
      return;
    }

    // 确认发送完毕：合并暂存 → 完整问题 → Agent Run
    if (rec.state === "COLLECTING" && isConfirmText(text)) {
      const question = rec.buffer.join(JOINER);
      rec.buffer = [];
      rec.state = "PROCESSING";
      try {
        await this.actions.runAgent(userId, question, token);
      } finally {
        const r = this.records.get(userId);
        if (r && r.state === "PROCESSING") {
          r.state = "IDLE";
          r.lastActive = this.now();
        }
      }
      return;
    }

    if (rec.state === "IDLE") {
      rec.state = "COLLECTING";
      rec.buffer = [text];
      await this.actions.askConfirm(token);
      return;
    }

    // COLLECTING：继续暂存追加
    rec.buffer.push(text);
    await this.actions.askConfirm(token);
  }

  /** 当前状态（测试 / 观测用）。 */
  stateOf(userId: string): ConversationState | null {
    return this.records.get(userId)?.state ?? null;
  }

  /** 当前暂存内容（测试 / 观测用）。 */
  bufferOf(userId: string): string[] {
    return [...(this.records.get(userId)?.buffer ?? [])];
  }

  /** 重置某用户会话（清空暂存、回 IDLE，并通知 Channel 丢弃 Agent 实例）。 */
  reset(userId: string): void {
    this.records.delete(userId);
    this.onReset?.(userId);
  }

  private getRecord(userId: string): UserRecord {
    let rec = this.records.get(userId);
    if (!rec) {
      rec = { state: "IDLE", buffer: [], lastActive: this.now() };
      this.records.set(userId, rec);
    }
    return rec;
  }
}
