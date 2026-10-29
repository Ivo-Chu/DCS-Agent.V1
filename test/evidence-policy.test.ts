/** DCS evidence policy only: synthetic payloads, no model or database. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareEvidenceRun } from "../src/dcs/evidence.ts";
import type { RunPolicy, ToolCall, ToolResultMessage, ToolSchema } from "../src/core/types.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "dcs-evidence-policy-"));
const previousRoot = process.env.DCS_SOURCE_ROOT;
process.env.DCS_SOURCE_ROOT = root;
const tools: ToolSchema[] = ["search_dcs_code", "read_dcs_code", "query_authorized_data"].map(name => ({ name, description: "synthetic", parameters: {} }));
const newPolicy = () => prepareEvidenceRun("/查源码 测试规则", tools).policy!;
function feed(policy: RunPolicy, name: string, data: unknown, args: unknown = {}, isError = false, id = "fixture-1") {
  const call: ToolCall = { id, name, arguments: JSON.stringify(args) };
  const result: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: name, content: JSON.stringify(data), isError };
  policy.onToolResult!(call, result);
}
const read = (file = "Controllers/Example.cs", text = "return employee;", line: unknown = 7) => ({ files: [{ path: file, status: "success", lines: [{ line, text }] }] });
const search = (overrides: object = {}) => ({ status: "success", items: [{ path: "Example.cs", line: 3, kind: "source", text: "class Example {}", ...overrides }] });
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`✓ ${name}`); }
try {
  test("只有开头独立指令触发，普通文本保持原样", () => {
    for (const text of ["权限为什么不对", "请 /查源码 示例", "/查源码示例", "  普通聊天 "]) assert.deepEqual(prepareEvidenceRun(text, tools), { text });
    assert.equal(prepareEvidenceRun(" \n/查源码\n 实际规则？ ", tools).text, "实际规则？");
    assert.equal(newPolicy().snapshot!().requireEvidence, true);
  });
  test("空指令和无可用源码能力在模型调用前直接返回说明", () => {
    assert.match(prepareEvidenceRun("/查源码 \n", tools).policy!.prepareTurn!(1).finish!.text, /补充/);
    assert.equal(prepareEvidenceRun("/查源码 问题", []).policy!.prepareTurn!(1).finish!.reason, "source_tools_unavailable");
    process.env.DCS_SOURCE_ROOT = path.join(root, "missing");
    assert.equal(newPolicy().prepareTurn!(1).finish!.reason, "source_tools_unavailable");
    process.env.DCS_SOURCE_ROOT = root;
  });
  test("首轮 required 仅提供已注册源码工具，后续恢复 auto", () => {
    const policy = newPolicy();
    assert.deepEqual(policy.prepareTurn!(1), { toolChoice: "required", toolNames: ["search_dcs_code", "read_dcs_code"] });
    assert.deepEqual(policy.prepareTurn!(2), { toolChoice: "auto" });
    const one = prepareEvidenceRun("/查源码 问题", [tools[1]]).policy!;
    assert.deepEqual(one.prepareTurn!(1), { toolChoice: "required", toolNames: ["read_dcs_code"] });
  });
  test("仅路径、地图、资源标签、空结果和错误均不算源码内容", () => {
    for (const [name, payload, args, error] of [
      ["search_dcs_code", search(), { mode: "files" }, false],
      ["search_dcs_code", search(), { mode: "feature" }, false],
      ["search_dcs_code", search({ kind: "resource" }), { mode: "text" }, false],
      ["search_dcs_code", search({ path: "App_GlobalResources/Labels.resx" }), { mode: "text" }, false],
      ["search_dcs_code", search({ path: "Resources/Labels.js" }), { mode: "text" }, false],
      ["search_dcs_code", search({ text: "" }), { mode: "text" }, false],
      ["search_dcs_code", { status: "empty", items: [] }, { mode: "text" }, false],
      ["search_dcs_code", { status: "read_error", items: search().items }, { mode: "text" }, false],
      ["read_dcs_code", read("App_GlobalResources/Labels.Designer.cs"), {}, false],
      ["read_dcs_code", read("Resources\\Labels.js"), {}, false],
      ["read_dcs_code", read("Other.txt"), {}, false],
      ["read_dcs_code", read("Example.cs", "  "), {}, false],
      ["read_dcs_code", read("Example.cs", "code", 0), {}, false],
      ["read_dcs_code", read("Example.cs", "code", "1"), {}, false],
      ["read_dcs_code", read(""), {}, false],
      ["read_dcs_code", { files: [{ path: "Example.cs", status: "read_error", lines: [{ line: 1, text: "code" }] }] }, {}, false],
      ["read_dcs_code", read(), {}, true],
      ["other_tool", read(), {}, false],
    ] as const) {
      const policy = newPolicy(); feed(policy, name, payload, args, error);
      assert.equal(policy.snapshot!().sourceContentObtained, false, JSON.stringify({ name, payload, args, error }));
    }
  });
  test("成功读取及文本搜索保留调用 ID、路径和行号，批量失败项不计入", () => {
    const policy = newPolicy();
    feed(policy, "read_dcs_code", { files: [...read().files, { path: "Missing.cs", status: "read_error" }] });
    feed(policy, "search_dcs_code", search(), { mode: "text" }, false, "fixture-2");
    assert.deepEqual(policy.snapshot!().sources, [
      { toolCallId: "fixture-1", path: "Controllers/Example.cs", line: 7 },
      { toolCallId: "fixture-2", path: "Example.cs", line: 3 },
    ]);
    assert.equal(policy.checkFinish!({ turn: 2, remainingTurns: 2 }), undefined);
    assert.equal(policy.snapshot!().sourceContentObtained, true);
    assert.equal(policy.snapshot!().remediationUsed, false);
    const snapshot = policy.snapshot!(); (snapshot.sources as any[]).length = 0;
    assert.equal((policy.snapshot!().sources as any[]).length, 2);
  });
  test("实际回填内容无法解析或调用不匹配时不记录", () => {
    const policy = newPolicy();
    const call: ToolCall = { id: "call-1", name: "read_dcs_code", arguments: "{}" };
    for (const fields of [{ content: "post-hook removed" }, { toolCallId: "other-call" }, { toolName: "other-tool" }]) {
      policy.onToolResult!(call, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: JSON.stringify(read()), isError: false, ...fields });
    }
    assert.equal(policy.snapshot!().sourceContentObtained, false);
  });
  test("最多一次补救，失败输出固定说明，成功恢复 auto", () => {
    const failure = newPolicy(); failure.prepareTurn!(1);
    assert.deepEqual(failure.checkFinish!({ turn: 1, remainingTurns: 3 }), { retry: "本次尚未取得可核实的源码内容。文件路径和业务索引不等于源码证据。请继续搜索或读取实际源码；无法取得时不得编造业务结论。" });
    assert.equal(failure.snapshot!().remediationUsed, true);
    assert.equal(failure.prepareTurn!(2).toolChoice, "required");
    assert.equal(failure.afterTools!()!.text, "本次未能取得可核实的源码内容，暂时无法确认该功能的实际规则。");
    assert.ok("finish" in failure.checkFinish!({ turn: 2, remainingTurns: 2 })!);
    const success = newPolicy(); success.prepareTurn!(1); success.checkFinish!({ turn: 1, remainingTurns: 3 }); success.prepareTurn!(2);
    feed(success, "read_dcs_code", read());
    assert.equal(success.afterTools!(), undefined);
    assert.deepEqual(success.prepareTurn!(3), { toolChoice: "auto" });
    assert.equal(success.checkFinish!({ turn: 3, remainingTurns: 1 }), undefined);
  });
  test("预算不足不补救，每次请求独立且普通输入不继承状态", () => {
    const exhausted = newPolicy();
    assert.equal((exhausted.checkFinish!({ turn: 1, remainingTurns: 0 }) as any).finish.reason, "max_turns");
    assert.equal(exhausted.snapshot!().remediationUsed, false);
    feed(exhausted, "read_dcs_code", read());
    const next = newPolicy();
    assert.equal(next.snapshot!().sourceContentObtained, false);
    assert.equal(next.snapshot!().remediationUsed, false);
    assert.equal(next.prepareTurn!(1).toolChoice, "required");
    assert.equal(prepareEvidenceRun("普通后续问题", tools).policy, undefined);
  });
  console.log(`Evidence policy: ${passed} passed (synthetic offline)`);
} finally {
  if (previousRoot === undefined) delete process.env.DCS_SOURCE_ROOT; else process.env.DCS_SOURCE_ROOT = previousRoot;
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("dcs-evidence-policy-")) throw new Error("Unexpected cleanup path");
  rmSync(root, { recursive: true, force: true });
}
