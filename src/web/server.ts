/**
 * web/server.ts — Web Channel 入口（员工网页版问答入口，设计稿 v4）。
 *
 * 分层铁律（同 wecom）：Web 是 Channel/Adapter，不把 Web 概念写进 core；
 * Agent 组装只使用既有 dcs 工厂（session/prompt/tools/hooks），core 零改动。
 *
 * 零新增依赖：node:http 静态服务 + SSE（前端 fetch 流式读取）。
 * 前端静态文件在独立目录（默认 ../DCS Agent.web，与项目同级，不随本仓库 git；
 * 可用 WEB_STATIC_DIR 环境变量覆盖）。
 *
 * 接口：
 *   GET  /              静态页（/style.css、/app.js 同目录白名单）
 *   POST /api/session   工号建档 { code } → { token, name, employeeNo, department }
 *   POST /api/chat      SSE 流式问答 { question }（Authorization: Bearer <token>）
 *   POST /api/reset     新会话（丢弃该员工 Agent 实例；处理中返回 409 拒绝）
 *
 * 与 wecom 的差异：一次发送即完整问题（无确认状态机）；每员工同时只跑一个 Run
 * （busy 时拒绝新 Run）；90s 预算超时 abort + 丢弃 Agent（与 agent-runner 同口径）。
 *
 * 测试期身份：页面输入工号 → S2_Employee 查库（仅在职）；上线前换真实认证。
 *
 * 环境变量：WEB_PORT（默认 8787）、WEB_RUN_BUDGET_MS（默认 90000）、
 *           WEB_STATIC_DIR（前端静态目录，默认 ../DCS Agent.web）、
 *           DEEPSEEK_API_KEY（必需）、DCS_DB_*（身份与数据查询）。
 *
 * 运行：npm run web
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../core/events.ts";
import { createDcsAgent } from "../dcs/agent-factory.ts";
import { loadEnvLocal } from "../dcs/env-local.ts";

loadEnvLocal();
import { resolveEmployeeByCode, type DcsIdentity } from "../dcs/identity.ts";
import { createSession } from "../dcs/session.ts";
import { closeDbClient } from "../dcs/db/client.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_BUDGET_MS = 90_000;
const MAX_QUESTION_CHARS = 2000;
const MAX_BODY_BYTES = 64 * 1024;

/** Agent 的最小契约（测试注入用，与 wecom/agent-runner 同思路）。 */
export interface AgentLike {
  prompt(question: string): Promise<string>;
  subscribe(fn: (e: AgentEvent) => void): () => void;
}

export interface WebServerDeps {
  /** 工号 → 身份（默认走 dcs/identity 数据库链路；测试注入假实现）。 */
  resolveIdentity?: (code: string) => Promise<DcsIdentity | null>;
  /** Agent 工厂（默认真实组装；测试注入假 Agent）。holder 每次 Run 替换 controller。 */
  createAgent?: (identity: DcsIdentity, holder: { controller: AbortController }) => AgentLike;
  /** 单次 Run 预算（默认 90s，同企微口径）。 */
  budgetMs?: number;
  /** 静态文件目录（默认 WEB_STATIC_DIR 或 ../DCS Agent.web）。 */
  staticDir?: string;
  logger?: (msg: string) => void;
}

interface SessionRecord {
  identity: DcsIdentity;
  createdAt: number;
}

interface AgentEntry {
  agent: AgentLike;
  /** 可变取消信号持有器：模型 signalProvider 读取同一对象（复制 controller 引用会使取消失效）。 */
  holder: { controller: AbortController };
  busy: boolean;
}

const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/app.js": "app.js",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createWebServer(deps: WebServerDeps = {}): http.Server {
  const resolveId = deps.resolveIdentity ?? resolveEmployeeByCode;
  const budgetMs = deps.budgetMs ?? Number(process.env.WEB_RUN_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  const staticDir =
    deps.staticDir ??
    process.env.WEB_STATIC_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "DCS Agent.web");
  const log = deps.logger ?? ((m: string) => console.log(m));

  const sessions = new Map<string, SessionRecord>();
  /** 每员工一个 Agent 实例（key = employeeNo），与 wecom 的每 userid 一个同口径。 */
  const agents = new Map<string, AgentEntry>();

  const createAgent =
    deps.createAgent ??
    ((identity: DcsIdentity, holder: { controller: AbortController }): AgentLike => {
      const session = createSession(identity, `web-${identity.employeeNo}`, "web");
      return createDcsAgent({ session, holder });
    });

  function getEntry(identity: DcsIdentity): AgentEntry {
    let entry = agents.get(identity.employeeNo);
    if (!entry) {
      const holder = { controller: new AbortController() };
      entry = { agent: createAgent(identity, holder), holder, busy: false };
      agents.set(identity.employeeNo, entry);
      log(`[web] 已为 ${identity.name}/${identity.employeeNo} 创建 Agent`);
    }
    return entry;
  }

  function discardEntry(employeeNo: string): void {
    if (agents.delete(employeeNo)) log(`[web] 已废弃 ${employeeNo} 的 Agent 实例`);
  }

  /**
   * 仅当 Map 中保存的仍是本次运行的实例时才删除（2026-09-28 修复）：
   * 超时/断开触发的清理是异步回调，期间 Map 可能已被 reset+新 Run 换成
   * 新实例——旧回调不得误删新实例。
   */
  function discardEntryIfCurrent(employeeNo: string, entry: AgentEntry): void {
    if (agents.get(employeeNo) === entry) discardEntry(employeeNo);
  }

  function auth(req: http.IncomingMessage): DcsIdentity | null {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    return sessions.get(m[1])?.identity ?? null;
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function sseSend(res: http.ServerResponse, payload: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** 执行一次完整 Run（占位 → 流式 → 最终/超时/失败），占用 entry.busy。 */
  async function runChat(
    identity: DcsIdentity,
    question: string,
    res: http.ServerResponse
  ): Promise<void> {
    const entry = getEntry(identity);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (entry.busy) {
      sseSend(res, { type: "busy", message: "上一问正在处理中，请稍后。" });
      res.end();
      return;
    }
    entry.busy = true;
    // 新 Run 新控制器：替换 holder 内的 controller（模型 signalProvider 读取
    // 同一 holder，立即生效）；旧 Run 的 aborted signal 不影响新 Run
    entry.holder.controller = new AbortController();

    let finished = false;
    let timedOut = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      entry.busy = false;
      res.end();
    };

    const unsubscribe = entry.agent.subscribe((e) => {
      if (finished) return;
      // 口径：只转发文本增量与工具步骤（名称+成败），不转发工具参数/结果摘要
      if (e.type === "message_delta") {
        sseSend(res, { type: "delta", text: e.text });
      } else if (e.type === "tool_execution_start") {
        sseSend(res, { type: "tool_step", status: "start", name: e.toolName });
      } else if (e.type === "tool_execution_end") {
        sseSend(res, { type: "tool_step", status: "end", name: e.toolName, isError: e.isError });
      }
    });

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      entry.holder.controller.abort(); // 中止当前及后续模型请求
      discardEntryIfCurrent(identity.employeeNo, entry); // 废弃可能被污染的 Agent（仅当仍是本实例）
      sseSend(res, { type: "timeout", message: "这次查询超时，请稍后重试。" });
      finish();
    }, budgetMs);

    // 前端停止/关闭页面：连接断开即中止 Run（迟到结果无人接收，直接废弃）
    res.on("close", () => {
      if (!finished) {
        entry.holder.controller.abort();
        discardEntryIfCurrent(identity.employeeNo, entry);
        finish();
      }
    });

    try {
      const answer = await entry.agent.prompt(question);
      if (finished) return; // 已超时或客户端断开
      sseSend(res, { type: "final", text: answer.trim().length > 0 ? answer : "这次查询未能生成回复，请稍后重试。" });
    } catch (err) {
      log(`[web] Run 异常（${identity.employeeNo}）：${String(err)}`);
      if (!finished && !timedOut) {
        sseSend(res, { type: "error", message: "处理出现问题，请稍后重试。" });
      }
    } finally {
      finish();
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? "/").split("?")[0];

      // ---- 静态文件（白名单）----
      if (req.method === "GET" && url in STATIC_FILES) {
        const file = path.join(staticDir, STATIC_FILES[url]);
        let content: Buffer;
        try {
          content = fs.readFileSync(file);
        } catch {
          sendJson(res, 404, { ok: false, message: "静态文件不存在" });
          return;
        }
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
        res.end(content);
        return;
      }

      // ---- 工号建档 ----
      if (req.method === "POST" && url === "/api/session") {
        let code = "";
        try {
          const body = JSON.parse(await readBody(req)) as { code?: unknown };
          code = typeof body.code === "string" ? body.code.trim() : "";
        } catch {
          sendJson(res, 400, { ok: false, message: "请求格式错误" });
          return;
        }
        if (!code) {
          sendJson(res, 400, { ok: false, message: "请输入工号" });
          return;
        }
        const identity = await resolveId(code);
        if (!identity) {
          sendJson(res, 404, { ok: false, message: "未能识别该工号，请确认后重试。" });
          return;
        }
        const token = randomUUID();
        sessions.set(token, { identity, createdAt: Date.now() });
        log(`[web] ${identity.name}/${identity.employeeNo} 已建档（web 通道）`);
        sendJson(res, 200, {
          ok: true,
          token,
          name: identity.name,
          employeeNo: identity.employeeNo,
          department: identity.department ?? "",
        });
        return;
      }

      // ---- 以下接口均需鉴权 ----
      if (req.method === "POST" && (url === "/api/chat" || url === "/api/reset")) {
        const identity = auth(req);
        if (!identity) {
          sendJson(res, 401, { ok: false, message: "会话已失效，请重新输入工号。" });
          return;
        }
        if (url === "/api/reset") {
          // 2026-09-28 修复：处理中重置会与运行结束的清理回调竞争
          //（旧回调误删新实例 / busy 状态丢失），最小方案是直接拒绝：
          // busy 时返回 409，保留当前实例与状态，等本 Run 完成后再重置。
          const current = agents.get(identity.employeeNo);
          if (current?.busy) {
            sendJson(res, 409, { ok: false, message: "上一问正在处理中，请完成后再新建会话。" });
            return;
          }
          discardEntry(identity.employeeNo);
          sendJson(res, 200, { ok: true });
          return;
        }
        // /api/chat
        let question = "";
        try {
          const body = JSON.parse(await readBody(req)) as { question?: unknown };
          question = typeof body.question === "string" ? body.question.trim() : "";
        } catch {
          sendJson(res, 400, { ok: false, message: "请求格式错误" });
          return;
        }
        if (!question) {
          sendJson(res, 400, { ok: false, message: "问题不能为空" });
          return;
        }
        if (question.length > MAX_QUESTION_CHARS) {
          sendJson(res, 400, { ok: false, message: `问题过长（>${MAX_QUESTION_CHARS} 字），请精简后重试。` });
          return;
        }
        log(`[web] ${identity.employeeNo} 提问："${question.slice(0, 50)}"`);
        await runChat(identity, question, res);
        return;
      }

      sendJson(res, 404, { ok: false, message: "接口不存在" });
    })().catch((err) => {
      log(`[web] 请求处理异常：${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: "服务内部错误" });
      else res.end();
    });
  });

  return server;
}

/** 直接运行时启动（tsx src/web/server.ts）。 */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("未设置 DEEPSEEK_API_KEY，无法启动。");
    console.error('PowerShell：$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"');
    process.exit(1);
  }
  const port = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
  const server = createWebServer();
  server.listen(port, () => {
    console.log(`[web] DCS 智能体网页端已启动：http://localhost:${port}`);
    console.log("[web] 身份方式：工号建档（测试期，S2_Employee 查库，仅在职）");
  });
  process.on("SIGINT", () => {
    console.log("\n[web] 收到退出信号，正在关闭…");
    server.close();
    closeDbClient()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
