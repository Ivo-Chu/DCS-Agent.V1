import { useEffect, useState } from "react";
import "./log-viewer.css";

type RecordValue = Record<string, any>;
interface Run { file: string; runId: string; timestamp: string; question: string; reason: string; turns: number; model: string; channel: string }
const pretty = (value: unknown) => value == null ? "未记录" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const reason = (value: string) => ({ completed: "已完成", max_turns: "达到轮次上限", model_error: "模型失败", timeout: "超时", disconnected: "连接断开", unexpected: "异常" }[value] ?? value);
async function get(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? "读取日志失败");
    return body;
}
function Block({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
    const [message, setMessage] = useState("");
    return <details className="log-block" open={open}><summary>{title}</summary><button className="log-copy" onClick={async () => {
        try { await navigator.clipboard.writeText(pretty(value)); setMessage("已复制"); }
        catch { setMessage("复制失败，请选中文本复制"); }
    }}>复制</button><span role="status">{message}</span><pre>{pretty(value)}</pre></details>;
}
export default function LogViewer() {
    const [runs, setRuns] = useState<Run[]>([]);
    const [selected, setSelected] = useState("");
    const [revision, setRevision] = useState(0);
    const [records, setRecords] = useState<RecordValue[]>([]);
    const [listError, setListError] = useState("");
    const [detailError, setDetailError] = useState("");
    const [loading, setLoading] = useState(false);
    const [skipped, setSkipped] = useState(0);
    useEffect(() => {
        document.title = "DCS Agent · 运行日志";
        const controller = new AbortController();
        setListError("");
        get("/api/logs", controller.signal).then(data => {
            setRuns(data.runs);
            setSelected(current => data.runs.some((r: Run) => r.file === current) ? current : data.runs[0]?.file ?? "");
        }).catch(e => { if (!controller.signal.aborted) setListError(e.message); });
        return () => controller.abort();
    }, [revision]);
    useEffect(() => {
        const controller = new AbortController();
        setRecords([]); setDetailError(""); setSkipped(0); setLoading(!!selected);
        if (selected) get(`/api/log?file=${encodeURIComponent(selected)}`, controller.signal).then(data => {
            setRecords(data.records); setSkipped(data.skippedLines);
        }).catch(e => { if (!controller.signal.aborted) setDetailError(e.message); }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [selected, revision]);
    const run = runs.find(r => r.file === selected);
    const starts = records.filter(r => r.event === "model_call_start");
    const end = records.find(r => r.event === "run_end");
    return <div className="log-viewer"><header><div><small>DCS AGENT / DEVELOPER</small><h1>运行日志</h1><p>逐轮查看模型输入、输出和工具执行</p></div><button onClick={() => setRevision(v => v + 1)}>刷新日志</button></header>
        {listError && <p role="alert" className="log-error">{listError}</p>}
        <div className="log-layout"><aside aria-label="运行记录"><h2>运行记录 <small>{runs.length}</small></h2>{!runs.length && <p>暂无已落盘日志</p>}{runs.map(r => <button className={selected === r.file ? "selected" : ""} key={r.file} onClick={() => setSelected(r.file)}><small>{r.timestamp ? new Date(r.timestamp).toLocaleString() : "时间未记录"} · {r.channel}</small><strong>{r.question}</strong><span>{reason(r.reason)} · {r.turns} 轮</span></button>)}</aside>
        <main>{run ? <><h2>{run.question}</h2><p className="log-meta">{run.model} · {reason(end?.reason ?? run.reason)} · {end?.elapsedMs != null ? `${end.elapsedMs} ms` : "耗时未记录"}</p><p className="log-id">Run {run.runId}</p><p className="log-hint">展示已落盘内容；运行中可能延迟。Web 日志沿用会话过期清理规则。</p>
            {loading && <p role="status">正在读取…</p>}{detailError && <p role="alert" className="log-error">{detailError}</p>}{skipped > 0 && <p className="log-error">有 {skipped} 行不完整或无法解析，其余内容正常展示。</p>}
            {!loading && !detailError && !starts.length && <p>尚无模型调用记录。</p>}
            {starts.map((start, index) => {
                const finish = records.find(r => r.event === "model_call_end" && r.turn === start.turn);
                const tools = records.filter(r => r.event === "tool_start" && r.turn === start.turn);
                const messages: RecordValue[] = Array.isArray(start.contextMessages) ? start.contextMessages : [];
                const previousCount = index > 0 ? starts[index - 1].messageCount : messages.length;
                return <details className="log-loop" key={`${selected}-${start.turn}`} open={index === 0}><summary><strong>Loop {start.turn}</strong><span>{finish ? `${finish.durationMs} ms · ${finish.stopReason}` : "尚无结束记录"}</span></summary>
                    <p className="log-meta">输入 Token：{finish?.inputTokens ?? "未提供"} / 输出 Token：{finish?.outputTokens ?? "未提供"}</p>
                    <Block title="System Prompt" value={start.systemPromptText} />
                    <Block title={`可用工具（${start.toolSchemaCount ?? "?"}）`} value={start.toolSchemas} />
                    <details className="log-block" open><summary>Context · {messages.length} 条消息</summary>{start.contextMessages == null ? <p>未记录</p> : messages.map((m, i) => <Block key={i} title={`${String(i + 1).padStart(2, "0")} · ${m.role}${m.toolName ? ` / ${m.toolName}` : ""}${index > 0 && i >= previousCount ? " · 本轮新增" : ""}${m.truncated ? " · 旧日志已截断" : ""}`} value={m} open={index > 0 && i >= previousCount} />)}</details>
                    <Block title="模型输出（文本与工具调用）" value={finish?.output} open />
                    {finish?.errorMessage && <Block title="模型错误" value={finish.errorMessage} open />}
                    {tools.map(tool => {
                        const result = records.find(r => r.event === "tool_end" && r.toolCallId === tool.toolCallId);
                        return <details className="log-block" key={tool.toolCallId} open><summary>工具 · {tool.tool} · {result ? result.isError ? "失败" : "成功" : "尚无结束记录"} {result?.durationMs != null ? `· ${result.durationMs} ms` : ""}</summary><p className="log-id">{tool.toolCallId}</p><Block title="参数" value={tool.args} open /><Block title={`返回模型的结果${result?.resultTruncated ? "（旧日志已截断）" : ""}`} value={result?.resultText ?? result?.resultSummary} open />{result?.resultChanged && <Block title="处理前原始结果" value={result.rawResult} />}{result?.truncated && <p>工具自身标记结果已裁剪。</p>}</details>;
                    })}
                </details>;
            })}</> : <p>选择一次运行，查看每轮 Loop 的详细记录。</p>}</main></div></div>;
}
