/**
 * 真实业务验收 harness（可离线测试的纯逻辑部分）。
 *
 * acceptance-live.ts 是入口（真实模型 + 真实库）；本模块抽出：
 * - 案例加载与占位符校验（loadCases / isPlaceholder）
 * - 会话管理（相同 conversationId 复用 Agent，不同会话隔离，
 *   同一会话不得混用不同员工，身份不回退模拟）
 * - 运行结果分类（classifyRun：COMPLETED / FAILED，区分"中间工具错误
 *   但成功恢复"与"最终业务失败"）
 * - 报告渲染（writeReports → JSON + Markdown）
 *
 * 依赖全部注入（identityResolver / agentFactory），测试用假实现。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "../src/core/events.ts";
import type { DcsIdentity } from "../src/dcs/identity.ts";

// ---------------------------------------------------------------------------
// 案例模型
// ---------------------------------------------------------------------------

export interface AcceptanceCase {
  id: string;
  conversationId: string;
  employeeCode: string;
  question: string;
  expectedFacts: string[];
  expectedNextAction?: string;
  maxDurationMs?: number;
}

export type RunStatus = "COMPLETED" | "FAILED" | "SKIPPED";

export interface CaseResult {
  id: string;
  conversationId: string;
  employeeCode: string;
  question: string;
  status: RunStatus;
  /** 业务正确性人工核对状态：仅 COMPLETED 时为 PENDING_REVIEW，其余为 N/A。 */
  businessReview: "PENDING_REVIEW" | "N/A";
  reason?: string;
  answer?: string;
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  stopReason?: string;
  expectedFacts?: string[];
  expectedNextAction?: string;
}

export const DEFAULT_CASE_BUDGET_MS = 15_000;

/** 占位符判定：空串或以 "<" 开头（如 "<真实测试工号>"）。 */
export function isPlaceholder(v: string | undefined): boolean {
  return !v || v.trim().length === 0 || v.trim().startsWith("<");
}

export interface LoadedCases {
  cases: AcceptanceCase[];
  /** 整批跳过原因（文件缺失/损坏/为空）。 */
  skippedAll: string[];
  /** 单案例跳过原因（字段不完整/占位符）。 */
  skippedCases: string[];
}

export function loadCases(file: string): LoadedCases {
  const skippedAll: string[] = [];
  const skippedCases: string[] = [];
  if (!fs.existsSync(file)) {
    return { cases: [], skippedAll: [`案例文件不存在：${file}`], skippedCases };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { cases: [], skippedAll: [`案例文件损坏：${String(err)}`], skippedCases };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { cases: [], skippedAll: ["案例文件为空（需至少一个有效案例）"], skippedCases };
  }
  const cases: AcceptanceCase[] = [];
  for (const item of raw) {
    const c = item as Partial<AcceptanceCase>;
    if (!c.id || !c.conversationId || !c.employeeCode || isPlaceholder(c.employeeCode) || !c.question) {
      skippedCases.push(`案例 ${c.id ?? "<无id>"}：字段不完整或 employeeCode 仍为占位符（SKIPPED，不计入通过率）`);
      continue;
    }
    cases.push({
      id: c.id,
      conversationId: c.conversationId,
      employeeCode: c.employeeCode,
      question: c.question,
      expectedFacts: Array.isArray(c.expectedFacts) ? c.expectedFacts : [],
      expectedNextAction: c.expectedNextAction ?? "",
      maxDurationMs: c.maxDurationMs ?? DEFAULT_CASE_BUDGET_MS,
    });
  }
  return { cases, skippedAll, skippedCases };
}

// ---------------------------------------------------------------------------
// 会话管理（注入依赖，可离线测试）
// ---------------------------------------------------------------------------

/** 最小 Agent 契约（与 web/server 同思路）。 */
export interface HarnessAgent {
  prompt(question: string): Promise<string>;
  subscribe(fn: (e: AgentEvent) => void): () => void;
}

export interface HarnessDeps {
  /** 工号 → 身份（真实链路为 resolveEmployeeByCode；测试注入假实现）。 */
  resolveIdentity: (code: string) => Promise<DcsIdentity | null>;
  /** Agent 工厂（真实链路为 createDcsAgent；测试注入假 Agent）。 */
  createAgent: (identity: DcsIdentity, conversationId: string) => HarnessAgent;
}

export interface ConversationSlot {
  agent: HarnessAgent;
  identity: DcsIdentity;
  /** 会话锁定的员工工号：同一会话不得混用不同员工。 */
  employeeNo: string;
}

export class ConversationRegistry {
  private readonly slots = new Map<string, ConversationSlot>();
  /** 测试观测：会话复用/新建计数。 */
  readonly createdConversations: string[] = [];

  constructor(private readonly deps: HarnessDeps) {}

  async get(conversationId: string, employeeCode: string): Promise<{ slot?: ConversationSlot; error?: string }> {
    const existing = this.slots.get(conversationId);
    if (existing) {
      if (existing.employeeNo !== employeeCode) {
        return {
          error: `会话 ${conversationId} 已绑定工号 ${existing.employeeNo}，不得混用不同员工（本案例传入 ${employeeCode}）`,
        };
      }
      return { slot: existing };
    }
    const identity = await this.deps.resolveIdentity(employeeCode);
    if (!identity) {
      return { error: `工号 ${employeeCode} 未解析为在职员工（不回退模拟身份）` };
    }
    const slot: ConversationSlot = {
      agent: this.deps.createAgent(identity, conversationId),
      identity,
      employeeNo: identity.employeeNo,
    };
    this.slots.set(conversationId, slot);
    this.createdConversations.push(conversationId);
    return { slot };
  }
}

// ---------------------------------------------------------------------------
// 运行结果分类
// ---------------------------------------------------------------------------

export interface RunObservation {
  answer: string;
  events: AgentEvent[];
  timedOut: boolean;
  durationMs: number;
  /** 运行抛出的异常（如有）。 */
  error?: unknown;
}

/**
 * 分类规则（区分"中间工具错误但成功恢复"与"最终业务失败"）：
 * - 案例超时 / prompt 异常 / 末轮非自然 stop / 回复为空 → FAILED；
 * - 中间工具错误（isError:true）但末轮自然 stop 且有回答 → COMPLETED
 *   （工具错误计数记录在 toolErrors，供人工核对时参考）；
 * - COMPLETED 的业务正确性 → PENDING_REVIEW（人工按 expectedFacts 核对）。
 */
export function classifyRun(c: AcceptanceCase, obs: RunObservation): CaseResult {
  const base: CaseResult = {
    id: c.id,
    conversationId: c.conversationId,
    employeeCode: c.employeeCode,
    question: c.question,
    status: "FAILED",
    businessReview: "N/A",
    expectedFacts: c.expectedFacts,
    expectedNextAction: c.expectedNextAction,
  };

  const turns = obs.events.filter((e) => e.type === "assistant_message").length;
  const toolEnds = obs.events.filter((e) => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }>[];
  const toolCalls = toolEnds.length;
  const toolErrors = toolEnds.filter((e) => e.isError).length;
  const lastAssistant = [...obs.events].reverse().find((e) => e.type === "assistant_message") as Extract<AgentEvent, { type: "assistant_message" }> | undefined;
  const stopReason = lastAssistant?.message.stopReason ?? "unknown";
  const stats = { durationMs: obs.durationMs, turns, toolCalls, toolErrors, stopReason };

  if (obs.error !== undefined) {
    return { ...base, status: "FAILED", reason: `运行异常：${String(obs.error).slice(0, 300)}`, ...stats };
  }
  if (obs.timedOut) {
    return { ...base, status: "FAILED", reason: `案例超时（>${c.maxDurationMs ?? DEFAULT_CASE_BUDGET_MS}ms）`, ...stats };
  }
  if (stopReason !== "stop") {
    return { ...base, status: "FAILED", reason: `非自然结束（stopReason=${stopReason}）`, answer: obs.answer, ...stats };
  }
  if (obs.answer.trim().length === 0) {
    return { ...base, status: "FAILED", reason: "最终回复为空", ...stats };
  }
  return { ...base, status: "COMPLETED", businessReview: "PENDING_REVIEW", answer: obs.answer, ...stats };
}

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

export function renderMarkdownReport(results: CaseResult[], skippedAll: string[], skippedCases: string[]): string {
  const completed = results.filter((r) => r.status === "COMPLETED");
  const failed = results.filter((r) => r.status === "FAILED");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  const pending = results.filter((r) => r.businessReview === "PENDING_REVIEW");

  const md: string[] = [
    "# DCS Agent 真实业务验收报告",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    `运行统计：COMPLETED ${completed.length} / FAILED ${failed.length} / SKIPPED ${skipped.length}` +
      (skippedAll.length || skippedCases.length ? `（另有跳过 ${skippedAll.length + skippedCases.length} 项）` : ""),
    `业务正确性待人工核对（PENDING_REVIEW）：${pending.length} 项`,
    "",
    "> 运行 COMPLETED 只代表「正常生成最终回答」；业务是否正确由人工按 expectedFacts 核对，",
    "> 调用过工具 / 回答含关键词都不等于验收通过。",
    "",
    "## 结果明细",
    "",
    "| 案例 | 会话 | 工号 | 状态 | 业务核对 | 耗时(ms) | 轮次 | 工具调用 | 工具错误 | 停止原因 |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    md.push(
      `| ${r.id} | ${r.conversationId} | ${r.employeeCode} | ${r.status}${r.reason ? `（${r.reason}）` : ""} | ${r.businessReview} | ${r.durationMs ?? "-"} | ${r.turns ?? "-"} | ${r.toolCalls ?? "-"} | ${r.toolErrors ?? "-"} | ${r.stopReason ?? "-"} |`
    );
  }
  for (const r of results.filter((x) => x.answer)) {
    md.push("", `### ${r.id} — 实际回答`, "", "```", r.answer ?? "", "```", "");
    if (r.expectedFacts?.length) {
      md.push(`- 人工核对要点（expectedFacts）：${r.expectedFacts.map((f) => `「${f}」`).join("、")}`);
    }
    if (r.expectedNextAction) {
      md.push(`- 期望建议（expectedNextAction）：「${r.expectedNextAction}」`);
    }
  }
  if (skippedAll.length || skippedCases.length) {
    md.push("", "## 跳过原因", "");
    for (const s of skippedAll) md.push(`- ${s}`);
    for (const s of skippedCases) md.push(`- ${s}`);
  }
  md.push("");
  return md.join("\n");
}

export function writeReports(
  reportsDir: string,
  results: CaseResult[],
  skippedAll: string[],
  skippedCases: string[]
): { jsonPath: string; mdPath: string } {
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(reportsDir, `acceptance-${stamp}.json`);
  const mdPath = path.join(reportsDir, `acceptance-${stamp}.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), skippedAll, skippedCases, results }, null, 2),
    "utf8"
  );
  fs.writeFileSync(mdPath, renderMarkdownReport(results, skippedAll, skippedCases), "utf8");
  return { jsonPath, mdPath };
}
