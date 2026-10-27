/** Web Channel: existing DCS SSO, local idle sessions, SQLite conversations and chat SSE. */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnvLocal } from "../dcs/env-local.ts";
import { createDcsAgent } from "../dcs/agent-factory.ts";
import { createSession } from "../dcs/session.ts";
import { resolveEmployeeByCode, type DcsIdentity } from "../dcs/identity.ts";
import { closeDbClient } from "../dcs/db/client.ts";
import { createNavigateDcsMenuTool, parseNavigationResult } from "../dcs/navigation-tool.ts";
import { ConversationStore } from "./conversation-store.ts";
import { createLoginAuthority, type LoginAuthority } from "./sso.ts";
import { ConversationRuntime, type AgentFactory, type WebSession } from "./conversation-runtime.ts";
export type { AgentLike } from "./conversation-runtime.ts";
import { listLogs, logFiles, readLog } from "./log-reader.ts";
loadEnvLocal();
export interface WebServerDeps {
    resolveIdentity?: (code: string) => Promise<DcsIdentity | null>;
    createAgent?: AgentFactory;
    authority?: LoginAuthority;
    store?: ConversationStore;
    dataFile?: string;
    idleMs?: number;
    budgetMs?: number;
    staticDir?: string;
    logger?: (s: string) => void;
    logsDir?: string;
    navigationTimeoutMs?: number;
}
function json(res: http.ServerResponse, status: number, body: unknown) { if (res.destroyed)
    return; res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const value of req) {
        const b = Buffer.from(value);
        size += b.length;
        if (size > 65536)
            throw new Error("body too large");
        parts.push(b);
    }
    const v = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("invalid body");
    return v;
}
export function createWebServer(deps: WebServerDeps = {}): http.Server {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const staticDir = path.resolve(deps.staticDir ?? process.env.WEB_STATIC_DIR ?? path.join(root, "../DCS Agent.web/dist"));
    const dataFile = deps.dataFile ?? process.env.DCS_AGENT_DATA_FILE ?? path.join(root, "data/web/conversations.sqlite");
    if (dataFile !== ":memory:" && (path.resolve(dataFile) === staticDir || path.resolve(dataFile).startsWith(staticDir + path.sep)))
        throw new Error("SQLite must not be in the static directory");
    const store = deps.store ?? new ConversationStore(dataFile, deps.idleMs), authority = deps.authority ?? createLoginAuthority();
    const sessions = new Map<string, WebSession>();
    const timers = new Map<string, NodeJS.Timeout>();
    const idleMs = deps.idleMs ?? 30 * 60_000;
    let closed = false;
    const resolveId = deps.resolveIdentity ?? resolveEmployeeByCode;
    const log = deps.logger ?? console.log;
    const factory: AgentFactory = deps.createAgent ?? ((identity, holder, authMethod, nav) => createDcsAgent({ session: createSession(identity, `web-${identity.employeeNo}`, "web", authMethod), holder, extraTools: [createNavigateDcsMenuTool(nav)] }));
    const runtime = new ConversationRuntime(store, factory, { budgetMs: deps.budgetMs ?? Number(process.env.WEB_RUN_BUDGET_MS ?? 1000000), navigationTimeoutMs: deps.navigationTimeoutMs ?? 30000, logsDir: deps.logsDir ?? path.join(root, "logs"), onIdle: touch });
    async function expire(id: string) {
        clearTimeout(timers.get(id)); timers.delete(id);
        for (const [token,s] of sessions) if (s.agentSessionId === id) sessions.delete(token);
        await runtime.revoke(id);
    }
    function schedule(id: string) {
        clearTimeout(timers.get(id));
        if (closed || !store.active(id)) return;
        const timer = setTimeout(() => {
            timers.delete(id);
            if (runtime.busySession(id)) return; // run completion starts the idle period
            if (store.deadline(id) > Date.now()) schedule(id);
            else void expire(id).catch(() => log("[web] expired conversation cleanup failed"));
        }, Math.max(1, store.deadline(id) - Date.now()));
        timer.unref(); timers.set(id, timer);
    }
    function touch(id: string) {
        if (closed || !store.active(id)) return;
        store.touch(id, Date.now() + idleMs); schedule(id);
    }
    // Local restart recovery only. No call to DCS, no recurring status scan.
    const recovery = Promise.all(store.logins().map(l => {
        if (store.deadline(l.id) <= Date.now()) return expire(l.id);
        schedule(l.id); return Promise.resolve();
    })).then(() => runtime.cleanOrphanLogs()).catch(() => log("[web] local cleanup incomplete"));
    const server = http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? "/", "http://local"), route = url.pathname;
            if (req.method === "GET" && (route === "/" || route === "/index.html" || route.startsWith("/assets/"))) {
                const file = path.resolve(staticDir, route.startsWith("/assets/") ? route.slice(1) : "index.html");
                if (!file.startsWith(staticDir + path.sep)) {
                    json(res, 403, { ok: false });
                    return;
                }
                try {
                    const bytes = fs.readFileSync(file);
                    res.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" } as Record<string, string>)[path.extname(file)] ?? "application/octet-stream" });
                    res.end(bytes);
                }
                catch {
                    json(res, 404, { ok: false });
                }
                return;
            }
            if (req.method === "GET" && (route === "/api/logs" || route === "/api/log")) {
                const remote = req.socket.remoteAddress;
                if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
                    json(res, 403, { ok: false, message: "日志仅供本机查看。" }); return;
                }
                const logsRoot = deps.logsDir ?? path.join(root, "logs");
                if (route === "/api/logs") {
                    json(res, 200, { ok: true, runs: await listLogs(logsRoot) }); return;
                }
                const file = url.searchParams.get("file") ?? "";
                if (!(await logFiles(logsRoot)).includes(file)) {
                    json(res, 404, { ok: false, message: "日志不存在或已清理。" }); return;
                }
                try { json(res, 200, { ok: true, ...await readLog(logsRoot, file) }); }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                    json(res, 404, { ok: false, message: "日志不存在或已清理。" });
                }
                return;
            }
            if (req.method === "POST" && (route === "/api/session/sso" || route === "/api/session")) {
                const manual = route === "/api/session";
                if (manual && process.env.DCS_ALLOW_WEB_TEST_IDENTITY !== "true") {
                    json(res, 404, { ok: false });
                    return;
                }
                const b = await body(req), code = typeof b.code === "string" ? b.code.trim() : "";
                if (!code || code.length > 1024) {
                    json(res, 400, { ok: false, message: "登录材料无效。" });
                    return;
                }
                const controller = new AbortController(), cancel = () => controller.abort();
                res.once("close", cancel);
                try {
                    const verified = manual ? { status: "valid" as const, employeeNo: code.toUpperCase() } :
                        await authority.verify(code, controller.signal).catch(() => ({ status: "unavailable" as const }));
                    if (controller.signal.aborted)
                        return;
                    if (verified.status !== "valid") {
                        json(res, verified.status === "invalid" ? 401 : 503, { ok: false, code: verified.status === "invalid" ? "login_invalid" : "login_unavailable", message: verified.status === "invalid" ? "DCS登录已失效，请重新登录DCS。" : "暂时无法核验DCS登录，请稍后重试。" });
                        return;
                    }
                    const identity = await resolveId(verified.employeeNo);
                    if (controller.signal.aborted)
                        return;
                    if (!identity || identity.employeeNo !== verified.employeeNo) {
                        json(res, 403, { ok: false, message: "未识别在职员工。" });
                        return;
                    }
                    const employee = manual ? "test:" + identity.employeeNo : identity.employeeNo;
                    let id = store.find(employee);
                    if (id && !runtime.busy(identity.employeeNo) && store.deadline(id) <= Date.now()) { await expire(id); id = undefined; }
                    id = store.find(employee) ?? randomUUID();
                    if (!store.bind(id, employee)) throw new Error("conversation ownership mismatch");
                    touch(id);
                    const token = randomUUID();
                    sessions.set(token, { identity, agentSessionId: id, authMethod: manual ? "manual_test" : "dcs_sso" });
                    json(res, 200, { ok: true, token, agentSessionId: id, name: identity.name, employeeNo: identity.employeeNo, department: identity.department ?? "", authMethod: manual ? "manual_test" : "dcs_sso" });
                }
                finally {
                    res.off("close", cancel);
                }
                return;
            }
            if (!route.startsWith("/api/")) {
                json(res, 404, { ok: false });
                return;
            }
            const token = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "")?.[1], session = token ? sessions.get(token) : undefined;
            if (!session) {
                json(res, 401, { ok: false, code: "reauth_required", message: "访问凭据已失效，正在请求DCS重新认证。" });
                return;
            }
            if (session.authMethod === "manual_test" && process.env.DCS_ALLOW_WEB_TEST_IDENTITY !== "true") { sessions.delete(token!); json(res,401,{ok:false,code:"reauth_required",message:"测试身份已关闭。"}); return; }
            if (!store.active(session.agentSessionId) || (!runtime.busy(session.identity.employeeNo) && store.deadline(session.agentSessionId) <= Date.now())) {
                if (store.active(session.agentSessionId)) await expire(session.agentSessionId);
                json(res, 401, {ok:false, code:"reauth_required", message:"Agent会话已过期，本次记录已清理，请重新认证。"}); return;
            }
            if (route !== "/api/ui-action/result") touch(session.agentSessionId);
            if (route === "/api/conversations" && req.method === "GET") {
                json(res, 200, { ok: true, conversations: store.list(session.agentSessionId), recentConversationId: store.recent(session.agentSessionId) });
                return;
            }
            const b = req.method === "GET" ? {} : await body(req);
            if (route === "/api/conversations" && req.method === "POST") {
                const c = store.create(session.agentSessionId);
                json(res, 201, { ok: true, conversation: { id: c.id, title: c.title, messages: [], tools: [] } });
                return;
            }
            const id = typeof b.conversationId === "string" ? b.conversationId : url.searchParams.get("conversationId") ?? "";
            const c = store.get(session.agentSessionId, id);
            if (!c) {
                json(res, 404, { ok: false, message: "对话不存在或不属于当前登录。" });
                return;
            }
            if (route === "/api/conversation" && req.method === "GET") {
                store.select(session.agentSessionId, id);
                json(res, 200, { ok: true, conversation: { id: c.id, title: c.title, messages: c.messages, tools: c.tools, running: !!c.runId } });
                return;
            }
            if (route === "/api/conversation" && req.method === "DELETE") {
                if (c.runId) {
                    json(res, 409, { ok: false, message: "请先停止此会话的回复。" });
                    return;
                }
                json(res, 200, { ok: await runtime.remove(session, id) });
                return;
            }
            if (route === "/api/chat/stop" && req.method === "POST") {
                await runtime.stop(session, id);
                json(res, 200, { ok: true });
                return;
            }
            if (route === "/api/reset") {
                json(res, 410, { ok: false, message: "请使用新建或删除指定对话。" });
                return;
            }
            if (route === "/api/ui-action/result" && req.method === "POST") {
                const result = parseNavigationResult(b.result);
                if (typeof b.requestId !== "string" || !result) {
                    json(res, 400, { ok: false });
                    return;
                }
                const accepted = runtime.result(session, id, b.requestId, result);
                json(res, accepted ? 200 : 404, { ok: accepted });
                return;
            }
            if (route === "/api/chat" && req.method === "POST") {
                const question = typeof b.question === "string" ? b.question.trim() : "";
                if (!question || question.length > 2000) {
                    json(res, 400, { ok: false, message: "问题为空或超过2000字。" });
                    return;
                }
                await runtime.chat(session, c, question, res);
                return;
            }
            json(res, 404, { ok: false });
        })().catch((err) => { log("[web] request failed " + (err instanceof Error ? err.name + " " + (err.stack?.split("\n")[1] ?? "") : "unknown")); if (!res.headersSent)
            json(res, 500, { ok: false, message: "请求或记录保存失败。" });
        else
            res.end(); });
    });
    server.on("close", () => { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); void recovery.then(() => runtime.close()).then(() => { if (!deps.store)
        store.close(); }); });
    return server;
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    if (!process.env.LLM_API_KEY)
        throw new Error("LLM_API_KEY is required");
    const server = createWebServer(), port = Number(process.env.WEB_PORT ?? 8787);
    server.listen(port, () => console.log(`[web] listening on ${port}`));
    process.on("SIGINT", () => { server.closeAllConnections(); server.close(() => void closeDbClient()); });
}
