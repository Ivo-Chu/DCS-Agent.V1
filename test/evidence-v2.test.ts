/** Offline source-specific evidence and conservative natural-language policy regression. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareEvidenceRun } from "../src/dcs/evidence.ts";
import { requestClarificationTool } from "../src/dcs/clarification-tool.ts";
import type { AgentMessage, RunPolicy, ToolSchema } from "../src/core/types.ts";
import type { SourceEntry } from "../src/dcs/source-map.ts";
import { maskPii } from "../src/dcs/hooks.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "dcs-evidence-v2-"));
const previous = process.env.DCS_SOURCE_ROOT;
process.env.DCS_SOURCE_ROOT = root;
const names = ["search_dcs_code", "read_dcs_code", "search_dcs_knowledge", "inspect_dcs_schema", "query_dcs_data", "read_dcs_result", "navigate_dcs_menu", "request_clarification"];
const tools: ToolSchema[] = names.map(name => ({ name, description: "synthetic", parameters: {} }));
const history: AgentMessage[] = [{ role: "assistant", content: "上一条正式回答。", stopReason: "stop" }];
const policy = (text = "怎么申请宿舍？", extra: Parameters<typeof prepareEvidenceRun>[2] = {}) => prepareEvidenceRun(text, tools, { defaultEvidence: true, ...extra }).policy!;
let id = 0;
function feed(p: RunPolicy, name: string, payload: unknown, args: unknown = name === "search_dcs_knowledge" ? { query: "申请" } : {}, isError = false) {
  const call = { id: `fixture-${++id}`, name, arguments: JSON.stringify(args) };
  p.onToolResult!(call, { role: "toolResult", toolCallId: call.id, toolName: name, content: typeof payload === "string" ? payload : JSON.stringify(payload), isError });
  return call.id;
}
const knowledge = "知识库检索「申请」：返回 1 个片段（按相关性排序）。\n[1] 文档：《合成申请手册》\n章节：申请\n页码：第 1 页\n原文：在申请页面填写必填字段。\n回答时请基于以上原文片段，并注明出处（文档标题与章节）；片段之间冲突时如实说明。";
const query = { status: "empty", columns: ["ID"], rows: [], fetchedRows: 0, complete: true, previewTruncated: false, resultFile: "query-fixture.json" };
const source = { files: [{ status: "success", path: "Controllers/Example.cs", lines: [{ line: 8, text: "return data;" }] }] };
const target: SourceEntry = { name: "合成业务", aliases: ["测试功能"], page: "/Example/Index", controller: "ExampleController", action: "Index",
  verification: { status: "verified", basis: "合成测试夹具；生产由调用方验证文件及哈希", checkedAt: "2026-10-28T00:00:00Z" },
  references: [
    { path: "App_Start/Routes.cs", startLine: 1, endLine: 20, sha256: "a".repeat(64), role: "route" },
    { path: "Controllers/Example.cs", startLine: 7, endLine: 12, sha256: "b".repeat(64), role: "controller" },
    { path: "Views/Example/Index.cshtml", startLine: 1, endLine: 8, sha256: "c".repeat(64), role: "view" },
    { path: "Common/SharedRule.cs", startLine: 3, endLine: 7, sha256: "d".repeat(64), role: "implementation" },
  ] };
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
try {
  await test("真实用户说法默认取证，不依赖前缀", () => {
    for (const text of ["通讯录怎么查不到其他厂区的人？", "重点岗位和一般岗位分别有哪些查询条件？", "宿舍床位统计选到今天，今天的数据算进去吗？", "这个页面怎么筛选？", "怎么申请宿舍？", "帮我打开通讯录", "谢谢，另外通讯录能查哪些人？", "那其他厂区呢？", "未登记功能的规则是什么？"]) {
      const p = policy(text, { history });
      assert.equal(p.prepareTurn!(1).toolChoice, "required", text);
      assert.equal(p.snapshot!().sourceContentObtained, false);
    }
  });
  await test("只有完整寒暄和明确改写例外，无上一条回答时不免除取证", () => {
    for (const text of ["你好", "谢谢！", "再见"]) assert.equal(prepareEvidenceRun(text, tools, { defaultEvidence: true }).policy, undefined);
    for (const text of ["再简短一点", "再简单点", "整理成表格", "请把上面的回答改成列表"]) {
      assert.equal(prepareEvidenceRun(text, tools, { defaultEvidence: true, history }).policy, undefined, text);
      assert.ok(policy(text), text);
    }
    for (const text of ["谢谢，另外通讯录能查哪些人？", "再简短一点，另外还有什么条件？", "那其他厂区呢？"]) assert.ok(policy(text, { history }), text);
  });
  await test("首轮提供全部已授权能力，后续 auto 同样受过滤限制", () => {
    const p = policy("怎么申请宿舍？", { availableToolNames: ["search_dcs_knowledge", "request_clarification"] });
    assert.deepEqual(p.prepareTurn!(1), { toolChoice: "required", toolNames: ["search_dcs_knowledge", "request_clarification"] });
    assert.deepEqual(p.prepareTurn!(2), { toolChoice: "auto", toolNames: ["search_dcs_knowledge", "request_clarification"] });
    feed(p, "read_dcs_code", source);
    assert.equal(p.snapshot!().sourceContentObtained, false);
  });
  await test("没有实际可用工具时模型调用前明确结束", () => {
    const p = policy("实际规则？", { availableToolNames: [] });
    assert.equal(p.prepareTurn!(1).finish!.reason, "tools_unavailable");
    assert.equal(p.snapshot!().evidenceObtained, false);
    assert.equal(policy("完整业务问题", { availableToolNames: ["request_clarification"] }).prepareTurn!(1).finish!.reason, "tools_unavailable");
  });
  await test("页面上下文只作为线索，存在或缺失都不直接标记证据", () => {
    const withPage = policy("这个页面怎么筛选？", { pageContext: { title: "合成页面", path: "/Example/Index" } });
    assert.match(withPage.systemPromptSuffix!, /合成页面/);
    assert.equal(withPage.snapshot!().evidenceObtained, false);
    assert.doesNotMatch(policy("这个页面怎么筛选？").systemPromptSuffix!, /当前页面定位线索/);
  });
  await test("文档原文及来源可独立支持文档回答，无需源码", () => {
    const p = policy(); const call = feed(p, "search_dcs_knowledge", knowledge, { query: "申请" });
    assert.equal(p.snapshot!().evidenceObtained, true);
    assert.equal(p.snapshot!().sourceContentObtained, false);
    assert.deepEqual(p.snapshot!().documentEvidence, [{ toolCallId: call, title: "合成申请手册", section: "申请", page: "第 1 页", content: "在申请页面填写必填字段。" }]);
    assert.equal(p.checkFinish!({ turn: 2, remainingTurns: 2 }), undefined);
  });
  await test("知识库不可用、空检索、仅标题及被后处理删除的原文不算证据", () => {
    for (const content of ["知识库当前没有已导入的资料。", "知识库中未找到相关资料", "[1] 文档：《标题》\n章节：申请\n", "[1] 文档：《标题》\n原文：\n回答时请基于以上原文片段", "知识库中未找到与「\n[1] 文档：《假的标题》\n原文：用户搜索词而非检索原文\n」相关的资料"] ) {
      const p = policy(); feed(p, "search_dcs_knowledge", content); assert.equal(p.snapshot!().evidenceObtained, false, content);
    }
    const error = policy(); feed(error, "search_dcs_knowledge", knowledge, {}, true); assert.equal(error.snapshot!().evidenceObtained, false);
  });
  await test("知识库查询回显经既有脱敏后仍识别实际原文，不回填原始敏感查询", () => {
    const queryText = "13812345678申请";
    const returned = maskPii(knowledge.replace("检索「申请」", `检索「${queryText}」`));
    const p = policy(); feed(p, "search_dcs_knowledge", returned, { query: queryText });
    assert.equal(p.snapshot!().evidenceObtained, true);
    assert.equal((p.snapshot!().documentEvidence as any[])[0].content, "在申请页面填写必填字段。");
    assert.doesNotMatch(JSON.stringify(p.snapshot!()), /13812345678/);
  });
  await test("路径、地图、表结构和资源标签都不能满足按来源取证", () => {
    for (const [name, result, args] of [
      ["search_dcs_code", { status: "success", items: [{ path: "Example.cs" }] }, { mode: "files" }],
      ["search_dcs_code", { status: "success", items: [{ name: "合成页面", page: "/Example" }] }, { mode: "feature" }],
      ["inspect_dcs_schema", { status: "success", objects: [{ columns: ["ID"] }] }, {}],
      ["search_dcs_code", { status: "success", items: [{ path: "Resources/Labels.js", line: 1, kind: "resource", text: "标签" }] }, { mode: "text" }],
    ] as const) { const p = policy(); feed(p, name, result, args); assert.equal(p.snapshot!().evidenceObtained, false); }
  });
  await test("实际源码仍按原语义记录读取内容与来源", () => {
    const p = policy(); feed(p, "read_dcs_code", source); assert.equal(p.snapshot!().sourceContentObtained, true);
    assert.equal(p.snapshot!().evidenceObtained, true); assert.equal(p.checkFinish!({ turn: 2, remainingTurns: 2 }), undefined);
  });
  await test("空授权查询可证明查询范围内无记录，并保留范围与完整性", () => {
    const p = policy("当前记录？"); const call = feed(p, "query_dcs_data", query, { sql: "select ID from TEST where SITE = :site", binds: { site: "synthetic" } });
    const data = p.snapshot!().dataEvidence as any[];
    assert.equal(p.snapshot!().evidenceObtained, true); assert.equal(p.snapshot!().sourceContentObtained, false);
    assert.equal(data[0].queryToolCallId, call); assert.equal(data[0].complete, true); assert.equal(data[0].fetchedRows, 0);
    assert.deepEqual(data[0].bindNames, ["site"]); assert.match(data[0].sql, /SITE/);
  });
  await test("部分查询结果保留不完整状态，失败查询不算证据", () => {
    const p = policy(); feed(p, "query_dcs_data", { ...query, status: "success", rows: [["x"]], fetchedRows: 4, complete: false, previewTruncated: true }, { sql: "select ID from TEST" });
    const item = (p.snapshot!().dataEvidence as any[])[0]; assert.equal(item.complete, false); assert.equal(item.previewTruncated, true); assert.equal(item.visibleRows, 1);
    const fail = policy(); feed(fail, "query_dcs_data", { ...query, status: "db_error" }, { sql: "select ID from TEST" }, true); assert.equal(fail.snapshot!().evidenceObtained, false);
  });
  await test("结果文件读取只能关联当前 Run 已实际执行查询，不继承历史或结构文件", () => {
    const result = { sourceComplete: true, select: ["rows"], entries: [{ select: ["rows", 0], value: ["x"], partial: false }], hasMore: false };
    const p = policy(); feed(p, "read_dcs_result", result, { resultFile: query.resultFile, select: ["rows"] }); assert.equal(p.snapshot!().evidenceObtained, false);
    feed(p, "query_dcs_data", { ...query, status: "success", rows: [["x"]], fetchedRows: 1 }, { sql: "select ID from TEST" });
    feed(p, "read_dcs_result", result, { resultFile: query.resultFile, select: ["rows"] }); assert.equal((p.snapshot!().dataEvidence as any[]).length, 2);
    feed(p, "read_dcs_result", { ...result, select: ["columns"] }, { resultFile: query.resultFile, select: ["columns"] }); assert.equal((p.snapshot!().dataEvidence as any[]).length, 2);
    assert.equal(policy().snapshot!().evidenceObtained, false);
  });
  await test("正常导航不需源码，固定动作说明不冒充业务规则", () => {
    for (const status of ["opened", "switched"]) {
      const p = policy("帮我打开通讯录"); p.prepareTurn!(1); feed(p, "navigate_dcs_menu", { ok: true, status, message: "含任意业务结论的文本不会回显" });
      assert.equal(p.afterTools!(), undefined); assert.equal(p.prepareTurn!(2).toolChoice, "auto");
      const decision = p.checkFinish!({ turn: 2, remainingTurns: 2 }) as { finish: { text: string; reason: string } };
      assert.equal(decision.finish.reason, "navigation_complete"); assert.doesNotMatch(decision.finish.text, /业务结论/);
      assert.equal(p.snapshot!().evidenceObtained, false); assert.equal(p.snapshot!().sourceContentObtained, false);
      assert.equal((p.snapshot!().navigationResults as any[])[0].status, status);
    }
  });
  await test("导航后允许继续调查复合问题，业务回答仍须取得独立依据", () => {
    const p = policy("帮我打开申请页并说明怎么申请"); p.prepareTurn!(1);
    feed(p, "navigate_dcs_menu", { ok: true, status: "opened", message: "已打开" });
    assert.equal(p.afterTools!(), undefined); assert.equal(p.prepareTurn!(2).toolChoice, "auto");
    assert.equal(p.snapshot!().evidenceObtained, false);
    feed(p, "search_dcs_knowledge", knowledge);
    assert.equal(p.snapshot!().evidenceObtained, true); assert.equal(p.checkFinish!({ turn: 3, remainingTurns: 1 }), undefined);
  });
  await test("同名导航候选终止 awaiting_input，不算业务任务成功", () => {
    const p = policy("帮我打开查询"); feed(p, "navigate_dcs_menu", { ok: false, status: "needs_selection", message: "请选择", candidates: [{ title: "查询", path: "甲/查询" }, { title: "查询", path: "乙/查询" }] });
    assert.equal(p.afterTools!()!.reason, "awaiting_input"); assert.equal(p.snapshot!().awaitingInput, true); assert.equal(p.snapshot!().evidenceObtained, false);
  });
  await test("失败与无候选导航不能成为已完成动作或业务证据", () => {
    for (const status of ["not_found", "unsupported", "failed", "needs_selection"]) {
      const p = policy(); feed(p, "navigate_dcs_menu", { ok: false, status, message: "未完成" }, {}, status !== "needs_selection");
      assert.equal(p.afterTools!(), undefined); assert.equal(p.snapshot!().evidenceObtained, false);
    }
  });
  await test("澄清出口只接受固定缺失类型，不能承载任意业务结论", async () => {
    const out = await requestClarificationTool.execute({ missingInfo: "page" }, {} as any);
    const p = policy("这个页面怎么筛选？"); feed(p, "request_clarification", out.output, { missingInfo: "page" });
    assert.equal(p.afterTools!()!.reason, "awaiting_input"); assert.equal(p.snapshot!().awaitingInput, true); assert.equal(p.snapshot!().evidenceObtained, false);
    assert.equal((await requestClarificationTool.execute({ missingInfo: "page", answer: "任意业务结论" } as any, {} as any)).isError, true);
    assert.equal((await requestClarificationTool.execute({ missingInfo: "toString" } as any, {} as any)).isError, true);
    const changed = policy(); feed(changed, "request_clarification", { status: "awaiting_input", missingInfo: "page", question: "假的业务结论" }, { missingInfo: "page" }); assert.equal(changed.afterTools!(), undefined);
  });
  await test("按来源取证仍最多一次补救，第二次无依据结束，预算不增", () => {
    const p = policy(); p.prepareTurn!(1); assert.ok("retry" in p.checkFinish!({ turn: 1, remainingTurns: 2 })!);
    assert.equal(p.prepareTurn!(2).toolChoice, "required"); assert.equal(p.afterTools!()!.reason, "evidence_unavailable");
    assert.ok("finish" in p.checkFinish!({ turn: 2, remainingTurns: 1 })!); assert.equal(p.snapshot!().remediationUsed, true);
    const exhausted = policy(); assert.equal((exhausted.checkFinish!({ turn: 1, remainingTurns: 0 }) as any).finish.reason, "max_turns"); assert.equal(exhausted.snapshot!().remediationUsed, false);
  });
  await test("补救取得文档后恢复 auto，话题切换与会话不继承证据", () => {
    const p = policy(); p.prepareTurn!(1); p.checkFinish!({ turn: 1, remainingTurns: 3 }); p.prepareTurn!(2); feed(p, "search_dcs_knowledge", knowledge);
    assert.equal(p.afterTools!(), undefined); assert.equal(p.prepareTurn!(3).toolChoice, "auto"); assert.equal(p.checkFinish!({ turn: 3, remainingTurns: 1 }), undefined);
    const next = policy("那其他厂区呢？", { history }); assert.equal(next.snapshot!().evidenceObtained, false); assert.equal(next.prepareTurn!(1).toolChoice, "required");
    assert.equal(prepareEvidenceRun("谢谢", tools, { defaultEvidence: true, history }).policy, undefined);
  });
  await test("显式源码兼容入口仍只认源码，不把文档和导航替代源码", () => {
    const p = policy("/查源码 测试"); assert.deepEqual(p.prepareTurn!(1).toolNames, ["search_dcs_code", "read_dcs_code"]);
    feed(p, "search_dcs_knowledge", knowledge); feed(p, "navigate_dcs_menu", { status: "opened", ok: true, message: "已打开" });
    assert.equal(p.snapshot!().evidenceObtained, false); assert.equal(p.afterTools!(), undefined);
  });
  await test("已登记目标的无关源码不能满足门槛，源码取得状态仍保留", () => {
    const p = policy("合成业务规则？", { verifiedTargets: [target], indexState: { indexSha256: "synthetic-index" } });
    feed(p, "read_dcs_code", { files: [{ status: "success", path: "Controllers/Other.cs", lines: [{ line: 8, text: "return other;" }] }] });
    assert.equal(p.snapshot!().sourceContentObtained, true); assert.equal(p.snapshot!().evidenceObtained, false);
    assert.equal(p.snapshot!().targetSourceContentObtained, false); assert.equal(p.snapshot!().targetResolution, "unconfirmed");
    assert.match((p.checkFinish!({ turn: 2, remainingTurns: 2 }) as any).retry, /无关源码/);
    assert.deepEqual(p.snapshot!().sourceMapState, { indexSha256: "synthetic-index" });
  });
  await test("只有已返回且位于直接引用范围的代码确认目标关系，路由及同文件其他范围不算", () => {
    const p = policy("合成业务规则？", { verifiedTargets: [target] });
    for (const [file, line] of [["App_Start/Routes.cs", 3], ["Controllers/Example.cs", 30]] as const) {
      feed(p, "read_dcs_code", { files: [{ status: "success", path: file, lines: [{ line, text: "return value;" }] }] });
      assert.equal(p.snapshot!().evidenceObtained, false);
    }
    feed(p, "read_dcs_code", source);
    assert.equal(p.snapshot!().targetSourceContentObtained, true); assert.equal(p.snapshot!().evidenceObtained, true);
    assert.equal(p.snapshot!().targetResolution, "mapped_source_obtained"); assert.equal(p.checkFinish!({ turn: 2, remainingTurns: 2 }), undefined);
    const relations = p.snapshot!().sourceRelations as any[];
    assert.equal(relations[1].candidates[0].relation, "mapped_file_outside_reference"); assert.equal(relations[2].relation, "direct_reference");
  });
  await test("同名多候选不自动选择胜者，读取一项不会声称其他对象已确认", () => {
    const other = { ...target, page: "/Other/Index", controller: "OtherController", references: target.references.map(r => ({ ...r, path: r.path.replace("Example", "Other") })) };
    const p = policy("合成业务规则？", { verifiedTargets: [target, other] }); feed(p, "read_dcs_code", source);
    assert.equal(p.snapshot!().targetResolution, "multiple_candidates"); assert.equal((p.snapshot!().candidateBusinesses as unknown[]).length, 2);
    assert.deepEqual((p.snapshot!().sourceRelations as any[])[0].candidates.map((c: any) => c.page), ["/Example/Index"]);
    assert.match(p.systemPromptSuffix!, /不自动选择第一项/);
  });
  await test("无地图仍可调查，但无效或不完整动态地图不能建立目标门槛", () => {
    const p = policy("未登记规则？"); feed(p, "search_dcs_code", { status: "success", items: [target], indexVersion: 1, indexSha256: "synthetic" }, { mode: "feature" });
    assert.equal(p.snapshot!().evidenceObtained, false); assert.equal((p.snapshot!().discoveredMapCandidates as unknown[]).length, 1);
    feed(p, "read_dcs_code", source); assert.equal(p.snapshot!().evidenceObtained, true);
    assert.equal(p.snapshot!().targetSourceContentObtained, false); assert.equal(p.snapshot!().targetResolution, "unmapped");
  });
  await test("实际feature已校验映射建立目标门槛，但地图自身仍非证据", () => {
    const p = policy("未登记别名的实际规则？");
    const feature = { status: "success", items: [target], indexVersion: 1, indexSha256: "e".repeat(64) };
    feed(p, "search_dcs_code", feature, { mode: "feature" });
    assert.equal((p.snapshot!().candidateBusinesses as unknown[]).length, 1);
    assert.equal(p.snapshot!().evidenceObtained, false); assert.equal(p.snapshot!().sourceContentObtained, false);
    feed(p, "read_dcs_code", { files: [{ status: "success", path: "Controllers/Unrelated.cs", lines: [{ line: 8, text: "return other;" }] }] });
    assert.equal(p.snapshot!().sourceContentObtained, true); assert.equal(p.snapshot!().evidenceObtained, false);
    assert.match((p.checkFinish!({ turn: 2, remainingTurns: 2 }) as any).retry, /无关源码/);
    feed(p, "read_dcs_code", source); assert.equal(p.snapshot!().evidenceObtained, true); assert.equal(p.snapshot!().targetSourceContentObtained, true);
  });
  await test("动态映射合并保留全部预载目标且重复结果不重复候选", () => {
    const other = { ...target, name: "其他合成业务", page: "/Other/Index", controller: "OtherController", references: target.references.map(r => ({ ...r, path: r.path.replace("Example", "Other") })) };
    const p = policy("合成业务？", { verifiedTargets: [target, other] });
    const feature = { status: "success", items: [target], indexVersion: 1, indexSha256: "e".repeat(64) };
    feed(p, "search_dcs_code", feature, { mode: "feature" }); feed(p, "search_dcs_code", feature, { mode: "feature" });
    assert.equal((p.snapshot!().candidateBusinesses as unknown[]).length, 2);
    assert.equal(p.snapshot!().targetResolution, "multiple_candidates");
    assert.equal((p.snapshot!().candidateBusinesses as SourceEntry[])[0].references.length, target.references.length);
  });
  await test("feature无版本、失效引用、未验证项目及后处理丢失内容不能提升为目标", () => {
    for (const entry of [
      { ...target, verification: { ...target.verification, status: "unverified" } },
      { ...target, references: target.references.map(r => ({ ...r, sha256: "invalid" })) },
      { ...target, references: target.references.map(r => ({ ...r, endLine: 0 })) },
      { ...target, references: target.references.filter(r => r.role !== "view") },
      { ...target, references: target.references.map(r => ({ ...r, path: "../outside.cs" })) },
    ]) {
      const p = policy(); feed(p, "search_dcs_code", { status: "success", items: [entry], indexVersion: 1, indexSha256: "e".repeat(64) }, { mode: "feature" });
      assert.deepEqual(p.snapshot!().candidateBusinesses, []);
    }
    for (const result of [{ status: "success", items: [target], indexSha256: "e".repeat(64) }, "post-hook removed"] ) {
      const p = policy(); feed(p, "search_dcs_code", result, { mode: "feature" }); assert.deepEqual(p.snapshot!().candidateBusinesses, []);
    }
  });
  await test("跨目录已登记实现可以建立关系，未证明的公共依赖仍可读取但保持未确认", () => {
    const p = policy("合成业务规则？", { verifiedTargets: [target] }); p.prepareTurn!(1);
    assert.ok(p.prepareTurn!(2).toolNames!.includes("read_dcs_code"));
    feed(p, "read_dcs_code", { files: [{ status: "success", path: "Other/UnprovenBase.cs", lines: [{ line: 4, text: "class SharedBase {}" }] }] });
    assert.equal(p.snapshot!().targetSourceContentObtained, false);
    feed(p, "read_dcs_code", { files: [{ status: "success", path: "Common\\SharedRule.cs", lines: [{ line: 4, text: "return matched;" }] }] });
    assert.equal(p.snapshot!().targetSourceContentObtained, true);
  });
  await test("目标关联不把文档问题变成源码问题，也不跨 Run 继承读取关系", () => {
    const p = policy("合成业务怎么申请？", { verifiedTargets: [target] }); feed(p, "search_dcs_knowledge", knowledge);
    assert.equal(p.snapshot!().evidenceObtained, true); assert.equal(p.snapshot!().targetSourceContentObtained, false);
    const next = policy("合成业务还有什么规则？", { verifiedTargets: [target], history });
    assert.equal(next.snapshot!().evidenceObtained, false); assert.equal(next.snapshot!().sourceContentObtained, false);
    assert.deepEqual(next.snapshot!().sourceRelations, []);
  });
  console.log(`Evidence V2: ${passed} passed (synthetic offline; no model or database)`);
} finally {
  if (previous === undefined) delete process.env.DCS_SOURCE_ROOT; else process.env.DCS_SOURCE_ROOT = previous;
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("dcs-evidence-v2-")) throw new Error("Unexpected cleanup path");
  rmSync(root, { recursive: true, force: true });
}
