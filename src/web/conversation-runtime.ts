import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../core/events.ts";
import type { AgentMessage } from "../core/types.ts";
import type { AgentPromptOptions } from "../core/agent.ts";
import { attachRunObserver } from "../observability/observer.ts";
import type { DcsIdentity } from "../dcs/identity.ts";
import type { NavigationResult, RequestNavigation } from "../dcs/navigation-tool.ts";
import { ConversationStore, type Conversation, validContext } from "./conversation-store.ts";
export interface WebSession {
    identity: DcsIdentity;
    agentSessionId: string;
    authMethod: "dcs_sso" | "manual_test";
}
export interface AgentLike {
    context?: AgentMessage[];
    prompt(question: string, options?: AgentPromptOptions): Promise<string>;
    subscribe(fn: (e: AgentEvent) => void): () => void;
}
export type AgentFactory = (identity: DcsIdentity, holder: {
    controller: AbortController;
}, auth: WebSession["authMethod"], nav: RequestNavigation) => AgentLike;
interface Entry {
    agent: AgentLike;
    holder: {
        controller: AbortController;
    };
    key: string;
}
interface Run {
    id: string;
    session: WebSession;
    c: Conversation;
    entry: Entry;
    res: ServerResponse;
    active: boolean;
    toolCallId?: string;
    stop: (message: string, expired?: boolean, reason?: "disconnected" | "timeout") => Promise<void>;
}
interface Pending {
    run: Run;
    resolve: (r: NavigationResult) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}
export function sse(res: ServerResponse, event: Record<string, unknown>) { if (!res.destroyed && !res.writableEnded)
    res.write(`data: ${JSON.stringify(event)}\n\n`); }
export class ConversationRuntime {
    private entries = new Map<string, Entry>();
    private runs = new Map<string, Run>(); // employee-wide lock, including separate DCS logins
    private pending = new Map<string, Pending>();
    private scope = new AsyncLocalStorage<Run>();
    constructor(private store: ConversationStore, private factory: AgentFactory, private opts: {
        budgetMs: number;
        navigationTimeoutMs: number;
        logsDir: string;
        onIdle?: (id: string) => void;
    }) { }
    private key(login: string, id: string) { return `${login}:${id}`; }
    private logDir(login: string, id?: string) { const root = path.join(this.opts.logsDir, "web-logins", createHash("sha256").update(login).digest("hex")); return id ? path.join(root, id) : root; }
    busy(employee: string) { return this.runs.has(employee); }
    busySession(id: string) { return [...this.runs.values()].some(r => r.session.agentSessionId === id); }
    private live(r: Run) { return r.active && this.store.active(r.session.agentSessionId) && !r.entry.holder.controller.signal.aborted && this.entries.get(r.entry.key) === r.entry && this.runs.get(r.session.identity.employeeNo) === r && !r.res.destroyed && !r.res.writableEnded; }
    private navigate(entry: Entry, employee: string, menuName: string): Promise<NavigationResult> {
        const r = this.scope.getStore();
        if (!r || r.entry !== entry || r.session.identity.employeeNo !== employee || !this.live(r))
            return Promise.reject(new Error("原对话运行已结束，导航未执行。"));
        const requestId = `nav-${randomUUID()}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("导航等待超时")); }, this.opts.navigationTimeoutMs);
            this.pending.set(requestId, { run: r, resolve, reject, timer });
            sse(r.res, { type: "ui_action", action: "navigate_dcs_menu", conversationId: r.c.id, runId: r.id, requestId, toolCallId: r.toolCallId, payload: { menuName } });
        });
    }
    result(session: WebSession, conversationId: string, requestId: string, result: NavigationResult) {
        const p = this.pending.get(requestId);
        if (!p || p.run.session !== session || p.run.c.id !== conversationId || !this.live(p.run))
            return false;
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        if (result.status === "needs_selection" && p.run.toolCallId) {
            p.run.c.tools = p.run.c.tools.map(t => t.key === `${p.run.id}:${p.run.toolCallId}` ? { ...t, status: "selection", candidates: result.candidates } : t);
        }
        p.resolve(result);
        return true;
    }
    async revoke(login: string) {
        const stops = [...this.runs.values()].filter(r => r.session.agentSessionId === login).map(r => r.stop("Agent会话已过期，记录已清理。", true));
        for (const [key] of this.entries)
            if (key.startsWith(login + ":"))
                this.entries.delete(key);
        this.store.revoke(login);
        await Promise.all(stops);
        await rm(this.logDir(login), { recursive: true, force: true });
    }
    async remove(session: WebSession, id: string) {
        if (!this.store.delete(session.agentSessionId, id))
            return false;
        this.entries.delete(this.key(session.agentSessionId, id));
        await rm(this.logDir(session.agentSessionId, id), { recursive: true, force: true });
        return true;
    }
    async stop(session: WebSession, id: string) {
        const r = this.runs.get(session.identity.employeeNo);
        if (r && r.session.agentSessionId === session.agentSessionId && r.c.id === id)
            await r.stop("已停止本次回复。");
    }
    async cleanOrphanLogs() {
        for (const login of this.store.knownLogins()) {
            if (!login.valid) {
                await rm(this.logDir(login.id), { recursive: true, force: true });
                continue;
            }
            let children: string[];
            try {
                children = await readdir(this.logDir(login.id));
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT")
                    continue;
                throw e;
            }
            for (const id of children)
                if (/^[a-f0-9-]{36}$/.test(id) && !this.store.get(login.id, id))
                    await rm(this.logDir(login.id, id), { recursive: true, force: true });
        }
    }
    async close() { await Promise.all([...this.runs.values()].map(r => r.stop("服务关闭，本次回复已中断。"))); }
    async chat(session: WebSession, c: Conversation, question: string, res: ServerResponse, pageContext?: { title?: string; path?: string }) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (this.busy(session.identity.employeeNo)) {
            sse(res, { type: "busy", message: "上一问正在处理中，请先停止当前回复。" });
            res.end();
            return;
        }
        if (!this.store.active(session.agentSessionId)) {
            sse(res, { type: "error", code: "login_invalid", message: "Agent会话已过期。" });
            res.end();
            return;
        }
        const key = this.key(session.agentSessionId, c.id);
        let entry = this.entries.get(key);
        if (!entry) {
            const holder = { controller: new AbortController() };
            const created: Entry = { key, holder, agent: null! };
            created.agent = this.factory(session.identity, holder, session.authMethod, (emp, name) => this.navigate(created, emp, name));
            if (!validContext(c.context))
                throw new Error("invalid stored context");
            if (c.context.length && !created.agent.context)
                throw new Error("Agent does not support context restore");
            created.agent.context?.push(...structuredClone(c.context));
            entry = created;
            this.entries.set(key, entry);
        }
        entry.holder.controller = new AbortController();
        const r: Run = { id: randomUUID(), session, c, entry, res, active: true, stop: null! };
        try {
            if (c.runId) {
                c.messages.push({ id: c.runId + ":recovered", role: "assistant", content: "上次回复未完整保存，已恢复到上一完整上下文。" });
                if (!this.store.finish(c, c.runId, false)) throw new Error("write fenced");
            }
            this.store.begin(c, r.id, question); // durably save question BEFORE prompt
        } catch {
            this.entries.delete(key);
            sse(res, { type: "error", code: "save_failed", message: "记录保存失败，本次提问未开始执行。" });
            res.end();
            return;
        }
        this.runs.set(session.identity.employeeNo, r);
        // Content exists only in scope-owned logs; no chat text in the global console.
        const observer = attachRunObserver(entry.agent, { channel: "Web", logsDir: this.logDir(session.agentSessionId, c.id) });
        let messageId = "1", failed = false, awaitingInput = false, ending = false;
        let closing: Promise<void> = Promise.resolve();
        const text = (id: string, value: string, append = false) => {
            const found = c.messages.find(m => m.id === id);
            if (found)
                found.content = append ? found.content + value : value;
            else
                c.messages.push({ id, role: "assistant", content: value });
        };
        const classify = (kind: "process" | "answer" | "selection") => {
            const message = c.messages.find(m => m.id === `${r.id}:${messageId}`);
            if (message) message.kind = kind;
            send({ type: "message_kind", messageId, kind });
        };
        const send = (e: Record<string, unknown>) => sse(res, { ...e, conversationId: c.id, runId: r.id });
        const detach = () => {
            r.active = false;
            unsubscribe();
            clearTimeout(budget);
            observer.detach();
            for (const [id, p] of this.pending)
                if (p.run === r) {
                    clearTimeout(p.timer);
                    this.pending.delete(id);
                    p.reject(new Error("原运行已结束"));
                }
        };
        const release = () => { if (this.runs.get(session.identity.employeeNo) === r)
            this.runs.delete(session.identity.employeeNo); this.opts.onIdle?.(session.agentSessionId); res.end(); };
        r.stop = async (message, expired = false, reason = "disconnected") => {
            if (ending) {
                await closing;
                return;
            }
            ending = true;
            entry!.holder.controller.abort();
            detach();
            this.entries.delete(key);
            if (!expired && this.store.active(session.agentSessionId)) {
                text(`${r.id}:interrupted`, message);
                try {
                    if (!this.store.finish(c, r.id, false))
                        throw new Error("write fenced");
                }
                catch {
                    message = "回复已中断，保存失败；已保存记录将在重开后恢复。";
                }
            }
            send({ type: reason === "timeout" ? "timeout" : "error", code: expired ? "login_invalid" : "interrupted", message });
            closing = observer.end(reason);
            await closing;
            release();
        };
        const unsubscribe = entry.agent.subscribe(e => {
            if (!this.live(r) || ending)
                return;
            if (e.type === "model_call_start")
                messageId = String(e.turn);
            else if (e.type === "message_delta") {
                text(`${r.id}:${messageId}`, e.text, true);
                const kind = c.tools.some(t => t.key.startsWith(r.id + ':')) ? "process" : "answer";
                const message = c.messages.find(m => m.id === `${r.id}:${messageId}`)!;
                message.kind = kind;
                send({ type: "delta", messageId, text: e.text, kind });
            }
            else if (e.type === "assistant_message") {
                const lastTool = c.tools.filter(t => t.key.startsWith(r.id + ':')).at(-1);
                classify(e.message.stopReason === "toolCalls" ? "process" : lastTool?.status === "selection" ? "selection" : "answer");
            }
            else if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
                const start = e.type === "tool_execution_start";
                r.toolCallId = start ? e.toolCallId : undefined;
                const previous = c.tools.find(t => t.key === `${r.id}:${e.toolCallId}`);
                const progressId = `${r.id}:${messageId}`;
                if (start) classify("process");
                const t = { ...previous, messageId: progressId, key: `${r.id}:${e.toolCallId}`, name: e.toolName, status: (start ? "running" : c.tools.find(t => t.key === `${r.id}:${e.toolCallId}`)?.status === "selection" ? "selection" : e.isError ? "error" : "success") as "running" | "error" | "success" | "selection" };
                c.tools = [...c.tools.filter(t => t.key !== `${r.id}:${e.toolCallId}`), t];
                send({ type: "tool_step", status: start ? "start" : "end", messageId, candidates: t.candidates, name: e.toolName, toolCallId: e.toolCallId, isError: !start && e.isError, navigationStatus: t.status === "selection" ? "needs_selection" : undefined });
            }
            else if (e.type === "run_end") {
                failed = e.status === "failed";
                awaitingInput = e.status === "awaiting_input";
            }
            if (e.type === "assistant_message" || e.type === "tool_execution_end") {
                try {
                    if (!this.store.save(c, r.id))
                        void r.stop("保存被拒绝，本次回复已中断。");
                }
                catch {
                    void r.stop("记录保存失败，本次回复已停止。");
                }
            }
        });
        const budget = setTimeout(() => void r.stop("本次查询超时，回复已中断。", false, "timeout"), this.opts.budgetMs);
        res.once("close", () => { if (!ending)
            void r.stop("连接断开，本次回复已中断。"); });
        try {
            const answer = await this.scope.run(r, () => entry!.agent.prompt(question, { requestContext: { pageContext } }));
            if (!this.live(r) || ending)
                return;
            if (failed) {
                await r.stop("本次回复未完整完成；已保留输出，模型上下文恢复到上一完整轮次。");
                return;
            }
            if (!this.live(r) || ending)
                return;
            // Minimal test/channel agents may omit model lifecycle events; keep final separate from tool preamble.
            if (c.tools.some(t => t.messageId === `${r.id}:${messageId}`)) messageId = String(Number(messageId) + 1);
            const previousMessages = structuredClone(c.messages);
            const previousContext = c.context;
            text(`${r.id}:${messageId}`, answer || "本次未生成回复。");
            const finalKind = awaitingInput || c.tools.filter(t => t.key.startsWith(r.id + ':')).at(-1)?.status === "selection" ? "selection" : "answer";
            classify(finalKind);
            try {
                c.context = structuredClone(entry.agent.context ?? []);
                if (!this.store.finish(c, r.id, true)) throw new Error("write fenced");
            } catch (error) {
                // 最终保存失败后，停止路径不能把尚未提交的候选答案保存成正式消息。
                c.messages = previousMessages;
                c.context = previousContext;
                throw error;
            }
            ending = true;
            detach();
            send({ type: "final", messageId, kind: finalKind, status: awaitingInput ? "awaiting_input" : "completed", text: answer || "本次未生成回复。" });
            closing = observer.end("detached");
            await closing;
            release();
        }
        catch {
            if (!ending)
                await r.stop("处理或保存失败，回复已中断。");
        }
    }
}
