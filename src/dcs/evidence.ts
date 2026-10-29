import { statSync } from "node:fs";
import path from "node:path";
import type { AgentMessage, RunFinish, RunPolicy, ToolCall, ToolResultMessage, ToolSchema } from "../core/types.ts";
import { sourceRoot } from "./read-path.ts";
import { fileKind } from "./source-tools.ts";
import { clarificationQuestion } from "./clarification-tool.ts";
import { parseNavigationResult } from "./navigation-tool.ts";
import type { SourceEntry } from "./source-map.ts";
import { maskPii } from "./hooks.ts";

const NO_CONTENT = "本次未能取得可核实的源码内容，暂时无法确认该功能的实际规则。";
const RETRY = "本次尚未取得可核实的源码内容。文件路径和业务索引不等于源码证据。请继续搜索或读取实际源码；无法取得时不得编造业务结论。";
const NO_EVIDENCE = "本次未能取得可核实的资料或查询结果，暂时无法确认该问题。";
const RETRY_EVIDENCE = "本次尚未取得可核实的业务依据。文件路径、业务索引和表结构只是定位线索。请根据问题检索原文、读取实际源码或执行已授权查询；目标确实不明确时可请求补充，无法取得依据时不得编造业务结论。";

/** Accept only the successful feature tool's validated-map contract, never a model assertion. */
function isVerifiedMapEntry(value: unknown): value is SourceEntry {
  const entry = value as SourceEntry | null;
  if (!entry || ![entry.name, entry.page, entry.controller, entry.action].every(v => typeof v === "string" && !!v.trim()) ||
      !Array.isArray(entry.aliases) || !entry.aliases.every(v => typeof v === "string" && !!v.trim()) ||
      entry.verification?.status !== "verified" || typeof entry.verification.basis !== "string" || !entry.verification.basis.trim() ||
      typeof entry.verification.checkedAt !== "string" || !Number.isFinite(Date.parse(entry.verification.checkedAt)) ||
      !Array.isArray(entry.references) || !entry.references.length) return false;
  const roles = ["route", "controller", "view", "implementation"];
  return ["route", "controller", "view"].every(role => entry.references.some(ref => ref?.role === role)) && entry.references.every(ref =>
    ref && typeof ref.path === "string" && !!ref.path.trim() && !path.isAbsolute(ref.path) && !path.win32.isAbsolute(ref.path) &&
    !ref.path.split(/[\\/]/).includes("..") && roles.includes(ref.role) && /^[a-f0-9]{64}$/.test(ref.sha256) &&
    Number.isSafeInteger(ref.startLine) && ref.startLine >= 1 && Number.isSafeInteger(ref.endLine) && ref.endLine >= ref.startLine);
}

interface SourceContent { toolCallId: string; path: string; line: number }
interface DocumentEvidence { toolCallId: string; title: string; section?: string; page?: string; content: string }
interface DataEvidence {
  toolCallId: string; queryToolCallId: string; sql: string; bindNames: string[];
  columns: string[]; fetchedRows: number; complete: boolean; visibleRows: number;
  previewTruncated: boolean; resultFile?: string; select?: unknown[]; hasMore?: boolean;
}
export interface EvidenceRunOptions {
  defaultEvidence?: boolean;
  history?: readonly AgentMessage[];
  availableToolNames?: string[];
  pageContext?: { title?: string; path?: string };
  /** Only entries already verified against the current source tree by the DCS caller. */
  verifiedTargets?: SourceEntry[];
  indexState?: Record<string, unknown>;
}

/** Whole-message exceptions only. Unknown or mixed input always takes the evidence path. */
function isEvidenceExempt(text: string, history: readonly AgentMessage[]): boolean {
  const plain = text.trim().replace(/[。！!？?.,，~～]+$/u, "").trim();
  if (/^(?:你好|您好|嗨|早上好|晚上好|谢谢|谢谢你|感谢|多谢|好的谢谢|再见|拜拜|不用了|结束|hello|hi)$/iu.test(plain)) return true;
  const hasAnswer = history.some(m => m.role === "assistant" && m.stopReason === "stop" && !!m.content.trim() && !m.toolCalls?.length);
  return hasAnswer && /^(?:请)?(?:再(?:简短|简单|精简)(?:一点|点)|(?:简短|简单|精简)一点|(?:把(?:上面|刚才)的回答)?(?:改成|整理成|转成)(?:表格|列表|要点)|用(?:表格|列表|要点)(?:表示|展示))$/u.test(plain);
}

/** Each call owns its state; legacy callers opt in explicitly, Web callers set defaultEvidence. */
export function prepareEvidenceRun(text: string, tools: ToolSchema[], options: EvidenceRunOptions = {}): { text: string; policy?: RunPolicy } {
  const input = text.trimStart();
  const sourceOnly = /^\/查源码(?:\s|$)/u.test(input);
  if (!sourceOnly && (!options.defaultEvidence || isEvidenceExempt(text, options.history ?? []))) return { text };
  const question = sourceOnly ? input.slice("/查源码".length).trim() : text;
  let sourceAvailable = false;
  try { sourceAvailable = statSync(sourceRoot()).isDirectory(); } catch { /* No source files can be read. */ }
  const allToolNames = tools.filter(t => options.availableToolNames === undefined || options.availableToolNames.includes(t.name)).map(t => t.name);
  const sourceToolNames = sourceAvailable ? allToolNames.filter(name => name === "search_dcs_code" || name === "read_dcs_code") : [];
  const requiredToolNames = sourceOnly ? sourceToolNames : allToolNames;
  const targets = structuredClone(options.verifiedTargets ?? []);
  const discoveredMapCandidates: Array<{ toolCallId: string; indexVersion: unknown; indexSha256: unknown; candidates: unknown[] }> = [];
  const normalizedPath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  function sourceRelations() {
    return sources.map(source => {
      const candidates = targets.flatMap((target, candidateIndex) => {
        const references = target.references.filter(ref => ref.role !== "route" && normalizedPath(ref.path) === normalizedPath(source.path));
        if (!references.length) return [];
        const direct = references.filter(ref => source.line >= ref.startLine && source.line <= ref.endLine);
        return [{ candidateIndex, name: target.name, page: target.page,
          relation: direct.length ? "direct_reference" : "mapped_file_outside_reference",
          references: direct.length ? direct : references }];
      });
      return { ...source, relation: candidates.some(c => c.relation === "direct_reference") ? "direct_reference" : "unconfirmed", candidates };
    });
  }
  const targetSourceObtained = () => sourceRelations().some(s => s.relation === "direct_reference");
  const sources: SourceContent[] = [];
  const seenSources = new Set<string>();
  const documentEvidence: DocumentEvidence[] = [];
  const dataEvidence: DataEvidence[] = [];
  const queryFiles = new Map<string, DataEvidence>();
  const navigationResults: Array<{ toolCallId: string; status: string; candidates?: { title: string; path: string }[] }> = [];
  let firstTurn = true;
  let sourceContentObtained = false;
  let remediationUsed = false;
  let remediationPending = false;
  let remediationTurn = false;
  let terminal: RunFinish | undefined;
  let navigationCompletion: RunFinish | undefined;
  let awaitingInput = false;
  const hasEvidence = () => (sourceContentObtained && (!targets.length || targetSourceObtained())) ||
    (!sourceOnly && (documentEvidence.length > 0 || dataEvidence.length > 0));
  const unavailable = (reason = sourceOnly ? "source_content_unavailable" : "evidence_unavailable"): RunFinish => ({ text: sourceOnly ? NO_CONTENT : NO_EVIDENCE, reason });

  function recordSource(call: ToolCall, path: unknown, line: unknown, content: unknown) {
    if (typeof path !== "string" || !path.trim() || fileKind(path) !== "source" ||
        !Number.isSafeInteger(line) || Number(line) < 1 || typeof content !== "string" || !content.trim()) return;
    const item = { toolCallId: call.id, path, line: Number(line) };
    const key = JSON.stringify(item);
    if (!seenSources.has(key)) { seenSources.add(key); sources.push(item); }
    sourceContentObtained = true;
  }

  function onToolResult(call: ToolCall, result: ToolResultMessage) {
    // Only the post-hook message really supplied to this Run may count.
    if (result.isError || result.toolCallId !== call.id || result.toolName !== call.name || !allToolNames.includes(call.name)) return;
    if (call.name === "search_dcs_knowledge" && !sourceOnly) {
      // Reuse the existing knowledge tool's rendered chunk contract, not model prose.
      let query: unknown;
      try { query = JSON.parse(call.arguments)?.query; } catch { return; }
      if (typeof query !== "string") return;
      // Match the rendered header after the same existing DCS result hook; do not reject real
      // snippets merely because a phone number or credential in the echoed query was masked.
      const prefix = maskPii(`知识库检索「${query.trim().slice(0, 80)}」：返回 `);
      if (!result.content.startsWith(prefix)) return;
      const bodyWithCount = result.content.slice(prefix.length);
      const header = bodyWithCount.match(/^[1-9]\d* 个片段（按相关性排序）。\r?\n/);
      if (!header) return;
      // The query echo is excluded: a failed lookup containing a forged snippet is not evidence.
      const chunks = bodyWithCount.slice(header[0].length);
      for (const match of chunks.matchAll(/^\[\d+\] 文档：《([^\r\n]+)》\r?\n([\s\S]*?)(?=^\[\d+\] 文档：|^（其余 |^回答时请基于|$(?![\s\S]))/gm)) {
        const body = match[2], original = body.match(/^原文：([\s\S]+)/m)?.[1]?.trim();
        if (original) documentEvidence.push({ toolCallId: call.id, title: match[1],
          section: body.match(/^章节：(.+)$/m)?.[1], page: body.match(/^页码：(.+)$/m)?.[1], content: original });
      }
      return;
    }
    let data: any, args: any;
    try { data = JSON.parse(result.content); args = JSON.parse(call.arguments); } catch { return; }
    if (!data || typeof data !== "object" || !args || typeof args !== "object") return;
    if (call.name === "read_dcs_code" && sourceToolNames.includes(call.name) && Array.isArray(data.files)) {
      for (const file of data.files) {
        if (file?.status !== "success" || !Array.isArray(file.lines)) continue;
        for (const line of file.lines) recordSource(call, file.path, line?.line, line?.text);
      }
    } else if (call.name === "search_dcs_code" && sourceToolNames.includes(call.name) && data.status === "success" && Array.isArray(data.items)) {
      if (args.mode === "feature") {
        // The real feature tool already verifies paths, source hashes and line ranges. Keep that
        // provenance after result hooks; incomplete or discarded results cannot create a target.
        discoveredMapCandidates.push({ toolCallId: call.id, indexVersion: data.indexVersion,
          indexSha256: data.indexSha256, candidates: structuredClone(data.items) });
        if (data.indexVersion === 1 && typeof data.indexSha256 === "string" && /^[a-f0-9]{64}$/.test(data.indexSha256)) {
          for (const entry of data.items.filter(isVerifiedMapEntry) as SourceEntry[]) {
            const same = targets.find(t => t.name === entry.name && normalizedPath(t.page) === normalizedPath(entry.page) &&
              t.controller === entry.controller && t.action === entry.action);
            if (!same) { targets.push(structuredClone(entry)); continue; }
            for (const ref of entry.references) {
              if (!same.references.some(r => normalizedPath(r.path) === normalizedPath(ref.path) && r.role === ref.role &&
                  r.startLine === ref.startLine && r.endLine === ref.endLine && r.sha256 === ref.sha256)) same.references.push(structuredClone(ref));
            }
          }
        }
        return;
      }
      if (args.mode !== "text") return;
      for (const item of data.items) if (item?.kind === "source") recordSource(call, item.path, item.line, item.text);
    } else if (!sourceOnly && call.name === "query_dcs_data" && ["success", "empty"].includes(data.status) &&
        typeof args.sql === "string" && args.sql.trim() && Array.isArray(data.columns) && data.columns.every((c: unknown) => typeof c === "string") &&
        Array.isArray(data.rows) && data.rows.every(Array.isArray) && Number.isSafeInteger(data.fetchedRows) && data.fetchedRows >= 0 &&
        typeof data.complete === "boolean" && data.rows.length <= data.fetchedRows && (data.status !== "empty" || data.fetchedRows === 0)) {
      const item: DataEvidence = { toolCallId: call.id, queryToolCallId: call.id, sql: args.sql, bindNames: Object.keys(args.binds ?? {}),
        columns: [...data.columns], fetchedRows: data.fetchedRows, complete: data.complete, visibleRows: data.rows.length,
        previewTruncated: data.previewTruncated === true, ...(typeof data.resultFile === "string" ? { resultFile: data.resultFile } : {}) };
      dataEvidence.push(item);
      if (item.resultFile) queryFiles.set(item.resultFile, item);
    } else if (!sourceOnly && call.name === "read_dcs_result" && typeof args.resultFile === "string") {
      // A structure artifact or a prior Run's file cannot acquire fresh query provenance.
      const query = queryFiles.get(args.resultFile);
      if (!query || typeof data.sourceComplete !== "boolean" || !Array.isArray(data.select) || data.select[0] !== "rows") return;
      const entries = Array.isArray(data.entries) ? data.entries.filter((e: any) => e?.partial === false && Array.isArray(e.select) && e.select[0] === "rows") : [];
      const scalar = Object.hasOwn(data, "value") || typeof data.text === "string";
      if (!entries.length && !scalar) return;
      dataEvidence.push({ ...query, toolCallId: call.id, complete: data.sourceComplete, visibleRows: entries.length,
        select: [...data.select], hasMore: data.hasMore === true });
    } else if (!sourceOnly && call.name === "request_clarification" && data.status === "awaiting_input") {
      const clarification = clarificationQuestion(data.missingInfo);
      if (clarification && args.missingInfo === data.missingInfo && data.question === clarification) {
        awaitingInput = true; terminal = { text: clarification, reason: "awaiting_input" };
      }
    } else if (!sourceOnly && call.name === "navigate_dcs_menu") {
      const nav = parseNavigationResult(data);
      if (!nav?.status) return;
      navigationResults.push({ toolCallId: call.id, status: nav.status, ...(nav.candidates ? { candidates: nav.candidates } : {}) });
      if (nav.status === "needs_selection" && nav.candidates?.length) {
        awaitingInput = true; terminal = { text: "请点击页面上的候选项，选择你要打开的功能。", reason: "awaiting_input" };
      } else if (nav.status === "opened" || nav.status === "switched") {
        // Let auto continue a compound request; navigation alone can release only fixed action text.
        navigationCompletion = { text: nav.status === "opened" ? "已打开页面。" : "已切换到页面。", reason: "navigation_complete" };
      }
    }
  }

  const pageHint = options.pageContext && (options.pageContext.title || options.pageContext.path)
    ? `\n当前页面定位线索（浏览器提供，仅用于定位，不是身份、权限或业务证据）：${JSON.stringify(options.pageContext)}` : "";
  const targetHint = targets.length
    ? `\n【本次业务定位线索】以下候选来自已校验源码地图，只提供入口及版本依据，不包含业务答案，不算已取得证据。保留同名候选；核对问题与候选的对应关系，不自动选择第一项。请优先读取候选实际实现并缩小搜索范围；地图范围外的真实依赖仍可继续读取，但依赖关系尚未确认时须说明。${JSON.stringify(targets)}`
    : "\n本次没有可核对的已登记目标映射；仍可继续普通搜索和读取，源码与目标的关系暂未由程序确认。";
  const policy: RunPolicy = {
    bufferText: true,
    systemPromptSuffix: (sourceOnly
      ? "\n【本次源码调查】必须依据本次工具实际返回的源码内容回答；未读取源码内容不得声称已核实。取得源码内容只表示已读取，不代表相关性、完整性或业务结论已验证。"
      : "\n【本次按需取证】先依据问题选择实际可用的信息来源：操作方法或制度检索文档，页面实现读取源码，当前记录使用授权查询，打开页面使用导航。不要固定组合调用所有工具。目标确实不明确时请求补充。只能依据本次真实返回的内容回答；路径、地图和表结构只是线索。文档、源码、数据和导航的含义不可互相替代。空查询仅说明本次范围未发现记录。历史回答不是已核实事实。") + pageHint + targetHint,
    prepareTurn() {
      if (!question.trim()) return { finish: { text: sourceOnly ? "请在“/查源码”后补充要调查的问题。" : "请补充要了解的问题。", reason: "missing_question" } };
      if (!requiredToolNames.some(name => name !== "request_clarification")) return { finish: { text: sourceOnly ? "当前源码调查能力不可用，暂时无法读取 DCS 源码。" : "当前没有可用的调查工具，暂时无法核实该问题。", reason: sourceOnly ? "source_tools_unavailable" : "tools_unavailable" } };
      remediationTurn = remediationPending;
      remediationPending = false;
      const required = firstTurn || remediationTurn;
      firstTurn = false;
      if (required) return { toolChoice: "required", toolNames: [...requiredToolNames] };
      return sourceOnly && options.availableToolNames === undefined ? { toolChoice: "auto" } : { toolChoice: "auto", toolNames: [...allToolNames] };
    },
    onToolResult,
    checkFinish({ remainingTurns }) {
      if (terminal) return { finish: terminal };
      if (hasEvidence()) return;
      if (navigationCompletion) return { finish: navigationCompletion };
      if (remainingTurns <= 0) return { finish: unavailable("max_turns") };
      if (remediationUsed) return { finish: unavailable() };
      remediationUsed = true; remediationPending = true;
      const targetFeedback = targets.length && sourceContentObtained && !targetSourceObtained()
        ? "已取得部分源码文本，但尚未读取本次已校验候选的实现范围，不能把无关源码当作目标依据。请读取上述候选的 controller/view/implementation 引用范围；必要时继续追踪实际依赖。" : "";
      return { retry: (sourceOnly ? RETRY : RETRY_EVIDENCE) + targetFeedback };
    },
    afterTools() {
      if (terminal) return terminal;
      if (remediationTurn && !hasEvidence() && !navigationCompletion) return unavailable();
    },
    snapshot() {
      return { requireEvidence: true, evidenceMode: sourceOnly ? "source" : "sources", sourceContentObtained,
        evidenceObtained: hasEvidence(), sources: sources.map(s => ({ ...s })),
        candidateBusinesses: structuredClone(targets), sourceRelations: sourceRelations(),
        discoveredMapCandidates: structuredClone(discoveredMapCandidates),
        targetSourceContentObtained: targetSourceObtained(),
        targetResolution: targets.length === 0 ? "unmapped" : targets.length > 1 ? "multiple_candidates" : targetSourceObtained() ? "mapped_source_obtained" : "unconfirmed",
        sourceMapState: structuredClone(options.indexState ?? {}),
        documentEvidence: structuredClone(documentEvidence), dataEvidence: structuredClone(dataEvidence),
        navigationResults: structuredClone(navigationResults), awaitingInput, remediationUsed };
    },
  };
  return { text: question, policy };
}
