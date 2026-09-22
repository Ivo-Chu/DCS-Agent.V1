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
import { Agent } from "../core/agent.ts";
import { createDeepSeekStreamFn } from "../core/model/deepseek.ts";
import { createDcsToolHooks } from "../dcs/hooks.ts";
import { resolveIdentity } from "../dcs/identity.ts";
import { buildSystemPrompt } from "../dcs/prompt.ts";
import { createSession, type DcsToolContext } from "../dcs/session.ts";
import { dcsTools } from "../dcs/tools.ts";
import { AgentRunner, type UserAgentSlot } from "./agent-runner.ts";
import {
  BUSY_PROMPT,
  CONFIRM_PROMPT,
  ConversationManager,
} from "./conversation.ts";
import { MsgIdDedup } from "./dedup.ts";

const UNKNOWN_IDENTITY_REPLY =
  "暂时无法识别您的 DCS 员工身份，请联系管理员。";
const GROUP_CHAT_REPLY = "暂时仅支持单聊咨询，请在单聊中与我对话。";

interface UserAgentEntry {
  agent: Agent<DcsToolContext>;
  controller: AbortController;
}

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
      const identity = resolveIdentity(userId);
      if (!identity) {
        // bot 入口已在消息层做过身份校验，这里理论上不可达；防御性兜底
        throw new Error(`未登记用户 ${userId}`);
      }
      const holder = { controller: new AbortController() };
      const session = createSession(identity, userId);
      const agent = new Agent<DcsToolContext>({
        systemPrompt: buildSystemPrompt(session),
        tools: dcsTools,
        // 每用户独立 streamFn，绑定该用户的取消信号持有器；
        // Run 开始时替换 controller，超时 abort 后旧 Run 无法再发起模型请求
        streamFn: createDeepSeekStreamFn({
          signalProvider: () => holder.controller.signal,
        }),
        toolContext: { session },
        hooks: createDcsToolHooks(),
        maxTurns: 8,
      });
      entry = { agent, controller: holder.controller };
      agents.set(userId, entry);
      console.log(`[bot] 已为用户 ${userId} 创建 Agent（${identity.name}/${identity.employeeNo}，TEST DATA 身份）`);
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
      askConfirm: (token) => replyText(token, CONFIRM_PROMPT),
      notifyBusy: (token) => replyText(token, BUSY_PROMPT),
      runAgent: (userId, question, token) => runner.run(userId, question, token),
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

    // 身份解析：未登记 → 中性拒答（不默认映射、不进入 Agent）
    const identity = resolveIdentity(userid);
    if (!identity) {
      console.log(`[bot] 未登记用户 ${userid}，拒答`);
      await replyText(frame, UNKNOWN_IDENTITY_REPLY).catch((e) => console.error(`[bot] 回复失败：${String(e)}`));
      return;
    }

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
    process.exit(0);
  });

  console.log(`[bot] DCS Agent 企业微信机器人启动中…（Agent 预算 ${budgetMs}ms）`);
  console.log("[bot] 身份数据来源：identity.json（TEST DATA，上线前替换为真实 DCS 身份）");
  client.connect();
}

main();
