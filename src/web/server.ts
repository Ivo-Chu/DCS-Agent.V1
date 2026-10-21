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
 *   POST /api/session   测试工号建档 { code } → { token, name, employeeNo, department }
 *   POST /api/session/sso  DCS code 校验 → 员工会话
 *   POST /api/chat      SSE 流式问答 { question }（Authorization: Bearer <token>）
 *   POST /api/reset     新会话（丢弃该员工 Agent 实例；处理中返回 409 拒绝）
 *
 * 与 wecom 的差异：一次发送即完整问题（无确认状态机）；每员工同时只跑一个 Run
 * （busy 时拒绝新 Run）；可配置预算超时 abort + 丢弃 Agent。
 *
 * 正式 Web 身份：DCS SSO 校验后查在职员工；手动工号入口仅显式测试开关可用。
 *
 * 环境变量：WEB_PORT（默认 8787）、WEB_RUN_BUDGET_MS（默认 1000000）、
 *           WEB_STATIC_DIR（默认 ../DCS Agent.web/dist）、
 *           LLM_API_KEY（必需）、DCS_DB_*（身份与数据查询）。
 *
 * 运行：npm run web
 */
import * as http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../core/events.ts";
import { createDcsAgent } from "../dcs/agent-factory.ts";
import { maskPii } from "../dcs/hooks.ts";
import { loadEnvLocal } from "../dcs/env-local.ts";
import { attachRunObserver } from "../observability/observer.ts";

loadEnvLocal();
import { resolveEmployeeByCode, type DcsIdentity } from "../dcs/identity.ts";
import { createNavigateDcsMenuTool, type RequestNavigation, type NavigationResult } from "../dcs/navigation-tool.ts";
import { createSession } from "../dcs/session.ts";
import { closeDbClient } from "../dcs/db/client.ts";
import { checkSsoCodeWithDcs } from "./sso.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_BUDGET_MS = 1000_000;
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
  createAgent?: (
    identity: DcsIdentity,
    holder: { controller: AbortController },
    authMethod: "dcs_sso" | "manual_test",
    requestNavigation: RequestNavigation
  ) => AgentLike;
  /** 单次 Run 预算（默认 1000s）。 */
  budgetMs?: number;
  /** 静态文件目录（默认 WEB_STATIC_DIR 或 ../DCS Agent.web/dist）。 */
  staticDir?: string;
  logger?: (msg: string) => void;
  /** 等待 Run 日志落盘完成（测试用：可 await flush，不依赖固定睡眠）。 */
  awaitLogs?: () => Promise<void>;
  /** JSONL 日志目录（默认项目根 logs/；测试注入临时目录）。 */
  logsDir?: string;
  /** DCS CheckSSOCode 地址（默认本机调试地址，可配置）。 */
  ssoCheckUrl?: string;
  /** 测试注入 SSO 校验，返回可信员工工号。 */
  checkSsoCode?: (code: string, signal?: AbortSignal) => Promise<string | null>;
  ssoTimeoutMs?: number;
  navigationTimeoutMs?: number;
}

interface SessionRecord {
  identity: DcsIdentity;
  createdAt: number;
  authMethod: "dcs_sso" | "manual_test";
}

interface WebRun {
  id: string;
  session: SessionRecord;
  entry: AgentEntry;
  response: http.ServerResponse;
  controller: AbortController;
  active: boolean;
  toolCallId?: string;
}

interface PendingNavigation {
  run: WebRun;
  requestId: string;
  menuName: string;
  resolve: (result: NavigationResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface AgentEntry {
  agent: AgentLike;
  /** 可变取消信号持有器：模型 signalProvider 读取同一对象（复制 controller 引用会使取消失效）。 */
  holder: { controller: AbortController };
  busy: boolean;
  currentRun?: WebRun;
}

const DEFAULT_SSO_CHECK_URL = process.env.DCS_SSO_CHECK_URL ?? "http://localhost:60141/api/Account/CheckSSOCode";
const NAVIGATION_TIMEOUT_MS = 30_000;

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
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function createWebServer(deps: WebServerDeps = {}): http.Server {
  const resolveId = deps.resolveIdentity ?? resolveEmployeeByCode;
  const budgetMs = deps.budgetMs ?? Number(process.env.WEB_RUN_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  const staticDir =
    deps.staticDir ??
    process.env.WEB_STATIC_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "DCS Agent.web", "dist");
  const log = deps.logger ?? ((m: string) => console.log(m));
  const ssoCheckUrl = deps.ssoCheckUrl ?? DEFAULT_SSO_CHECK_URL;
  const navigationTimeoutMs = deps.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const pendingNavigations = new Map<string, PendingNavigation>();

  const sessions = new Map<string, SessionRecord>();
  /** 每员工一个 Agent 实例（key = employeeNo），与 wecom 的每 userid 一个同口径。 */
  const agents = new Map<string, AgentEntry>();
  // 保留 Agent 实例，但异步工具始终继承其发起 prompt 的 Run，不能读取“最新 Run”。
  const runScope = new AsyncLocalStorage<WebRun>();
  const createAgent =
    deps.createAgent ??
    ((
      identity: DcsIdentity,
      holder: { controller: AbortController },
      authMethod: "dcs_sso" | "manual_test",
      requestNavigation: RequestNavigation
    ): AgentLike => {
      // manual_test 不携带 dcs_sso 标记；只有显式测试开关才可通过验权。
      const session = createSession(identity, `web-${identity.employeeNo}`, "web", authMethod);
      const navigateTool = createNavigateDcsMenuTool(requestNavigation);
      return createDcsAgent({ session, holder, extraTools: [navigateTool] });
    });

  async function checkSsoCode(code: string, signal: AbortSignal): Promise<string | null> {
    const employeeNo = await (deps.checkSsoCode ? deps.checkSsoCode(code, signal) : checkSsoCodeWithDcs(code, ssoCheckUrl, log, { signal, timeoutMs: deps.ssoTimeoutMs }));
    if (!employeeNo || !/^[A-Za-z0-9_-]{1,64}$/.test(employeeNo)) return null;
    return employeeNo.toUpperCase();
  }

  function isActiveRun(run: WebRun): boolean {
    return run.active && !run.controller.signal.aborted &&
      agents.get(run.session.identity.employeeNo) === run.entry &&
      run.entry.currentRun === run && !run.response.writableEnded && !run.response.destroyed;
  }

  function resolveNavigationResult(requestId: string, session: SessionRecord, result: NavigationResult): boolean {
    const pending = pendingNavigations.get(requestId);
    if (!pending || pending.run.session !== session || !isActiveRun(pending.run)) return false;
    clearTimeout(pending.timer);
    pendingNavigations.delete(requestId);
    pending.resolve(result);
    return true;
  }

  function failNavigation(pending: PendingNavigation, reason: Error): void {
    clearTimeout(pending.timer);
    if (pendingNavigations.get(pending.requestId) === pending) pendingNavigations.delete(pending.requestId);
    pending.reject(reason);
  }

  function requestNavigation(entry: AgentEntry, employeeNo: string, menuName: string): Promise<NavigationResult> {
    const run = runScope.getStore();
    if (!run || run.entry !== entry || run.session.identity.employeeNo !== employeeNo || !isActiveRun(run)) {
      return Promise.reject(new Error("当前聊天连接已关闭，导航未执行。"));
    }
    const requestId = `nav-${randomUUID()}`;
    return new Promise<NavigationResult>((resolve, reject) => {
      const pending: PendingNavigation = {
        run,
        requestId,
        menuName,
        resolve,
        reject,
        timer: setTimeout(() => {
          failNavigation(pending, new Error(`浏览器未在${Math.round(navigationTimeoutMs / 1000)}秒内回传导航结果`));
        }, navigationTimeoutMs),
      };
      pendingNavigations.set(requestId, pending);
      // 只在工具真实 execute 后发送；未通过安全 Hook 的调用不会产生 UI 副作用。
      sseSend(run.response, {
        type: "ui_action",
        action: "navigate_dcs_menu",
        requestId,
        toolCallId: run.toolCallId,
        payload: { menuName },
      });
    });
  }
  function getEntry(session: SessionRecord): AgentEntry {
    const identity = session.identity;
    let entry = agents.get(identity.employeeNo);
    if (!entry) {
      const holder = { controller: new AbortController() };
      entry = { agent: createAgent(identity, holder, session.authMethod,
        (employeeNo, menuName) => requestNavigation(entry!, employeeNo, menuName)), holder, busy: false };
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

  function auth(req: http.IncomingMessage): SessionRecord | null {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    return sessions.get(m[1]) ?? null;
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
    session: SessionRecord,
    question: string,
    res: http.ServerResponse
  ): Promise<void> {
    const identity = session.identity;
    const entry = getEntry(session);
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
    const run: WebRun = {
      id: randomUUID(), session, entry, response: res,
      controller: entry.holder.controller, active: true,
    };
    entry.currentRun = run;

    // 日志观测：中文终端日志 + logs/*.jsonl（与 CLI 同一事件流，不改变 SSE 协议）
    // 模型/提供方标识由 run_start 事件携带（factory 统一从 Provider 配置获取）
    const observer = attachRunObserver(entry.agent, {
      channel: "Web",
      write: (t) => log(t),
      logsDir: deps.logsDir,
    });
    const trace = (event: string, details: Record<string, unknown> = {}): void => {
      try {
        log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
      } catch {
        // 日志失败不能中断事件转发或 Run 清理。
      }
    };

    let finished = false;
    let timedOut = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      run.active = false;
      if (entry.currentRun === run) {
        entry.currentRun = undefined;
        entry.busy = false;
      }
      for (const pending of [...pendingNavigations.values()]) {
        if (pending.run === run) {
          failNavigation(pending, new Error("聊天连接已结束，导航未完成。"));
        }
      }
      res.end();
    };

    let messageId = "1";
    const unsubscribe = entry.agent.subscribe((e) => {
      if (finished) return;
      // 口径：只转发文本增量与工具步骤（名称+成败），不转发工具参数/结果摘要
      if (e.type === "model_call_start") {
        messageId = String(e.turn);
      } else if (e.type === "message_delta") {
        sseSend(res, { type: "delta", text: e.text, messageId });
      } else if (e.type === "tool_execution_start") {
        run.toolCallId = e.toolCallId;
        sseSend(res, { type: "tool_step", status: "start", name: e.toolName, toolCallId: e.toolCallId });
      } else if (e.type === "tool_execution_end") {
        run.toolCallId = undefined;
        sseSend(res, { type: "tool_step", status: "end", name: e.toolName, toolCallId: e.toolCallId, isError: e.isError });
      } else if (e.type === "agent_error") {
        trace("agent_error", { message: maskPii(e.message) });
      }
    });

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      trace("run_timeout");
      entry.holder.controller.abort(); // 中止当前及后续模型请求
      // F3：先幂等结束日志（记录准确原因并 flush），再释放回复；
      // observer.end 是幂等的，迟到的 run_end 不会重复记录
      void observer.end("timeout").then(() => deps.awaitLogs?.()).catch(() => undefined);
      discardEntryIfCurrent(identity.employeeNo, entry); // 废弃可能被污染的 Agent（仅当仍是本实例）
      sseSend(res, { type: "timeout", message: "这次查询超时，请稍后重试。" });
      finish();
    }, budgetMs);

    // 前端停止/关闭页面：连接断开即中止 Run（迟到结果无人接收，直接废弃）
    res.on("close", () => {
      if (!finished) {
        trace("run_disconnected");
        entry.holder.controller.abort();
        // F3：断开路径同样幂等结束日志
        void observer.end("disconnected").then(() => deps.awaitLogs?.()).catch(() => undefined);
        discardEntryIfCurrent(identity.employeeNo, entry);
        finish();
      }
    });

    try {
      const answer = await runScope.run(run, () => entry.agent.prompt(question));
      if (finished) return; // 已超时或客户端断开
      sseSend(res, { type: "final", messageId, text: answer.trim().length > 0 ? answer : "这次查询未能生成回复，请稍后重试。" });
    } catch (err) {
      trace("run_error", { message: maskPii(String(err)) });
      log(`[web] Run 异常（${identity.employeeNo}）：${String(err)}`);
      if (!finished && !timedOut) {
        sseSend(res, { type: "error", message: "处理出现问题，请稍后重试。" });
      }
    } finally {
      // 正常完成：run_end 已终结 observer；detach 仅退订防御迟到事件
      observer.detach();
      finish();
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? "/").split("?")[0];

      // ---- 静态文件（根页白名单 + Vite dist/assets 只读服务）----
      if (req.method === "GET" && (url in STATIC_FILES || url.startsWith("/assets/"))) {
        const relative = url in STATIC_FILES ? STATIC_FILES[url] : url.slice(1);
        const file = path.resolve(staticDir, relative);
        if (!file.startsWith(path.resolve(staticDir) + path.sep)) {
          sendJson(res, 403, { ok: false, message: "静态文件路径无效" });
          return;
        }
        if (path.extname(file) === "") {
          sendJson(res, 404, { ok: false, message: "静态文件不存在" });
          return;
        }
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

      // ---- DCS SSO 建档（正式 Web 身份）----
      if (req.method === "POST" && url === "/api/session/sso") {
        let code = "";
        try {
          const body = JSON.parse(await readBody(req)) as { code?: unknown };
          code = typeof body.code === "string" ? body.code.trim() : "";
        } catch {
          sendJson(res, 400, { ok: false, message: "请求格式错误" });
          return;
        }
        if (!code || code.length > 256) {
          sendJson(res, 400, { ok: false, message: "SSO登录码无效" });
          return;
        }
        const loginController = new AbortController();
        const cancelLogin = () => loginController.abort();
        res.once("close", cancelLogin);
        try {
          const employeeNo = await checkSsoCode(code, loginController.signal);
          if (loginController.signal.aborted) return;
          if (!employeeNo) {
            sendJson(res, 401, { ok: false, message: "SSO校验失败或超时，请重新打开DCS Agent。" });
            return;
          }
          const identity = await resolveId(employeeNo);
          if (loginController.signal.aborted) return;
          if (!identity) {
            sendJson(res, 404, { ok: false, message: "SSO员工未在DCS在职名单中识别。" });
            return;
          }
          const token = randomUUID();
          sessions.set(token, { identity, createdAt: Date.now(), authMethod: "dcs_sso" });
          log(`[web] ${identity.name}/${identity.employeeNo} 已通过DCS SSO建档`);
          sendJson(res, 200, {
            ok: true,
            token,
            name: identity.name,
            employeeNo: identity.employeeNo,
            department: identity.department ?? "",
            authMethod: "dcs_sso",
          });
        } finally { res.off("close", cancelLogin); }
        return;
      }
      // ---- 工号建档（仅显式开启的本地测试入口） ----
      if (req.method === "POST" && url === "/api/session") {
        if (process.env.DCS_ALLOW_WEB_TEST_IDENTITY !== "true") {
          sendJson(res, 404, { ok: false, message: "本入口未开启" });
          return;
        }
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
        sessions.set(token, { identity, createdAt: Date.now(), authMethod: "manual_test" });
        log(`[web] ${identity.name}/${identity.employeeNo} 已建档（显式本地测试入口）`);
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
      if (req.method === "POST" && (url === "/api/chat" || url === "/api/reset" || url === "/api/ui-action/result")) {
        const session = auth(req);
        if (!session) {
          sendJson(res, 401, { ok: false, message: "会话已失效，请重新打开DCS Agent。" });
          return;
        }
        if (url === "/api/reset") {
          // 2026-09-28 修复：处理中重置会与运行结束的清理回调竞争
          //（旧回调误删新实例 / busy 状态丢失），最小方案是直接拒绝：
          // busy 时返回 409，保留当前实例与状态，等本 Run 完成后再重置。
          const current = agents.get(session.identity.employeeNo);
          if (current?.busy) {
            sendJson(res, 409, { ok: false, message: "上一问正在处理中，请完成后再新建会话。" });
            return;
          }
          discardEntry(session.identity.employeeNo);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (url === "/api/ui-action/result") {
          let requestId = "";
          let result: NavigationResult | undefined;
          try {
            const body = JSON.parse(await readBody(req)) as { requestId?: unknown; result?: unknown };
            requestId = typeof body.requestId === "string" ? body.requestId : "";
            const value = body.result as Partial<NavigationResult> | null;
            if (value && typeof value.ok === "boolean" && typeof value.message === "string" && value.message.trim()) {
              result = { ok: value.ok, message: value.message.trim().slice(0, 2000) };
            }
          } catch {
            sendJson(res, 400, { ok: false, message: "请求格式错误" });
            return;
          }
          if (!requestId || !result) {
            sendJson(res, 400, { ok: false, message: "requestId和result不能为空" });
            return;
          }
          const accepted = resolveNavigationResult(requestId, session, result);
          sendJson(res, accepted ? 200 : 404, { ok: accepted });
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
        log(`[web] ${session.identity.employeeNo} 提问："${question.slice(0, 50)}"`);
        await runChat(session, question, res);
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
  if (!process.env.LLM_API_KEY) {
    console.error("未设置 LLM_API_KEY，无法启动。");
    console.error('PowerShell：$env:LLM_API_KEY = "sk-xxxxxxxx"');
    process.exit(1);
  }
  const port = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
  const server = createWebServer();
  server.listen(port, () => {
    console.log(`[web] DCS 智能体网页端已启动：http://localhost:${port}`);
    console.log("[web] 身份方式：DCS SSO（校验后查在职员工）");
  });
  process.on("SIGINT", () => {
    console.log("\n[web] 收到退出信号，正在关闭…");
    server.close();
    closeDbClient()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
