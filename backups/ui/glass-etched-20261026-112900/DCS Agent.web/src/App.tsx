import { GlassSurface } from "./GlassSurface";
import "./liquid-glass.css";
import { AssistantRuntimeProvider, ThreadPrimitive, ComposerPrimitive, MessagePrimitive, useExternalStoreRuntime, useAuiState } from "@assistant-ui/react";
import Markdown from "react-markdown";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { loginSso, postNavigationResult, streamChat, type ChatEvent } from "./api";
import { waitForNavigation } from "./navigation";
import { requestLoginMaterial } from "./parent-auth";
import { applyTextEvent, displayMessages, type StoreMessage } from "./messages";
import { applyToolEvent, toolLabel, type Tool } from "./tool-progress";
const DCS_CLOUD_PATH = "M24 72C5 72 4 46 23 42C20 24 40 17 51 30C58 3 95 9 97 38C118 41 119 69 100 72";
interface Conversation {
    id: string;
    title: string;
    messages: StoreMessage[];
    tools: Tool[];
    running?: boolean;
}
const UserMessage = () => <MessagePrimitive.Root className="message user"><div className="bubble"><MessagePrimitive.Content /></div></MessagePrimitive.Root>;
const ProgressContext = createContext<{messages: StoreMessage[]; activeRun: string; disabled: boolean; choose: (path: string) => void}>({ messages: [], activeRun: '', disabled: true, choose() {} });
function ProcessBlock({ message, active }: {message: StoreMessage; active: boolean}) {
    const [open, setOpen] = useState(active);
    useEffect(() => setOpen(active), [active]);
    return <details className="tool-progress process-block" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>{active ? '处理中' : '处理完成'}<span className="step-count">{message.steps?.length ?? 0} 个步骤</span></summary>
      <div className="tool-steps" aria-live="polite">{message.steps?.map((step, i) => step.tool ?
        <div key={i} className={'tool-step ' + step.tool.status}><span className={step.tool.status === 'running' ? 'progress-spinner' : 'progress-icon ' + step.tool.status} aria-hidden="true">{step.tool.status === 'error' ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93 19.07 19.07M19.07 4.93 4.93 19.07"/></svg> : step.tool.status === 'success' ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg> : ''}</span>{toolLabel(step.tool)}</div> :
        <div key={i} className="process-note"><Markdown>{step.text}</Markdown></div>)}</div>
    </details>;
}
function AssistantMessage() {
    const id = useAuiState(s => s.message.id);
    const {messages, activeRun, disabled, choose} = useContext(ProgressContext);
    const message = messages.find(m => m.id === id);
    if (message?.kind === 'process') return <MessagePrimitive.Root className="message assistant"><ProcessBlock message={message} active={id === activeRun + ':process-view'}/></MessagePrimitive.Root>;
    return <MessagePrimitive.Root className="message assistant"><div className="bubble">{message?.candidates?.length ?
      <div className="menu-options"><span>请选择要打开的菜单</span>{message.candidates.map(c => <button key={c.path} disabled={disabled} onClick={() => choose(c.path)}><strong>{c.title || c.path.split(/\s*\/\s*/).slice(-1)[0]}</strong><small>{c.path.split(/\s*\/\s*/).slice(0, -1).join(" / ")}</small></button>)}</div> : <Markdown>{message?.content ?? ""}</Markdown>}</div></MessagePrimitive.Root>;
}
const messageComponents = { UserMessage, AssistantMessage };
function parentOrigin() { try {
    return new URL(document.referrer).origin;
}
catch {
    return null;
} }
export default function App() {
    const [messages, setMessages] = useState<StoreMessage[]>([]), [tools, setTools] = useState<Tool[]>([]);
    const [list, setList] = useState<{
        id: string;
        title: string;
    }[]>([]), [current, setCurrent] = useState<Conversation | null>(null);
    const [running, setRunning] = useState(false), [loading, setLoading] = useState(true), [notice, setNotice] = useState("");
    const [panel, setPanel] = useState(false), [paused, setPaused] = useState(false), [invalid, setInvalid] = useState(false);
    const activeConversation = useRef<Conversation | null>(null);
    const [generatingId, setGeneratingId] = useState("");
    const token = useRef(""), mounted = useRef(false), selected = useRef(""), epoch = useRef(0);
    const chat = useRef<AbortController | null>(null), pendingChat = useRef<Promise<void> | null>(null), login = useRef<AbortController | null>(null), authBusy = useRef(false), managementBusy = useRef(false);
    const [initialCode] = useState(() => new URLSearchParams(location.search).get("_code"));
    function clearLogin() { activeConversation.current = null; setGeneratingId(""); epoch.current++; login.current?.abort(); chat.current?.abort(); token.current = ""; selected.current = ""; setList([]); setCurrent(null); setMessages([]); setTools([]); setRunning(false); setInvalid(true); setPaused(true); setNotice("无法识别DCS登录，请重新登录DCS后打开助手。"); }
    async function api(route: string, method = "GET", data?: unknown): Promise<any> {
        const requestEpoch = epoch.current;
        const response = await fetch(route, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.current}` }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        const result = await response.json();
        if (!mounted.current || requestEpoch !== epoch.current)
            throw new Error("请求已取消。");
        if (!response.ok) {
            if (result.code === "login_invalid") {
                if (mounted.current)
                    clearLogin();
            }
            else if (result.code === "reauth_required") {
                if (mounted.current)
                    void authenticate();
            }
            throw new Error(result.message ?? "请求失败，请稍后重试。");
        }
        return result;
    }
    async function refreshList() { const result = await api("/api/conversations"); if (mounted.current)
        setList(result.conversations); return result; }
    function display(c: Conversation) { c = activeConversation.current?.id === c.id ? activeConversation.current : c; selected.current = c.id; setCurrent(c); setMessages(c.messages); setTools(c.tools); setPanel(false); }
    async function restore() {
        const result = await refreshList();
        let id = result.recentConversationId ?? result.conversations[0]?.id;
        if (!id) {
            const created = await api("/api/conversations", "POST", {});
            id = created.conversation.id;
            await refreshList();
        }
        const loaded = await api(`/api/conversation?conversationId=${encodeURIComponent(id)}`);
        if (mounted.current)
            display(loaded.conversation);
    }
    async function authenticate(code?: string) {
        if (authBusy.current)
            return;
        authBusy.current = true;

        epoch.current++;
        activeConversation.current = null; setGeneratingId("");
        chat.current?.abort();
        chat.current = null;
        setRunning(false);
        const controller = new AbortController();
        login.current = controller;
        setLoading(true);
        setNotice("");
        setList([]); setCurrent(null); setMessages([]); setTools([]); selected.current = ""; token.current = "";
        try {
            const material = code ?? await requestLoginMaterial(controller.signal);
            const result = await loginSso(material, { signal: controller.signal, timeoutMs: Number(import.meta.env.VITE_SSO_TIMEOUT_MS ?? 15000) });
            if (controller.signal.aborted || !mounted.current)
                return;
            if (!result.ok) {
                if (result.code === "login_invalid")
                    clearLogin();
                throw new Error(result.message);
            }
            epoch.current++;
            token.current = result.token;
            setInvalid(false);
            setPaused(false);
            await restore();
        }
        catch (e) {
            if (!controller.signal.aborted && mounted.current) {
                if ((e as Error).message === "login_invalid")
                    clearLogin();
                else {
                    setPaused(true);
                    setNotice((e as Error).message);
                }
            }
        }
        finally {
            if (login.current === controller) {
                authBusy.current = false;
                if (mounted.current && !controller.signal.aborted)
                    setLoading(false);
            }
        }
    }
    async function stop() {
        if (!chat.current || !activeConversation.current)
            return;
        try {
            await api("/api/chat/stop", "POST", { conversationId: activeConversation.current.id });
        }
        catch (e) {
            if (mounted.current)
                setNotice((e as Error).message);
        }
        finally {
            chat.current?.abort();
            await pendingChat.current;
        }
    }
    async function manage(action: () => Promise<void>) {
        if (managementBusy.current)
            return;
        managementBusy.current = true;
        const generation = epoch.current;
        try {
            await action();
            if (epoch.current === generation)
                setNotice("");
        }
        catch (e) {
            if (mounted.current && epoch.current === generation)
                setNotice((e as Error).message);
        }
        finally {
            managementBusy.current = false;
        }
    }
    async function onNew(message: {
        content: unknown;
    }) {
        const content = Array.isArray(message.content) ? message.content.filter(p => p?.type === "text").map(p => p.text).join("") : String(message.content ?? "");
        if (!content.trim() || !token.current || !selected.current || chat.current || managementBusy.current || paused || loading)
            return;
        const id = selected.current, generation = epoch.current, prefix = crypto.randomUUID(), controller = new AbortController(), navController = new AbortController();
        chat.current = controller;
        controller.signal.addEventListener("abort", () => navController.abort(), { once: true });
        const live = () => mounted.current && epoch.current === generation && chat.current === controller;
        setRunning(true);
        setNotice("");
        const generating: Conversation = { ...current!, id, messages: [...messages, { id: `${prefix}:user`, role: "user", content }], tools: [...tools] };
        activeConversation.current = generating; setGeneratingId(id);
        const showProgress = () => {
            if (live() && selected.current === id) { setMessages(generating.messages); setTools(generating.tools); }
        };
        showProgress();
        const tasks: Promise<void>[] = [];
        const handler = (e: ChatEvent) => {
            if (!live() || ("conversationId" in e && e.conversationId && e.conversationId !== id))
                return;
            if (e.type === "error" && e.code === "login_invalid") {
                clearLogin();
                return;
            }
            if (e.type === "error" && e.code === "reauth_required") {
                void authenticate();
                return;
            }
            if (e.type === "error" || e.type === "timeout") setNotice(e.message);
            generating.messages = applyTextEvent(generating.messages, prefix, e);
            if (e.type === "tool_step") {
                generating.tools = applyToolEvent(generating.tools, prefix, e);

            }
            showProgress();
            if (e.type === "ui_action")
                tasks.push((async () => {
                    const result = await waitForNavigation(e.requestId, e.payload.menuName, parentOrigin(), navController.signal);
                    if (!live() || navController.signal.aborted)
                        return;
                    try {
                        await postNavigationResult(token.current, e.requestId, result, navController.signal, id);
                    }
                    catch {
                        if (live() && !navController.signal.aborted)
                            setNotice("菜单打开结果回传失败，请重试。");
                    }
                })());
        };
        const promise = (async () => {
            try {
                await streamChat(token.current, content, handler, controller.signal, id);
            }
            finally {
                navController.abort();
                await Promise.all(tasks);
                if (live()) {
                    setRunning(false);
                    generating.tools = generating.tools.map(t => t.status === "running" ? { ...t, status: "error" } : t);
                    showProgress(); activeConversation.current = null; setGeneratingId("");
                    try {
                        if (selected.current === id) {
                            const data = await api(`/api/conversation?conversationId=${encodeURIComponent(id)}`);
                            if (live() && selected.current === id) display(data.conversation);
                        }
                        await refreshList();
                    }
                    catch (e) {
                        if (mounted.current && epoch.current === generation)
                            setNotice((e as Error).message);
                    }
                    finally {
                        if (chat.current === controller)
                            chat.current = null;
                    }
                }
            }
        })();
        pendingChat.current = promise;
        await promise;
    }
    const visibleMessages = displayMessages(messages, tools);
    const viewingRun = running && generatingId === current?.id;
    const activeRun = viewingRun ? messages.filter(m => m.role === "user").slice(-1)[0]?.id.replace(/:user$/, "") ?? "" : "";
    const runtime = useExternalStoreRuntime({ messages: visibleMessages, isRunning: viewingRun, onNew, onCancel: () => stop(), convertMessage: (m: StoreMessage) => ({ id: m.id, role: m.role, content: m.content }) });
    useEffect(() => {
        mounted.current = true;
        const url = new URL(location.href);
        url.searchParams.delete("_code");
        history.replaceState(null, "", url);
        void authenticate(initialCode ?? undefined);
        return () => { mounted.current = false; epoch.current++; authBusy.current = false; login.current?.abort(); chat.current?.abort();  };
    }, []);
    return <AssistantRuntimeProvider runtime={runtime}><ProgressContext.Provider value={{ messages: visibleMessages, activeRun, disabled: running || loading || paused || invalid, choose: path => void onNew({ content: path }) }}><div className="app">
    <header className="header"><nav className="header-actions" aria-label="会话操作"><button className="header-icon" aria-label="会话" title="会话" aria-expanded={panel} disabled={loading || paused} onClick={() => setPanel(!panel)}><svg width="20" height="20" viewBox="0 0 120 90" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DCS_CLOUD_PATH + "Z"}/></svg></button></nav><strong className="header-title">DCS Agent</strong><nav className="header-actions header-right" aria-label="助手操作">
      <button className="header-icon" aria-label="关闭助手" title="关闭助手" disabled={window.parent === window} onClick={() => { const origin = parentOrigin(); if (origin) window.parent.postMessage({ type: "dcs_agent_close" }, origin); }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></nav></header>
    {panel && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="收起会话列表" onClick={() => setPanel(false)}/><aside className="conversation-panel" aria-label="会话列表"><div className="drawer-heading"><strong>会话</strong></div><div className="conversation-items">{list.map(c => <div key={c.id}><button onClick={() => void manage(async () => { const r = await api(`/api/conversation?conversationId=${encodeURIComponent(c.id)}`); display(r.conversation); })}>{c.id === current?.id ? "● " : ""}{c.title}{c.id === generatingId ? " · 生成中" : ""}</button>
      <button className="delete-conversation" disabled={c.id === generatingId} title="删除会话" aria-label={`删除 ${c.title}`} onClick={() => void manage(async () => { await api("/api/conversation", "DELETE", { conversationId: c.id }); if (c.id === selected.current)
                await restore();
            else
                await refreshList(); })}>×</button></div>)}</div><button className="new-conversation" aria-label="新建会话" title="新建会话" disabled={loading || paused} onClick={() => void manage(async () => { const r = await api("/api/conversations", "POST", {}); display(r.conversation); await refreshList(); })}>＋ 新建会话</button></aside></div>}
    {(loading || notice) && <div className="session-notice" role="status">{loading ? "正在识别身份并恢复对话…" : notice}{!loading && !invalid && paused && <button onClick={() => void authenticate()}>重新连接</button>}</div>}
    <ThreadPrimitive.Root key={current?.id} className="thread"><ThreadPrimitive.Viewport className="thread-viewport" scrollToBottomOnRunStart={false}>{!loading && !paused && !invalid && visibleMessages.length === 0 && <div className="empty-state"><div className="empty-brand"><svg className="empty-logo" width="120" height="90" viewBox="0 0 120 90" role="img" aria-label="DCS"><defs><linearGradient id="empty-logo-color" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#76a7f5"/><stop offset="1" stopColor="#93d4e9"/></linearGradient></defs><path d={DCS_CLOUD_PATH} fill="none" stroke="url(#empty-logo-color)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/><text x="60" y="63" textAnchor="middle" fill="#86aee8" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="30">DCS</text></svg></div><p>从理解走向解决</p></div>}<ThreadPrimitive.Messages components={messageComponents}/></ThreadPrimitive.Viewport><ThreadPrimitive.ScrollToBottom className="back-to-latest" behavior="smooth" aria-label="回到最新" title="回到最新"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg></ThreadPrimitive.ScrollToBottom></ThreadPrimitive.Root>
    <ComposerPrimitive.Root className="composer"><GlassSurface radius={14}/><ComposerPrimitive.Input className="composer-input" placeholder={running && !viewingRun ? "另一会话正在生成回复，请等待完成或返回该会话停止。" : ""} minRows={1} maxRows={6} submitMode="enter" disabled={loading || paused || invalid || (running && !viewingRun)} aria-label="消息输入"/>
      {viewingRun ? <ComposerPrimitive.Cancel className="composer-send" aria-label="停止" title="停止"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></ComposerPrimitive.Cancel> : <button type="submit" disabled={running || loading || paused || invalid} className="composer-send" aria-label="发送" title="发送"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>}</ComposerPrimitive.Root>
  </div></ProgressContext.Provider></AssistantRuntimeProvider>;
}
