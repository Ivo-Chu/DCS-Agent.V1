/**
 * 验收 harness 离线测试（2026-09-28）：不依赖真实模型 / 真实数据库。
 * 覆盖：案例加载与占位符跳过、会话复用与身份隔离、结果分类
 * （含"中间工具错误但成功恢复 ≠ 失败"）、报告渲染。
 *
 * 运行：npm run test:accept:harness
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "../src/core/events.ts";
import type { DcsIdentity } from "../src/dcs/identity.ts";
import {
  classifyRun,
  ConversationRegistry,
  isPlaceholder,
  loadCases,
  renderMarkdownReport,
  type AcceptanceCase,
  type HarnessAgent,
} from "./acceptance-harness.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n[场景] ${t}`);
}

const ID_A: DcsIdentity = { employeeNo: "10086", name: "张三", department: "制造一部", roles: [] };
const ID_B: DcsIdentity = { employeeNo: "20001", name: "李四", department: "制造二部", roles: [] };

function makeCase(over: Partial<AcceptanceCase>): AcceptanceCase {
  return {
    id: "c1",
    conversationId: "conv-1",
    employeeCode: "10086",
    question: "测试问题",
    expectedFacts: ["事实1"],
    expectedNextAction: "",
    maxDurationMs: 15_000,
    ...over,
  };
}

/** 构造带事件回放的假 Agent。 */
function makeFakeAgent(
  impl: (emit: (e: AgentEvent) => void) => Promise<string>
): HarnessAgent {
  const listeners = new Set<(e: AgentEvent) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async prompt() {
      return impl((e) => {
        for (const fn of listeners) fn(e);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 场景 H1：占位符与案例加载
// ---------------------------------------------------------------------------

section("H1. 案例加载与跳过行为");

{
  check("H1a isPlaceholder：空串 / <占位符> 判定为占位，真实工号不判占位",
    isPlaceholder("") && isPlaceholder("  ") && isPlaceholder("<真实测试工号>") && !isPlaceholder("10086"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-accept-"));
  const file = path.join(tmp, "cases.json");

  const loaded0 = loadCases(path.join(tmp, "not-exist.json"));
  check("H1b 案例文件不存在 → 整批 SKIPPED 原因，案例数为 0", loaded0.cases.length === 0 && loaded0.skippedAll.length === 1);

  fs.writeFileSync(file, "not json", "utf8");
  const loaded1 = loadCases(file);
  check("H1c 案例文件损坏 → 整批 SKIPPED 原因", loaded1.cases.length === 0 && loaded1.skippedAll.length === 1);

  fs.writeFileSync(
    file,
    JSON.stringify([
      makeCase({ id: "ok-1", employeeCode: "10086" }),
      makeCase({ id: "ph-1", employeeCode: "<真实测试工号>" }),
      makeCase({ id: "bad-1", employeeCode: "10086", question: "" }),
    ]),
    "utf8"
  );
  const loaded2 = loadCases(file);
  check(
    "H1d 占位/字段不完整案例被跳过（skippedCases 记录，不计入执行）",
    loaded2.cases.length === 1 && loaded2.cases[0].id === "ok-1" && loaded2.skippedCases.length === 2,
    JSON.stringify(loaded2.skippedCases)
  );

  fs.writeFileSync(file, "[]", "utf8");
  const loaded3 = loadCases(file);
  check("H1e 空案例数组 → 整批 SKIPPED", loaded3.cases.length === 0 && loaded3.skippedAll.length === 1);
}

// ---------------------------------------------------------------------------
// 场景 H2：会话复用与身份隔离
// ---------------------------------------------------------------------------

section("H2. 会话复用与身份隔离");

{
  const created: string[] = [];
  const agents: HarnessAgent[] = [];
  const registry = new ConversationRegistry({
    resolveIdentity: async (code) => (code === "10086" ? ID_A : code === "20001" ? ID_B : null),
    createAgent: (_identity, conversationId) => {
      created.push(conversationId);
      const a = makeFakeAgent(async () => "ok");
      agents.push(a);
      return a;
    },
  });

  const r1 = await registry.get("conv-a", "10086");
  check("H2a 首次会话创建 Agent 并解析真实身份", Boolean(r1.slot) && r1.slot?.identity === ID_A);

  const r2 = await registry.get("conv-a", "10086");
  check(
    "H2b 相同 conversationId 复用同一 Agent（不重复创建）",
    r2.slot === r1.slot && created.filter((c) => c === "conv-a").length === 1
  );

  const r3 = await registry.get("conv-b", "10086");
  check("H3c 不同 conversationId 相互隔离（新建 Agent）", r3.slot !== r1.slot && created.filter((c) => c === "conv-b").length === 1);

  const r4 = await registry.get("conv-a", "20001");
  check(
    "H2d 同一会话混用不同工号 → 明确错误（不创建新 Agent）",
    r4.slot === undefined && Boolean(r4.error?.includes("不得混用")) && created.filter((c) => c === "conv-a").length === 1,
    r4.error
  );

  const r5 = await registry.get("conv-c", "99999");
  check("H2e 工号无法解析 → 错误（不回退模拟身份）", r5.slot === undefined && Boolean(r5.error));
}

// ---------------------------------------------------------------------------
// 场景 H3：结果分类
// ---------------------------------------------------------------------------

section("H3. 结果分类（COMPLETED / FAILED / PENDING_REVIEW）");

function ev(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as AgentEvent;
}

{
  // 正常完成
  const r = classifyRun(makeCase({}), {
    answer: "你的权限正常。",
    events: [
      ev("assistant_message", { message: { stopReason: "toolCalls", content: "" } }),
      ev("tool_execution_start", { toolCallId: "t1", toolName: "query_dcs_data", args: {} }),
      ev("tool_execution_end", { toolCallId: "t1", toolName: "query_dcs_data", isError: false, summary: "ok" }),
      ev("assistant_message", { message: { stopReason: "stop", content: "你的权限正常。" } }),
    ],
    timedOut: false,
    durationMs: 1200,
  });
  check(
    "H3a 正常回答 → COMPLETED + PENDING_REVIEW（统计齐全）",
    r.status === "COMPLETED" && r.businessReview === "PENDING_REVIEW" && r.turns === 2 && r.toolCalls === 1 && r.toolErrors === 0 && r.stopReason === "stop" && r.durationMs === 1200,
    JSON.stringify(r)
  );
}

{
  // 中间工具错误但成功恢复：仍 COMPLETED（可恢复工具错误 ≠ 整题失败）
  const r = classifyRun(makeCase({}), {
    answer: "第一次 SQL 写错了，改写后查到：你的状态正常。",
    events: [
      ev("tool_execution_end", { toolCallId: "t1", toolName: "query_dcs_data", isError: true, summary: "ORA-00942" }),
      ev("tool_execution_end", { toolCallId: "t2", toolName: "query_dcs_data", isError: false, summary: "ok" }),
      ev("assistant_message", { message: { stopReason: "stop", content: "…" } }),
    ],
    timedOut: false,
    durationMs: 3000,
  });
  check(
    "H3b 中间工具错误但成功恢复 → 仍 COMPLETED（toolErrors 记录为 1 供人工参考）",
    r.status === "COMPLETED" && r.toolErrors === 1 && r.toolCalls === 2,
    JSON.stringify(r)
  );
}

{
  // 超时
  const r = classifyRun(makeCase({ maxDurationMs: 5000 }), {
    answer: "",
    events: [],
    timedOut: true,
    durationMs: 5000,
  });
  check("H3c 案例超时 → FAILED（reason 含超时）", r.status === "FAILED" && Boolean(r.reason?.includes("超时")));
}

{
  // 末轮非自然 stop
  const r = classifyRun(makeCase({}), {
    answer: "模型调用失败：网络错误",
    events: [ev("assistant_message", { message: { stopReason: "error", content: "…" } })],
    timedOut: false,
    durationMs: 800,
  });
  check("H3d 末轮 error → FAILED（错误字符串不能冒充通过）", r.status === "FAILED" && r.businessReview === "N/A");
}

{
  // 空回答
  const r = classifyRun(makeCase({}), {
    answer: "   ",
    events: [ev("assistant_message", { message: { stopReason: "stop", content: "" } })],
    timedOut: false,
    durationMs: 100,
  });
  check("H3e 自然 stop 但回复为空 → FAILED", r.status === "FAILED" && Boolean(r.reason?.includes("空")));
}

{
  // prompt 抛异常
  const r = classifyRun(makeCase({}), {
    answer: "",
    events: [],
    timedOut: false,
    durationMs: 50,
    error: new Error("boom"),
  });
  check("H3f 运行异常 → FAILED（reason 含异常信息）", r.status === "FAILED" && Boolean(r.reason?.includes("boom")));
}

// ---------------------------------------------------------------------------
// 场景 H4：报告渲染
// ---------------------------------------------------------------------------

section("H4. 报告渲染");

{
  const md = renderMarkdownReport(
    [
      {
        id: "ok-1", conversationId: "conv-a", employeeCode: "10086", question: "Q1",
        status: "COMPLETED", businessReview: "PENDING_REVIEW", answer: "回答A", durationMs: 100,
        turns: 2, toolCalls: 1, toolErrors: 0, stopReason: "stop", expectedFacts: ["事实X"], expectedNextAction: "",
      },
      {
        id: "bad-1", conversationId: "conv-b", employeeCode: "20001", question: "Q2",
        status: "FAILED", businessReview: "N/A", reason: "案例超时（>5000ms）",
      },
    ],
    ["案例文件不存在：x"],
    ["案例 ph-1：employeeCode 仍为占位符"]
  );
  check("H4a 统计行含 COMPLETED/FAILED/PENDING_REVIEW 计数",
    md.includes("COMPLETED 1 / FAILED 1 / SKIPPED 0") && md.includes("待人工核对（PENDING_REVIEW）：1 项"),
    md.split("\n")[4]);
  check("H4b 明细表含两案例与失败原因", md.includes("ok-1") && md.includes("bad-1") && md.includes("案例超时"));
  check("H4c 人工核对要点渲染（expectedFacts）", md.includes("事实X") && md.includes("expectedFacts"));
  check("H4d 跳过原因渲染（整批 + 单案例）", md.includes("案例文件不存在") && md.includes("占位符"));
  check("H4e 报告含「不等于验收通过」的人工核对提示", md.includes("不等于验收通过"));
}

console.log(`\n========== 验收 harness 测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
