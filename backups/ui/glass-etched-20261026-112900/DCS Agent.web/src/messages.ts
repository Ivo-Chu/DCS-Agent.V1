import type { ChatEvent } from "./api";
import type { Tool } from "./tool-progress";
export interface StoreMessage { id: string; role: "user" | "assistant"; content: string; kind?: "process" | "answer" | "selection"; steps?: {text?: string; tool?: Tool}[]; candidates?: {title:string;path:string}[] }
/** 每个模型轮次独立更新；final 不覆盖工具前的其他轮次文本。 */
export function applyTextEvent(messages: StoreMessage[], prefix: string, event: ChatEvent): StoreMessage[] {
  if (event.type === "message_kind") return messages.map(m => m.id === prefix + ':' + event.messageId ? { ...m, kind: event.kind } : m);
  if (event.type !== "delta" && event.type !== "final" && event.type !== "error" && event.type !== "timeout" && event.type !== "busy") return messages;
  const failed = event.type === "error" || event.type === "timeout" || event.type === "busy";
  const id = failed ? `${prefix}:error` : `${prefix}:${"messageId" in event ? event.messageId ?? "1" : "1"}`;
  const text = "text" in event ? event.text : event.message;
  const existing = messages.find(m => m.id === id);
  const kind = "kind" in event ? event.kind : existing?.kind;
  const content = event.type === "delta" ? (existing?.content ?? "") + text : text;
  // 首个空占位在首次实际文本到达时移除，避免工具先行时留下空气泡。
  const next = messages.filter(m => m.id !== `${prefix}:placeholder`);
  return existing ? next.map(m => m.id === id ? { ...m, content, kind } : m) : [...next, { id, role: "assistant", content, kind }];
}

/** Build one process block per user request; stored messages and model context stay unchanged. */
export function displayMessages(messages: StoreMessage[], tools: Tool[]): StoreMessage[] {
  const prefix = (id: string) => id.slice(0, id.lastIndexOf(':'));
  const output: StoreMessage[] = [];
  const runs = new Map<string, StoreMessage[]>();
  for (const m of messages) { const key = prefix(m.id); if (!runs.has(key)) runs.set(key, []); runs.get(key)!.push(m); }
  for (const [run, batch] of runs) {
    const runTools = tools.filter(t => t.messageId && prefix(t.messageId) === run);
    const steps: {text?: string; tool?: Tool; turn: number; order: number}[] = [];
    for (const m of batch) if (m.kind === 'process' && m.content) steps.push({text: m.content, turn: Number(m.id.slice(run.length + 1)) || 0, order: 0});
    runTools.forEach((tool, i) => steps.push({tool, turn: Number(tool.messageId!.slice(run.length + 1)) || 0, order: i + 1}));
    steps.sort((a, b) => a.turn - b.turn || a.order - b.order);
    output.push(...batch.filter(m => m.role === 'user'));
    if (steps.length) output.push({id: run + ':process-view', role:'assistant', content:'处理过程', kind:'process', steps});
    const candidates = runTools.filter(t => t.status === 'selection').flatMap(t => t.candidates ?? []);
    output.push(...batch.filter(m => m.role !== 'user' && m.kind !== 'process' &&
      !(m.kind === 'selection' && candidates.length) &&
      !(m.id === run + ':process' && !m.content && runTools.length)));
    if (candidates.length) output.push({id:run + ':selection-view',role:'assistant',content:'请选择要打开的菜单',kind:'selection',candidates});
  }
  return output;
}
