/**
 * 真实业务验收入口（2026-09-28 重建，案例驱动）。
 *
 * 与离线验收录（test/acceptance.ts + smoke 场景 K）完全分离：
 * - 离线：FakeStreamFn 剧本 + 模拟事实判定（42 元 / 35 元 / 驳回），验证接线；
 * - 本入口：真实 DeepSeek + 真实 Oracle + 真实员工身份（resolveEmployeeByCode，
 *   不回退模拟身份），验证真实业务行为；业务正确性只标记 PENDING_REVIEW，
 *   由人工按 expectedFacts 核对——正常结束 / 调用过工具 / 命中关键词
 *   都不等于业务验收通过。
 *
 * 案例文件：test/acceptance-cases/cases.json（gitignored，模板见 cases.example.json）。
 * 输出：test/acceptance-cases/reports/acceptance-<时间戳>.json / .md
 *
 * 运行状态：
 * - COMPLETED：正常生成最终回答（业务正确性 → PENDING_REVIEW 待人工核对）
 * - FAILED：运行异常、案例超时、非自然结束、会话内混用不同员工、工号无法解析
 * - SKIPPED：未配置 DEEPSEEK_API_KEY / DCS_DB_* / 案例文件缺失或全为占位符
 *
 * 运行：npm run test:accept:live
 */
import * as path from "node:path";
import type { AgentEvent } from "../src/core/events.ts";
import { createDcsAgent, type DcsAgentHolder } from "../src/dcs/agent-factory.ts";
import { resolveEmployeeByCode } from "../src/dcs/identity.ts";
import { createSession } from "../src/dcs/session.ts";
import { closeDbClient } from "../src/dcs/db/client.ts";
import {
  classifyRun,
  ConversationRegistry,
  loadCases,
  writeReports,
  type AcceptanceCase,
  type CaseResult,
  type HarnessAgent,
} from "./acceptance-harness.ts";

const CASES_FILE = path.resolve(import.meta.dirname, "acceptance-cases", "cases.json");
const REPORTS_DIR = path.resolve(import.meta.dirname, "acceptance-cases", "reports");
/** 本轮总超时：避免验收脚本无限挂起（10 分钟）。 */
const TOTAL_BUDGET_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!process.env.DEEPSEEK_API_KEY) missing.push("DEEPSEEK_API_KEY");
  for (const k of ["DCS_DB_USER", "DCS_DB_PASSWORD", "DCS_DB_CONNECT_STRING"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length > 0) {
    console.log("========== 未验证（SKIPPED） ==========");
    console.log(`未设置：${missing.join(" / ")}——真实业务验收未执行（不读取或打印任何已有密钥文件）。`);
    console.log("真实验收需要真实模型与真实数据库；不以模拟身份/假数据代替。");
    console.log("配置后运行：npm run test:accept:live");
    process.exit(0);
  }

  const { cases, skippedAll, skippedCases } = loadCases(CASES_FILE);
  if (cases.length === 0) {
    console.log("========== 未验证（SKIPPED） ==========");
    for (const s of skippedAll) console.log(`- ${s}`);
    console.log("请按 test/acceptance-cases/cases.example.json 填写真实案例（cases.json）。");
    process.exit(0);
  }

  console.log("========== DCS Agent 真实业务验收（案例驱动） ==========");
  console.log(
    `有效案例 ${cases.length} 个${skippedCases.length ? `（另有 ${skippedCases.length} 个占位案例跳过，不计入通过率）` : ""}`
  );

  // 真实链路：resolveEmployeeByCode（S2_Employee，仅在职）+ createDcsAgent。
  // 每会话一个 holder（createDcsAgent 的 signalProvider 读取同一对象），
  // 每案例 Run 开始时替换 controller（与 Web/企微同口径）。
  const holders = new Map<string, DcsAgentHolder>();
  const registry = new ConversationRegistry({
    resolveIdentity: resolveEmployeeByCode,
    createAgent: (identity, conversationId): HarnessAgent => {
      const holder: DcsAgentHolder = { controller: new AbortController() };
      holders.set(conversationId, holder);
      return createDcsAgent({
        session: createSession(identity, `accept-${conversationId}`, "web"),
        holder,
      });
    },
  });

  // 总超时保护：到时中止所有会话并按非零退出码收尾，避免脚本无限挂起
  const totalTimer = setTimeout(() => {
    console.error(`\n[accept] 本轮总超时（${TOTAL_BUDGET_MS / 60000} 分钟），强制中止所有会话并退出。`);
    for (const h of holders.values()) h.controller.abort();
    void closeDbClient()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  }, TOTAL_BUDGET_MS);

  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      console.log(`\n--- 案例 ${c.id}（会话 ${c.conversationId}，工号 ${c.employeeCode}）---`);
      console.log(`问：${c.question}`);
      const r = await runCase(c, registry, holders);
      results.push(r);
      if (r.status === "COMPLETED") {
        console.log(`答：${r.answer?.slice(0, 200)}${(r.answer?.length ?? 0) > 200 ? "…" : ""}`);
        console.log(
          `[运行] COMPLETED（${r.durationMs}ms，turns=${r.turns}，toolCalls=${r.toolCalls}，toolErrors=${r.toolErrors}，stop=${r.stopReason}）→ 业务正确性 PENDING_REVIEW（人工按 expectedFacts 核对）`
        );
      } else {
        console.log(`[运行] ${r.status}：${r.reason ?? ""}`);
      }
    }
  } finally {
    clearTimeout(totalTimer);
    // 关闭数据库连接池（poolMin=1 常驻连接会让进程挂住）
    await closeDbClient().catch(() => undefined);
  }

  const { mdPath } = writeReports(REPORTS_DIR, results, skippedAll, skippedCases);
  const completed = results.filter((r) => r.status === "COMPLETED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const pendingReview = results.filter((r) => r.businessReview === "PENDING_REVIEW").length;

  console.log("\n========== 验收结果 ==========");
  console.log(
    `COMPLETED ${completed} / FAILED ${failed} / SKIPPED ${results.length - completed - failed}` +
      (skippedAll.length + skippedCases.length ? `（另跳过 ${skippedAll.length + skippedCases.length}）` : "")
  );
  console.log(`业务正确性 PENDING_REVIEW（待人工核对）：${pendingReview} 项`);
  console.log(`报告已写入：${mdPath}`);

  if (failed > 0) process.exit(1);
  process.exit(0);
}

/** 单案例执行：会话校验 → 新 controller → prompt（案例级超时 abort）→ 分类。 */
async function runCase(
  c: AcceptanceCase,
  registry: ConversationRegistry,
  holders: Map<string, DcsAgentHolder>
): Promise<CaseResult> {
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

  const conv = await registry.get(c.conversationId, c.employeeCode);
  if (conv.error || !conv.slot) {
    return { ...base, reason: conv.error ?? "会话建立失败" };
  }
  const holder = holders.get(c.conversationId);
  if (!holder) {
    return { ...base, reason: "会话取消信号持有器缺失（内部错误）" };
  }
  // 每 Run 新控制器（与 Web/企微同口径）；案例超时 abort 模型请求
  holder.controller = new AbortController();

  const events: AgentEvent[] = [];
  const unsubscribe = conv.slot.agent.subscribe((e) => events.push(e));
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    holder.controller.abort();
  }, c.maxDurationMs ?? 15_000);

  try {
    const answer = await conv.slot.agent.prompt(c.question);
    return classifyRun(c, { answer, events, timedOut, durationMs: Date.now() - startedAt });
  } catch (err) {
    return classifyRun(c, { answer: "", events, timedOut, durationMs: Date.now() - startedAt, error: err });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

void main();
