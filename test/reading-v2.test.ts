/** Synthetic real-file reading regressions; these verify transport/coverage metadata, not business correctness. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { StreamFn, ToolOutput } from "../src/core/types.ts";
import { prepareEvidenceRun } from "../src/dcs/evidence.ts";
import { readDcsCodeTool } from "../src/dcs/source-tools.ts";
import { createMockSession, type DcsToolContext } from "../src/dcs/session.ts";
import { validContext } from "../src/web/conversation-store.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "dcs-reading-v2-"));
const priorRoot = process.env.DCS_SOURCE_ROOT;
process.env.DCS_SOURCE_ROOT = root;
const form = ["<form id=\"filters\">", "<input name=\"Factory\" />", "<input name=\"JobType\" />", "<select name=\"Status\"></select>", "</form>", "<script>const init = true;</script>"];
const relatedForm = ["<form id=\"details\">", "<input name=\"FromDate\" type=\"date\" />", "<input name=\"ToDate\" type=\"datetime-local\" />", "</form>"];
const longLine = "A".repeat(12000) + "TAIL";
writeFileSync(path.join(root, "Form.cshtml"), form.join("\n") + "\n");
writeFileSync(path.join(root, "Related.cshtml"), relatedForm.join("\n"));
writeFileSync(path.join(root, "Long.cs"), longLine + "\nreturn 7;\n");
writeFileSync(path.join(root, "Across.cs"), "x".repeat(11997) + "\n" + "y".repeat(20) + "\nlast;\n");
writeFileSync(path.join(root, "Empty.cs"), "");
const ctx: DcsToolContext = { session: createMockSession(), holder: { controller: new AbortController() } };
const decode = (output: ToolOutput): any => JSON.parse(output.output);
const read = (files: Parameters<typeof readDcsCodeTool.execute>[0]["files"], context = ctx) => readDcsCodeTool.execute({ files }, context);
after(() => {
  if (priorRoot === undefined) delete process.env.DCS_SOURCE_ROOT;
  else process.env.DCS_SOURCE_ROOT = priorRoot;
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("dcs-reading-v2-"));
  rmSync(root, { recursive: true, force: true });
});

test("a whole synthetic form reports its exact returned range without claiming business coverage", async () => {
  const result = await read([{ path: "Form.cshtml" }]);
  assert.ok(!result.isError);
  const file = decode(result).files[0];
  assert.deepEqual(file.requestedRange, { startLine: 1, lineCount: 80, startColumn: 0 });
  assert.deepEqual(file.returnedRange, { startLine: 1, endLine: form.length, startColumn: 0, endColumn: form.at(-1)!.length });
  assert.deepEqual(file.lines.map((line: any) => line.text), form);
  assert.equal(file.endReason, "eof");
  assert.equal(file.hasMore, false);
  assert.equal(file.next, null);
  assert.equal(file.coverage, "not_assessed");
});

test("following next across a form and its related page loses no fields or lines", async () => {
  const collected: Array<{ line: number; text: string }> = [];
  let position = { startLine: 1, startColumn: 0 };
  for (let page = 0; page < 3; page++) {
    const file = decode(await read([{ path: "Form.cshtml", ...position, lineCount: 2 }])).files[0];
    assert.deepEqual(file.requestedRange, { ...position, lineCount: 2 });
    assert.equal(file.returnedRange.startLine, position.startLine);
    assert.equal(file.returnedRange.endLine, position.startLine + 1);
    assert.equal(file.returnedRange.endColumn, form[position.startLine]!.length);
    assert.equal(file.coverage, "not_assessed");
    collected.push(...file.lines.map((line: any) => ({ line: line.line, text: line.text })));
    if (page < 2) {
      assert.equal(file.endReason, "line_limit");
      assert.equal(file.hasMore, true);
      assert.deepEqual(file.next, { startLine: position.startLine + 2, startColumn: 0 });
      position = file.next;
    } else { assert.equal(file.endReason, "eof"); assert.equal(file.next, null); }
  }
  assert.deepEqual(collected, form.map((text, index) => ({ line: index + 1, text })));
  const related = decode(await read([{ path: "Related.cshtml" }])).files[0];
  assert.deepEqual(related.lines.map((line: any) => line.text), relatedForm);
  assert.equal(related.coverage, "not_assessed", "reading both files still cannot certify all business dependencies");
});

test("long-line continuation reports exclusive character offsets and rejoins the exact original", async () => {
  const first = decode(await read([{ path: "Long.cs", lineCount: 80 }])).files[0];
  assert.equal(first.endReason, "character_limit");
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.returnedRange, { startLine: 1, endLine: 1, startColumn: 0, endColumn: 12000 });
  assert.deepEqual(first.next, { startLine: 1, startColumn: 12000 });
  const second = decode(await read([{ path: "Long.cs", ...first.next, lineCount: 80 }])).files[0];
  assert.deepEqual(second.requestedRange, { startLine: 1, startColumn: 12000, lineCount: 80 });
  assert.deepEqual(second.returnedRange, { startLine: 1, endLine: 2, startColumn: 12000, endColumn: "return 7;".length });
  assert.equal(first.lines[0].text + second.lines[0].text, longLine);
  assert.equal(second.lines[1].text, "return 7;");
  assert.equal(second.endReason, "eof");
  assert.equal(second.hasMore, false);
  assert.equal(second.next, null);
  assert.equal(second.coverage, "not_assessed");
});

test("the shared character budget can end partway through the second line", async () => {
  const first = decode(await read([{ path: "Across.cs" }])).files[0];
  assert.equal(first.endReason, "character_limit");
  assert.deepEqual(first.returnedRange, { startLine: 1, endLine: 2, startColumn: 0, endColumn: 3 });
  assert.deepEqual(first.next, { startLine: 2, startColumn: 3 });
  const second = decode(await read([{ path: "Across.cs", ...first.next }])).files[0];
  assert.equal(first.lines[1].text + second.lines[0].text, "y".repeat(20));
  assert.equal(second.lines[1].text, "last;");
  assert.equal(second.endReason, "eof");
});

test("an empty file or a start past EOF reports no returned range and provides no source evidence", async () => {
  for (const fileRequest of [{ path: "Empty.cs" }, { path: "Form.cshtml", startLine: 100 }]) {
    const output = await read([fileRequest]);
    const file = decode(output).files[0];
    assert.equal(file.status, "success");
    assert.deepEqual(file.lines, []);
    assert.equal(file.returnedRange, null);
    assert.equal(file.endReason, "eof");
    assert.equal(file.hasMore, false);
    assert.equal(file.coverage, "not_assessed");
    const policy = prepareEvidenceRun("页面有哪些条件？", [readDcsCodeTool], { defaultEvidence: true }).policy!;
    const call = { id: "empty-read", name: readDcsCodeTool.name, arguments: JSON.stringify({ files: [fileRequest] }) };
    policy.onToolResult!(call, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: output.output, isError: !!output.isError });
    assert.equal(policy.snapshot!().sourceContentObtained, false);
  }
});

test("a batch with a missing file retains only successful content and its exact range", async () => {
  const args = { files: [{ path: "Missing.cs" }, { path: "Form.cshtml", startLine: 2, lineCount: 2 }] };
  const output = await readDcsCodeTool.execute(args, ctx), data = decode(output);
  assert.ok(!output.isError);
  assert.equal(data.files[0].status, "read_error");
  assert.equal(data.files[1].status, "success");
  assert.deepEqual(data.files[1].returnedRange, { startLine: 2, endLine: 3, startColumn: 0, endColumn: form[2].length });
  const policy = prepareEvidenceRun("页面有哪些条件？", [readDcsCodeTool], { defaultEvidence: true }).policy!;
  const call = { id: "partial-read", name: readDcsCodeTool.name, arguments: JSON.stringify(args) };
  policy.onToolResult!(call, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: output.output, isError: !!output.isError });
  assert.equal(policy.snapshot!().sourceContentObtained, true);
  assert.deepEqual(policy.snapshot!().sources, [
    { toolCallId: "partial-read", path: "Form.cshtml", line: 2 }, { toolCallId: "partial-read", path: "Form.cshtml", line: 3 },
  ]);
});

test("a cancelled reading request stays an error and cannot produce range evidence", async () => {
  const holder = { controller: new AbortController() }; holder.controller.abort();
  const output = await read([{ path: "Form.cshtml" }], { ...ctx, holder });
  assert.equal(output.isError, true);
  assert.equal(decode(output).status, "cancelled");
  assert.equal(decode(output).files, undefined);
});

test("a scripted Agent can follow next before answering while keeping drafts hidden and tool messages paired", async () => {
  const requests: Parameters<StreamFn>[0][] = [], events: AgentEvent[] = [];
  const streamFn: StreamFn = async function* (request) {
    requests.push(structuredClone(request));
    const last = request.messages.at(-1);
    let args: { files: Array<{ path: string; startLine: number; startColumn: number; lineCount: number }> } | undefined;
    if (last?.role === "user") args = { files: [{ path: "Form.cshtml", startLine: 1, startColumn: 0, lineCount: 3 }] };
    else if (last?.role === "toolResult") {
      const file = JSON.parse(last.content).files[0];
      if (file.next) args = { files: [{ path: file.path, ...file.next, lineCount: 3 }] };
    }
    if (args) {
      yield { type: "text_delta", text: "尚未完整读取的中间说明" };
      yield { type: "tool_call_start", index: 0, toolCallId: `read-${requests.length}`, name: readDcsCodeTool.name };
      yield { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(args) };
      yield { type: "message_end", stopReason: "toolCalls" };
    } else {
      yield { type: "text_delta", text: "合成文件分页读取流程已结束；不代表业务范围验证完成。" };
      yield { type: "message_end", stopReason: "stop" };
    }
  };
  const agent = new Agent({ systemPrompt: "Synthetic offline reading test", tools: [readDcsCodeTool], toolContext: ctx,
    streamFn, maxTurns: 4, prepareRun: text => prepareEvidenceRun(text, [readDcsCodeTool], { defaultEvidence: true }),
  });
  agent.subscribe(event => events.push(structuredClone(event)));
  const final = await agent.prompt("这个合成表单有哪些查询条件？");
  assert.match(final, /分页读取流程已结束/);
  assert.deepEqual(requests.map(request => request.toolChoice), ["required", "auto", "auto"]);
  const results = agent.context.filter(message => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.deepEqual(results.flatMap(result => JSON.parse(result.content).files[0].lines.map((line: any) => line.text)), form);
  assert.ok(validContext(agent.context));
  assert.equal(events.filter(event => event.type === "message_delta").length, 0);
  assert.doesNotMatch(JSON.stringify(agent.context), /尚未完整读取的中间说明/);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /尚未完整读取的中间说明/);
});
