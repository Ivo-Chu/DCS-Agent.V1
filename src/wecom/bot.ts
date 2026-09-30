/**
 * wecom/bot.ts — 企业微信智能机器人正式入口（Step 4 全链路）。
 *
 * 链路：真实企微消息 → 真实 userid → DCS Identity（当前为 TEST DATA）
 * → 输入确认状态机 → Existing Agent Runtime → DCS Tools → Final Answer
 * → 企微流式回复。
 *
 * 分层铁律（方案 §二）：WeCom 是 Channel/Adapter，不把企微概念写进
 * Agent Runtime / core；Agent 组装只使用既有工厂（session/prompt/tools/hooks）。
 *
 * 环境变量：
 *   WECOM_BOT_ID / WECOM_BOT_SECRET  机器人长连接凭据
 *   DEEPSEEK_API_KEY                  模型密钥
 *   WECOM_RUN_BUDGET_MS               Agent 处理预算（默认 90000）
 *   DCS_IDENTITY_FILE                 身份映射文件（默认 ./identity.json）
 *
 * 运行：npm run wecom:bot
 */
import AiBot, { generateReqId } from "@wecom/aibot-node-sdk";
import type { TextMessage, WsFrame } from "@wecom/aibot-node-sdk";
import { createDcsAgent, type DcsAgentHolder } from "../dcs/agent-factory.ts";
import { loadEnvLocal } from "../dcs/env-local.ts";

loadEnvLocal();
import { resolveIdentityAsync, type DcsIdentity } from "../dcs/identity.ts";
import { createSession } from "../dcs/session.ts";
import { closeDbClient } from "../dcs/db/client.ts";
import { AgentRunner, type UserAgentSlot } from "./agent-runner.ts";
import { BUSY_PROMPT, ConversationManager } from "./conversation.ts";
import { MsgIdDedup } from "./dedup.ts";

const UNKNOWN_IDENTITY_REPLY =
  "暂时无法识别您的 DCS 员工身份，请联系管理员。";
const GROUP_CHAT_REPLY = "暂时仅支持单聊咨询，请在单聊中与我对话。";

/**
 * 工具调用参数摘要（单行化 + 截断），用于测试期观测日志。
 * 只进本地控制台，不进入员工可见的企微回复。
 */
function summarizeToolArgs(args: unknown): string {
  const s = JSON.stringify(args) ?? "";
  const collapsed = s.replace(/\s+/g, " ");
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

interface UserAgentEntry extends UserAgentSlot {
  /** 每 Run 统计（方案 v2 §9：观察真实 Case 的 Loop 深度，非生产观测系统）。 */
  stats: { turns: number; toolCalls: number };
}

/**
 * 消息入口已解析的身份（两级链路：identity.json 覆盖 → S2_Employee 数据库）。
 * getSlot 为同步接口（AgentRunner 契约），异步解析结果在此暂存。
 */
const resolvedIdentities = new Map<string, DcsIdentity>();

async function main(): Promise<void> {
  const botId = process.env.WECOM_BOT_ID ?? "";
  const secret = process.env.WECOM_BOT_SECRET ?? "";
  if (!botId || !secret) {
    console.error("未设置 WECOM_BOT_ID / WECOM_BOT_SECRET，无法启动。");
    console.error('PowerShell：$env:WECOM_BOT_ID = "xxxx"；$env:WECOM_BOT_SECRET = "xxxx"');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("未设置 DEEPSEEK_API_KEY，无法启动。");
    console.error('PowerShell：$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"');
    process.exit(1);
  }

  const budgetMs = Number(process.env.WECOM_RUN_BUDGET_MS ?? 90_000);
  const client = new AiBot.WSClient({ botId, secret });
  const dedup = new MsgIdDedup();

  // ---- 按 userid 的 Agent 实例管理（Step 6：会话隔离 / 回收 / 超时废弃）----
  const agents = new Map<string, UserAgentEntry>();

  function getSlot(userId: string): UserAgentSlot {
    let entry = agents.get(userId);
    if (!entry) {
      const identity = resolvedIdentities.get(userId);
      if (!identity) {
        // bot 入口已在消息层做过身份校验，这里理论上不可达；防御性兜底
        throw new Error(`未登记用户 ${userId}`);
      }
      // holder 是可变对象，工厂组装的 streamFn 与 AgentRunner 替换/abort 的
      // 是同一个 holder——超时取消能真正到达模型请求（2026-09-28 修复：
      // 旧实现复制 controller 初始值，替换 entry 后取消信号失效）
      const holder: DcsAgentHolder = { controller: new AbortController() };
      const stats = { turns: 0, toolCalls: 0 };
      const session = createSession(identity, userId);
      const agent = createDcsAgent({ session, holder });
      // 简单统计：每轮 AssistantMessage 计 1 turn，每次工具完成计 1 toolCall
      // 工具级观测日志（2026-09-24 方案C）：→ 打印调用的工具与参数（SQL 等），
      // ← 打印耗时与结果摘要——区分"没查对表"与"真没有数据"全靠它
      const toolTimings = new Map<string, number>();
      agent.subscribe((e) => {
        if (e.type === "assistant_message") stats.turns++;
        else if (e.type === "tool_execution_start") {
          toolTimings.set(e.toolCallId, Date.now());
          console.log(`[tool] → ${e.toolName} ${summarizeToolArgs(e.args)}`);
        } else if (e.type === "tool_execution_end") {
          stats.toolCalls++;
          const startedAt = toolTimings.get(e.toolCallId);
          toolTimings.delete(e.toolCallId);
          const ms = startedAt !== undefined ? Date.now() - startedAt : -1;
          console.log(`[tool] ← ${e.toolName}（${ms}ms${e.isError ? "，出错" : ""}）：${e.summary}`);
        }
      });
      entry = { agent, holder, stats };
      agents.set(userId, entry);
      console.log(
        `[bot] 已为用户 ${userId} 创建 Agent（${identity.name}/${identity.employeeNo}` +
          `${identity.department ? `，${identity.department}` : ""}）`
      );
    }
    return entry;
  }

  function discardAgent(userId: string): void {
    if (agents.delete(userId)) {
      console.log(`[bot] 已废弃用户 ${userId} 的 Agent 实例`);
    }
  }

  // ---- 流式回复（token = 触发消息的 frame）----
  async function replyText(token: unknown, content: string): Promise<void> {
    const frame = token as WsFrame<TextMessage>;
    await client.replyStream(frame, generateReqId("stream"), content, true);
  }

  const runner = new AgentRunner({
    getSlot,
    discardAgent,
    replyStream: async (token, streamId, content, finish) => {
      await client.replyStream(token as WsFrame<TextMessage>, streamId, content, finish);
    },
    newStreamId: () => generateReqId("stream"),
    budgetMs,
  });

  // ---- 会话状态机（Step 5/6）----
  const manager = new ConversationManager({
    actions: {
      notifyBusy: (token) => replyText(token, BUSY_PROMPT),
      runAgent: async (userId, question, token) => {
        // 方案 v2 §9：每 Run 记录 turns / toolCalls（简单日志，Run 结束打印）
        let stats: { turns: number; toolCalls: number } | null = null;
        try {
          getSlot(userId); // 确保已创建（防御性兜底会抛错，交由 runner.run 处理）
          const entry = agents.get(userId);
          if (entry) {
            stats = entry.stats;
            stats.turns = 0;
            stats.toolCalls = 0;
          }
        } catch {
          // getSlot 失败交由 runner.run 统一处理
        }
        try {
          await runner.run(userId, question, token);
        } finally {
          if (stats) {
            console.log(`[bot] run 统计 userid=${userId} turns=${stats.turns} toolCalls=${stats.toolCalls}`);
          }
        }
      },
    },
    onReset: discardAgent,
  });

  // ---- 消息入口 ----
  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const body = frame.body;
    if (!body) return;
    const msgid = body.msgid;
    const userid = body.from?.userid ?? "";
    const content = body.text?.content ?? "";
    console.log(`[bot] 收到消息 msgid=${msgid} userid=${userid} chattype=${body.chattype} text="${content}"`);

    // Step 7：msgid 去重（重复到达直接忽略，不执行任何业务逻辑）
    if (dedup.seenBefore(msgid)) {
      console.log(`[bot] 重复 msgid=${msgid}，已忽略`);
      return;
    }

    // 群聊不支持（v1 范围外）
    if (body.chattype === "group") {
      await replyText(frame, GROUP_CHAT_REPLY).catch((e) => console.error(`[bot] 回复失败：${String(e)}`));
      return;
    }

    // 身份解析（两级链路：identity.json 覆盖 → S2_Employee 数据库）：
    // 未识别 → 中性拒答（不默认映射、不进入 Agent）
    const identity = await resolveIdentityAsync(userid);
    if (!identity) {
      console.log(`[bot] 未识别用户 ${userid}，拒答`);
      await replyText(frame, UNKNOWN_IDENTITY_REPLY).catch((e) => console.error(`[bot] 回复失败：${String(e)}`));
      return;
    }
    resolvedIdentities.set(userid, identity);

    // 空文本（理论上不会出现）忽略
    if (content.trim().length === 0) return;

    try {
      await manager.handle(userid, content.trim(), frame);
    } catch (err) {
      // getSlot 防御性兜底等意外错误：中性提示，不泄漏内部细节
      console.error(`[bot] 会话处理异常：${String(err)}`);
      await replyText(frame, "处理出现问题，请稍后重试。").catch(() => undefined);
    }
  });

  client.on("authenticated", () => {
    console.log("[bot] 认证成功，长连接已建立。等待员工消息…");
  });
  client.on("reconnecting", (attempt: number) => {
    console.log(`[bot] 连接断开，正在重连（第 ${attempt} 次）…`);
  });
  client.on("error", (err: Error) => {
    console.error(`[bot] 连接错误：${err.message ?? String(err)}`);
  });

  process.on("SIGINT", () => {
    console.log("\n[bot] 收到退出信号，断开连接…");
    client.disconnect();
    // 先关 DB 连接池再退出（未配置数据库时为 no-op），避免连接暴断
    void closeDbClient()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });

  console.log(`[bot] DCS Agent 企业微信机器人启动中…（Agent 预算 ${budgetMs}ms）`);
  console.log("[bot] 身份链路：identity.json 手动覆盖（可选）→ S2_Employee 数据库解析（仅在职）");
  client.connect();
}

main();
