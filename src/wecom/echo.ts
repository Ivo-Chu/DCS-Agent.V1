/**
 * wecom/echo.ts — Step 1：企业微信智能机器人长连接 Echo 验证。
 *
 * 目标（方案 §15 Step 1）：
 * 官方 SDK → BotID/Secret → WebSocket 长连接 → 收到员工文字
 * → 打印 msgid / userid → 回复固定文本。
 *
 * 本阶段刻意不做：Agent、DCS、Conversation Manager、状态机、
 * msgid 去重、超时控制、复杂错误处理——全部留给后续 Step。
 *
 * WeCom Channel 与 Agent Runtime 完全分离：本文件不 import core/dcs。
 *
 * 运行前需要设置环境变量（见文件末尾注释 / README）：
 *   WECOM_BOT_ID    智能机器人的 BotID
 *   WECOM_BOT_SECRET 智能机器人的长连接 Secret
 */
import AiBot, { generateReqId } from "@wecom/aibot-node-sdk";
import type { TextMessage, WsFrame } from "@wecom/aibot-node-sdk";

function main(): void {
  const botId = process.env.WECOM_BOT_ID ?? "";
  const secret = process.env.WECOM_BOT_SECRET ?? "";

  if (!botId || !secret) {
    console.error("未设置企业微信机器人凭据，无法启动 Echo。");
    console.error("需要两个环境变量（均为企业微信管理后台智能机器人配置页获取）：");
    console.error('  PowerShell：$env:WECOM_BOT_ID = "xxxx"；$env:WECOM_BOT_SECRET = "xxxx"');
    console.error('  bash：export WECOM_BOT_ID="xxxx" WECOM_BOT_SECRET="xxxx"');
    console.error("然后运行：npm run wecom:echo");
    process.exit(1);
  }

  const client = new AiBot.WSClient({ botId, secret });

  client.on("connected", () => {
    console.log("[echo] WebSocket 已连接，等待认证…");
  });

  client.on("authenticated", () => {
    console.log("[echo] 认证成功，长连接已建立。等待员工消息…");
  });

  client.on("reconnecting", (attempt: number) => {
    console.log(`[echo] 连接断开，正在重连（第 ${attempt} 次）…`);
  });

  client.on("disconnected", (reason: string) => {
    console.log(`[echo] 连接已断开：${reason}`);
  });

  client.on("error", (err: Error) => {
    console.error(`[echo] 连接错误：${err.message ?? String(err)}`);
  });

  // 收到文本消息：打印 msgid / userid / chattype / 内容，回复固定文本
  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const body = frame.body;
    if (!body) return;
    const content = body.text?.content ?? "";
    console.log(
      `[echo] 收到消息 msgid=${body.msgid} userid=${body.from.userid} chattype=${body.chattype} text="${content}"`
    );
    try {
      const streamId = generateReqId("stream");
      await client.replyStream(
        frame,
        streamId,
        "【Echo 模式】消息已收到。长连接链路正常。",
        true
      );
      console.log(`[echo] 已回复（msgid=${body.msgid}）`);
    } catch (err) {
      console.error(`[echo] 回复失败（msgid=${body.msgid}）：${String(err)}`);
    }
  });

  // 优雅退出
  process.on("SIGINT", () => {
    console.log("\n[echo] 收到退出信号，断开连接…");
    client.disconnect();
    process.exit(0);
  });

  console.log("[echo] DCS Agent 企业微信 Echo（Step 1）启动中…");
  client.connect();
}

main();
