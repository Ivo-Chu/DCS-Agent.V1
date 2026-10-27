import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { Agent } from "../src/core/agent.ts";
import { attachRunObserver } from "../src/observability/observer.ts";
import { listLogs, readLog } from "../src/web/log-reader.ts";
import { createWebServer } from "../src/web/server.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "dcs-log-view-"));
const directory = path.join(root, "web-logins", "fixture", "conversation");
let call = 0;
const long = "日志内容".repeat(3000) + "END_MARKER";
const agent = new Agent({ systemPrompt: "测试 prompt", toolContext: {}, tools: [{
    name: "fixture", label: "测试工具", description: "测试工具", parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async () => ({ output: long }),
}], streamFn: async function* (request) {
    assert.equal(request.tools[0].name, "fixture");
    if (call++ === 0) {
        yield { type: "tool_call_start", index: 0, toolCallId: "call1", name: "fixture" };
        yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"query":"hello"}' };
        yield { type: "message_end", stopReason: "toolCalls" };
    } else {
        yield { type: "text_delta", text: "最终回复 password=SYNTH_SECRET" };
        yield { type: "message_end", stopReason: "stop" };
    }
} });
const observer = attachRunObserver(agent, { channel: "test", logsDir: directory, write: null });
await agent.prompt("测试提问");
await observer.end("detached");
const runs = await listLogs(root);
assert.equal(runs.length, 1); assert.equal(runs[0].turns, 2); assert.equal(runs[0].question, "测试提问");
const { records } = await readLog(root, runs[0].file);
assert.equal(records.find(r => r.event === "model_call_start")!.toolSchemas[0].name, "fixture");
assert.equal(records.find(r => r.event === "tool_end")!.resultText, long);
assert.equal(records.find(r => r.event === "model_call_start" && r.turn === 2)!.contextMessages[2].content, long);
assert.match(records.find(r => r.event === "model_call_end" && r.turn === 2)!.output.content, /最终回复/);
assert.ok(!JSON.stringify(records).includes("SYNTH_SECRET"));
await mkdir(path.join(root, "legacy"));
await writeFile(path.join(root, "legacy", "old.jsonl"), '{"event":"run_start","runId":"old"}\n{"event":');
assert.equal((await readLog(root, "legacy/old.jsonl")).skippedLines, 1);
const server = createWebServer({ dataFile: ":memory:", logsDir: root, logger: () => {} });
// Read APIs do not require, refresh, or create a chat login.
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
try {
    // Recovery removes orphan Web logs; legacy remains readable.
    const list = await (await fetch(base + "/api/logs")).json() as any;
    assert.ok(list.ok); assert.ok(list.runs.some((r: any) => r.runId === "old"));
    const detail = await (await fetch(base + "/api/log?file=legacy%2Fold.jsonl")).json() as any;
    assert.equal(detail.skippedLines, 1);
    assert.equal((await fetch(base + "/api/log?file=..%2Fpackage.json")).status, 404);
    assert.equal((await fetch(base + "/api/log?file=missing.jsonl")).status, 404);
    assert.equal((await fetch(base + "/api/conversations")).status, 401);
} finally {
    server.closeAllConnections(); server.close(); await once(server, "close");
    await rm(root, { recursive: true, force: true });
}
console.log("Log viewer: full two-turn snapshots, final output, redaction, legacy/partial logs and HTTP APIs passed");
