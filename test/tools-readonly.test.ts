/** 真实rg/文件读取 + 临时源码 + 假Oracle；不连接模型或真实数据库。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import oracledb from "oracledb";
import { searchDcsCodeTool as search, readDcsCodeTool as read, readDcsResultTool as resultReader, inspectDcsSchemaTool as schema, queryDcsDataTool as query, dcsTools } from "../src/dcs/tools.ts";
import { getDbClient, closeDbClient, setDbClientFactoryForTest, type DbClient, type DbBinds, type DbQueryResult } from "../src/dcs/db/client.ts";
import { guardSql } from "../src/dcs/db/guard.ts";
import { createMockSession, type DcsToolContext } from "../src/dcs/session.ts";
import { createDcsAgent } from "../src/dcs/agent-factory.ts";
import type { StreamFn, ToolOutput } from "../src/core/types.ts";

const testParent = path.resolve("data");
await fs.mkdir(testParent, { recursive: true });
const root = await fs.mkdtemp(path.join(testParent, "dcs-readonly-"));
const saved = { ...process.env };
process.env.DCS_TOOL_OUTPUT_DIR = path.join(root, "results");
process.env.DCS_SOURCE_ROOT = root;
process.env.DCS_DB_SCHEMA = "DCS";
const ctx: DcsToolContext = { session: createMockSession() };
const decode = (r: ToolOutput) => JSON.parse(r.output);
let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`✓ ${name}`); }
let calls: Array<{ sql: string; binds?: DbBinds }> = [];
let answer: DbQueryResult = { columns: ["VALUE"], rows: [[1]] };
const fake: DbClient = { async execute(sql, binds) { calls.push({ sql, binds }); return answer; }, async close() {} };
const file = path.join(root, "中文 space", "Dorm.cs");
await fs.mkdir(path.dirname(file));
await fs.writeFile(file, "class Dorm {\n // 宿舍名单\n public string Name;\n}\n");
try {
  await test("注册只读工具，无Shell入口", async () => {
    assert.deepEqual(dcsTools.map(t => t.name), ["search_dcs_knowledge", "search_dcs_code", "read_dcs_code", "inspect_dcs_schema", "query_dcs_data", "read_dcs_result"]);
  });
  await test("真实rg搜索中文空格路径，文本/正则/文件名/分页", async () => {
    const found = decode(await search.execute({ mode: "files", pattern: "*Dorm*" }, ctx));
    assert.ok(found.items, JSON.stringify(found)); assert.equal(found.items.length, 1); assert.match(found.items[0].path, /Dorm.cs/);
    const r = await search.execute({ mode: "text", pattern: "宿舍", glob: "*.cs", contextLines: 0 }, ctx);
    assert.equal(r.isError, undefined, r.output); assert.equal(decode(r).items[0].line, 2);
    const page = decode(await search.execute({ mode: "text", pattern: "class|public", regex: true, contextLines: 0, limit: 1 }, ctx));
    assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 1);
    const next = decode(await search.execute({ mode: "text", pattern: "class|public", regex: true, contextLines: 0, offset: page.nextOffset, limit: 1 }, ctx));
    assert.equal(next.items[0].line, 3); assert.equal(next.hasMore, false);
    const empty = await search.execute({ mode: "text", pattern: "NoSuchText" }, ctx);
    assert.equal(decode(empty).status, "empty"); assert.ok(!empty.isError);
    assert.equal((await search.execute({ mode: "text", pattern: "[", regex: true }, ctx)).isError, true);
  });
  await test("批量源码读取、长行无损续读、局部失败", async () => {
    const r = decode(await read.execute({ files: [{ path: file, startLine: 2, lineCount: 1 }, { path: "missing.cs" }] }, ctx));
    assert.match(r.files[0].lines[0].text, /宿舍/); assert.equal(r.files[0].next.startLine, 3); assert.equal(r.files[1].status, "read_error");
    const long = path.join(root, "long.cs"); await fs.writeFile(long, "中".repeat(24001));
    let next: any = {}; let text = "";
    do {
      const page = decode(await read.execute({ files: [{ path: long, ...next }] }, ctx)).files[0];
      text += page.lines.map((l: any) => l.text).join(""); next = page.next;
    } while (next);
    assert.equal(text, "中".repeat(24001));
  });
  await test("目录越界与链接越界不可读，命令文本不会执行", async () => {
    const before = await fs.readFile(file, "utf8");
    assert.equal((await read.execute({ files: [{ path: "../outside.cs" }] }, ctx)).isError, true);
    assert.equal((await search.execute({ mode: "files", pattern: "*", directory: ".." }, ctx)).isError, true);
    assert.equal((await search.execute({ mode: "text", pattern: "x", command: "Remove-Item x" } as any, ctx)).isError, true);
    const literal = await search.execute({ mode: "text", pattern: "--pre=cmd; Remove-Item Dorm.cs" }, ctx);
    assert.equal(decode(literal).status, "empty"); assert.equal(await fs.readFile(file, "utf8"), before);
    const outside = await fs.mkdtemp(path.join(testParent, "dcs-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.cs"), "outside-only-marker");
      const link = path.join(root, "linked"); await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      assert.equal((await read.execute({ files: [{ path: path.join(link, "secret.cs") }] }, ctx)).isError, true);
      assert.equal((await search.execute({ mode: "text", pattern: "outside-only-marker", directory: link }, ctx)).isError, true);
      assert.equal(decode(await search.execute({ mode: "text", pattern: "outside-only-marker" }, ctx)).items.length, 0);
      await fs.unlink(link);
    } finally {
      if (path.dirname(outside) !== path.resolve(testParent) || !path.basename(outside).startsWith("dcs-outside-")) throw new Error("临时目录不匹配");
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  await test("取消与参数错误不执行搜索或读取", async () => {
    const holder = { controller: new AbortController() }; holder.controller.abort();
    assert.equal(decode(await search.execute({ mode: "files", pattern: "*" }, { ...ctx, holder })).status, "cancelled");
    assert.equal(decode(await read.execute({ files: [{ path: file }] }, { ...ctx, holder })).status, "cancelled");
    assert.equal((await read.execute({ files: [{ path: file, startLine: 0 }] }, ctx)).isError, true);
    assert.equal((await search.execute({ mode: "text", pattern: "x", limit: 0 }, ctx)).isError, true);
  });
  setDbClientFactoryForTest(() => fake);
  await test("SQL通用查询与绑定值，不触发旧业务目录", async () => {
    calls = []; answer = { columns: ["AMOUNT", "NOTE"], rows: [["9007199254740993.01", "完整长文本".repeat(100)]] };
    const r = decode(await query.execute({ sql: "WITH x AS (SELECT :amount AMOUNT FROM DUAL) SELECT * FROM x;", binds: { amount: "9007199254740993.01", other: null }, previewRows: 1 }, ctx));
    assert.equal(r.complete, true); assert.equal(r.rows[0][0], "9007199254740993.01");
    assert.equal(calls.length, 1); assert.equal(calls[0].sql.endsWith(";"), false); assert.equal(calls[0].binds?.other, null);
    const full = JSON.parse(await fs.readFile(r.resultFile, "utf8")); assert.equal(full.rows[0][1], answer.rows[0][1]);
  });
  await test("SQL查询范围检查不误拒字符串/标识符中的关键字", async () => {
    assert.ok(guardSql(`SELECT 'update; -- abc', q'[delete;]' AS "DROP" FROM DUAL`).ok);
    assert.equal((await query.execute({ sql: "UPDATE t SET x=1" }, ctx)).isError, true);
    assert.equal((await query.execute({ sql: "SELECT 1 FROM DUAL; SELECT 2 FROM DUAL" }, ctx)).isError, true);
    assert.equal((await query.execute({ sql: "SELECT :a FROM DUAL", binds: { a: Infinity } }, ctx)).isError, true);
    assert.equal((await query.execute({ query: "list_available" } as any, ctx)).isError, true);
  });
  await test("分批完整结果超过1000行，受限工具读取全部分页", async () => {
    setDbClientFactoryForTest(() => ({ ...fake, async stream(_sql, _binds, consume) {
      for (let i = 0; i < 12; i++) await consume({ columns: ["N"], columnTypes: [{ name: "N", type: "NUMBER" }], rows: Array.from({ length: 100 }, (_, j) => [String(i * 100 + j)]) });
    } }));
    const r = decode(await query.execute({ sql: "SELECT N FROM TEST", previewRows: 2 }, ctx));
    assert.equal(r.fetchedRows, 1200); assert.equal(r.rows.length, 2); assert.equal(r.complete, true); assert.equal(r.previewTruncated, true);
    let offset = 0, total = 0, count = 0;
    do {
      const page = decode(await resultReader.execute({ resultFile: r.resultFile, select: ["rows"], offset, limit: 100 }, ctx));
      assert.equal(page.sourceComplete, true);
      for (const entry of page.entries) { count++; total += Number(entry.value[0]); }
      if (!page.hasMore) break; offset = page.nextOffset;
    } while (true);
    assert.equal(count, 1200); assert.equal(total, 719400);
  });
  await test("中途Oracle错误留下可解析的部分文件和诊断位置", async () => {
    setDbClientFactoryForTest(() => ({ ...fake, async stream(_sql, _binds, consume) {
      await consume({ columns: ["N"], rows: [[1]] }); throw Object.assign(new Error('ORA-00904: "BAD_FIELD": invalid identifier'), { offset: 12 });
    } }));
    const result = await query.execute({ sql: "SELECT BAD_FIELD FROM T" }, ctx), r = decode(result);
    assert.equal(result.isError, true); assert.equal(r.offset, 12); assert.match(r.diagnostic, /BAD_FIELD/); assert.equal(r.complete, false);
    assert.equal(JSON.parse(await fs.readFile(r.resultFile, "utf8")).complete, false);
    assert.equal(decode(await resultReader.execute({ resultFile: r.resultFile, select: ["rows"] }, ctx)).sourceComplete, false);
  });
  await test("取消查询不报告完整结果；空数据和驱动截断分别表达", async () => {
    const holder = { controller: new AbortController() };
    setDbClientFactoryForTest(() => ({ ...fake, async stream(_sql, _binds, consume) { await consume({ columns: ["N"], rows: [[1]] }); holder.controller.abort(); } }));
    const r = decode(await query.execute({ sql: "SELECT N FROM T" }, { ...ctx, holder }));
    assert.equal(r.status, "cancelled"); assert.equal(r.complete, false);
    setDbClientFactoryForTest(() => fake); answer = { columns: ["N"], rows: [] };
    assert.equal(decode(await query.execute({ sql: "SELECT N FROM T" }, ctx)).status, "empty");
    answer = { columns: ["N"], rows: [[1]], truncated: true };
    assert.equal(decode(await query.execute({ sql: "SELECT N FROM T", previewRows: 0 }, ctx)).complete, false);
  });
  await test("结构搜索绑定中文关键词、支持其他schema并返回分页", async () => {
    calls = []; answer = { columns: ["OBJECT_NAME", "COLUMN_NAME", "COMMENTS", "DCS_PAGE_ROW"], rows: [["T1", "C1", "入职日期", 1], ["T2", "C2", "入职日期", 2]] };
    const r = decode(await schema.execute({ operation: "search", schema: "OTHER", keyword: "入职", searchIn: ["comment"], limit: 1 }, ctx));
    assert.equal(r.owner, "OTHER"); assert.equal(r.hasMore, true); assert.equal(r.nextOffset, 1); assert.equal(r.items[0].DCS_PAGE_ROW, undefined);
    assert.equal(calls[0].binds?.keyword, "入职"); assert.match(calls[0].sql, /ALL_COL_COMMENTS/);
  });
  await test("结构描述覆盖默认值、注释、约束、索引和依赖", async () => {
    calls = []; answer = { columns: ["NAME"], rows: [["found"]] };
    const r = decode(await schema.execute({ operation: "describe", objects: ["T1", "T2"] }, ctx));
    assert.equal(calls.length, 10); assert.equal(r.objects.length, 2);
    assert.ok(calls.some(c => c.sql.includes("DATA_DEFAULT"))); assert.ok(calls.some(c => c.sql.includes("ALL_IND_COLUMNS")));
    assert.ok(calls.some(c => c.sql.includes("ALL_DEPENDENCIES")));
  });
  await test("定义读取程序源码分页、视图SQL、同义词", async () => {
    calls = []; answer = { columns: ["TEXT"], rows: [["line 1"], ["line 2"]] };
    const r = decode(await schema.execute({ operation: "definition", objects: ["V1"], limit: 1 }, ctx));
    assert.equal(r.complete, false); assert.equal(r.objects[0].nextOffset, 1);
    assert.ok(calls.some(c => c.sql.includes("ALL_SOURCE"))); assert.ok(calls.some(c => c.sql.includes("ALL_VIEWS"))); assert.ok(calls.some(c => c.sql.includes("ALL_SYNONYMS")));
    assert.equal((await schema.execute({ operation: "describe", objects: [] }, ctx)).isError, true);
  });
  await test("结构大结果完整落盘，不静默删字段", async () => {
    answer = { columns: ["TEXT"], rows: [["完整定义".repeat(10000)]] };
    const r = decode(await schema.execute({ operation: "describe", objects: ["T1"], include: ["columns"] }, ctx));
    assert.equal(r.previewTruncated, true);
    const summary = decode(await resultReader.execute({ resultFile: r.resultFile }, ctx));
    assert.ok(summary.entries.some((e: any) => e.partial));
    let offset = 0, text = "";
    do {
      const page = decode(await resultReader.execute({ resultFile: r.resultFile, select: ["objects", 0, "columns", 0, "TEXT"], offset, limit: 16000 }, ctx));
      text += page.text;
      if (!page.hasMore) break; offset = page.nextOffset;
    } while (true);
    assert.equal(text, "完整定义".repeat(10000));
    assert.equal((await resultReader.execute({ resultFile: file }, ctx)).isError, true);
    assert.equal((await resultReader.execute({ resultFile: r.resultFile, select: ["__proto__"] }, ctx)).isError, true);
    assert.equal((await resultReader.execute({ resultFile: r.resultFile, command: "x" } as any, ctx)).isError, true);
  });
  await test("生产Oracle客户端使用ResultSet逐批读取并释放连接", async () => {
    const original = oracledb.createPool;
    let fetches = 0, closed = 0, rolledBack = 0, rsClosed = 0;
    const sqls: string[] = [];
    (oracledb as any).createPool = async () => ({ async getConnection() { return {
      async execute(sql: string, _binds?: unknown, options?: any) {
        sqls.push(sql);
        if (sql === "SET TRANSACTION READ ONLY") return {};
        assert.equal(options.resultSet, true);
        assert.equal(options.fetchTypeHandler({ dbType: oracledb.DB_TYPE_NUMBER }).type, oracledb.STRING);
        return { metaData: [{ name: "N", dbTypeName: "NUMBER" }], resultSet: { async getRows(n: number) { assert.equal(n, 256); return fetches++ < 5 ? Array.from({length:256}, () => ["12345678901234567890"]) : []; }, async close() { rsClosed++; } } };
      }, async rollback() { rolledBack++; }, async close() { closed++; }, async break() {},
    }; }, async close() {} });
    process.env.DCS_DB_USER = "fixture"; process.env.DCS_DB_PASSWORD = "fixture"; process.env.DCS_DB_CONNECT_STRING = "fixture";
    setDbClientFactoryForTest(null);
    try {
      const r = decode(await query.execute({ sql: "SELECT N FROM T", previewRows: 1 }, ctx));
      assert.equal(r.fetchedRows, 1280); assert.equal(r.complete, true); assert.equal(r.rows[0][0], "12345678901234567890");
      assert.deepEqual(sqls, ["SET TRANSACTION READ ONLY", "SELECT N FROM T"]); assert.equal(rsClosed, 1); assert.equal(rolledBack, 1); assert.equal(closed, 1);
    } finally { await closeDbClient(); oracledb.createPool = original; setDbClientFactoryForTest(() => fake); }
  });
  await test("单Agent真实工具接线：源码读取→SQL→最终回答", async () => {
    answer = { columns: ["N"], rows: [[2]] };
    let turn = 0;
    const streamFn: StreamFn = async function* (req) {
      assert.equal(req.tools.some(t => t.name === "exec_command"), false);
      assert.equal(req.systemPrompt.includes("list_available"), false);
      if (turn < 2) {
        const name = turn === 0 ? "read_dcs_code" : "query_dcs_data";
        const args = turn === 0 ? { files: [{ path: file }] } : { sql: "SELECT N FROM T" };
        yield { type: "tool_call_start", index: 0, toolCallId: `hybrid-${turn}`, name };
        yield { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(args) };
        yield { type: "message_end", stopReason: "toolCalls" }; turn++;
      } else {
        assert.ok(req.messages.some(m => m.role === "toolResult" && m.toolName === "query_dcs_data" && JSON.parse(m.content).complete));
        yield { type: "text_delta", text: "查到2" }; yield { type: "message_end", stopReason: "stop" };
      }
    };
    const agent = createDcsAgent({ session: ctx.session, holder: { controller: new AbortController() }, streamFn });
    assert.equal(await agent.prompt("查代码并查数据"), "查到2");
  });
  console.log(`Read-only tools: ${passed} passed`);
} finally {
  setDbClientFactoryForTest(null);
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  const resolved = path.resolve(root), temp = path.resolve(testParent) + path.sep;
  if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith("dcs-readonly-")) throw new Error("临时目录不匹配");
  await fs.rm(resolved, { recursive: true, force: true });
}
