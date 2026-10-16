/** 生产工具 + 临时源码 + 假 Oracle + Fake Model。无需网络或真实凭据。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { investigateDcsCodeTool as code, inspectDcsSchemaTool as schema, queryDcsDataTool as query, dcsTools } from "../src/dcs/tools.ts";
import { CODE_LIMITS } from "../src/dcs/code-tool.ts";
import { setDbClientFactoryForTest, type DbClient, type DbQueryResult } from "../src/dcs/db/client.ts";
import { createSession, createMockSession, type DcsToolContext } from "../src/dcs/session.ts";
import { resetIdentityCache } from "../src/dcs/identity.ts";
import { createDcsAgent } from "../src/dcs/agent-factory.ts";
import type { ToolOutput, StreamFn } from "../src/core/types.ts";
import oracledb from "oracledb";
import { getDbClient, closeDbClient } from "../src/dcs/db/client.ts";

let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`✓ ${name}`); }
const decode = (r: ToolOutput) => JSON.parse(r.output);
const ctx: DcsToolContext = { session: createSession({ employeeNo: "10086", name: "测试员工" }, "verified-wecom-user") };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dcs-v2-"));
const saved = { root: process.env.DCS_SOURCE_ROOT, rg: process.env.DCS_RG_PATH, owner: process.env.DCS_DB_SCHEMA, webTest: process.env.DCS_ALLOW_WEB_TEST_IDENTITY };
const write = async (file: string, text: string) => { const dest = path.join(root, file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, text); };
const runCode = async (args: any) => decode(await code.execute(args, ctx));
let dbCalls: Array<{ sql: string; binds?: Record<string, string | number> }> = [];
let answer: DbQueryResult = { columns: ["ROLE_NAME", "PERMISSION_NAME"], rows: [["员工", "本人菜单"]] };
let fail = "", owners = [["DCS"]], absent = false;
let constraints: DbQueryResult = { columns: ["TABLE_NAME", "CONSTRAINT_TYPE", "COLUMN_NAME"], rows: [] };
const fake: DbClient = {
  async execute(sql, binds) {
    dbCalls.push({ sql, binds });
    if (fail) throw new Error(fail);
    if (sql.includes("SELECT OWNER FROM ALL_TABLES")) return { columns: ["OWNER"], rows: owners };
    if (sql.includes("FROM ALL_TABLES")) return { columns: ["OWNER", "TABLE_NAME"], rows: binds?.keyword === "NONE" ? [] : [["DCS", "S2_PERMISSION"], ["DCS", "S2_ROLE"]] };
    if (sql.includes("FROM ALL_TAB_COLUMNS")) return { columns: ["OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "NULLABLE"], rows: absent ? [] : [["DCS", "S2_ROLE", "CODE", "VARCHAR2", "N"], ["DCS", "S2_PERMISSION", "ID", "NUMBER", "N"]] };
    if (sql.includes("FROM ALL_CONSTRAINTS")) return constraints;
    return answer;
  }, async close() {},
};
try {
  delete process.env.DCS_ALLOW_WEB_TEST_IDENTITY;
  process.env.DCS_SOURCE_ROOT = root;
  process.env.DCS_DB_SCHEMA = "DCS";
  setDbClientFactoryForTest(() => fake);
  await write("Common/Dorm.cs", "first\n宿舍 东莞 入住\n入住登记\npublic void Run() {}\nlast");
  await write("Common/A.cs", "宿舍\n");
  await write("Common/bin/Hidden.cs", "宿舍");
  await write("Common/secrets.json", '{"key":"NEVER_EXPOSE"}');
  await write("Common/Web.config", '<add key="password" value="NEVER_EXPOSE"/>');
  await write("Libraries/Forbidden.cs", "宿舍");
  await write("Common/Token.cs", 'var token = "NEVER_EXPOSE";\n');
  await write("Common/Multiline.cs", 'var password =\n  "NEVER_EXPOSE";\nnormal();');
  await test("A find/glob 稳定排序及分页", async () => {
    const a = await runCode({ operation: "find", pattern: "*.cs", limit: 1 });
    assert.equal(a.items[0].path, "Common/A.cs"); assert.equal(a.hasMore, true);
    assert.equal((await runCode({ operation: "find", pattern: "*.cs", offset: a.nextOffset, limit: 1 })).items[0].path, "Common/Dorm.cs");
    assert.deepEqual(a, await runCode({ operation: "find", pattern: "*.cs", limit: 1 }));
  });
  await test("A literal 空格为连续字符串", async () => {
    const a = await runCode({ operation: "search", pattern: "宿舍 东莞 入住" });
    assert.equal(a.count, 1); assert.equal(a.items[0].line, 2);
    assert.equal((await runCode({ operation: "search", pattern: "宿舍 入住" })).status, "empty");
  });
  await test("A regex 显式 OR 与字面模式区别", async () => {
    assert.equal((await runCode({ operation: "search", pattern: "宿舍|入住", mode: "regex" })).count, 3);
    assert.equal((await runCode({ operation: "search", pattern: "宿舍|入住" })).count, 0);
    assert.equal((await code.execute({ operation: "search", pattern: "[", mode: "regex" }, ctx)).isError, true);
  });
  await test("A read 一基行号及 Windows 路径", async () => {
    const a = await runCode({ operation: "read", path: "Common\\Dorm.cs", offset: 2, limit: 2 });
    assert.deepEqual(a.items.map((x: any) => x.line), [2, 3]); assert.equal(a.nextOffset, 4);
    assert.equal(a.items[0].text, "宿舍 东莞 入住");
    assert.equal((await runCode({ operation: "read", path: "Common/Dorm.cs", offset: 100 })).status, "empty");
  });
  await test("A 不存在文件/关键词明确结果", async () => {
    assert.equal((await code.execute({ operation: "read", path: "Common/Missing.cs" }, ctx)).isError, true);
    assert.equal((await runCode({ operation: "search", pattern: "NO_MATCH" })).status, "empty");
  });
  await test("A 按 operation 严格校验", async () => {
    for (const a of [{}, { operation: "find" }, { operation: "read" }, { operation: "read", path: "Common/A.cs", offset: 0 }, { operation: "find", pattern: "*", limit: 51 }, { operation: "search", pattern: "x", mode: "AND" }, { operation: "find", pattern: "*", unexpected: true }]) assert.equal((await code.execute(a as any, ctx)).isError, true);
  });
  await test("A 顶层/目录/敏感文件/绝对路径越界拒绝", async () => {
    for (const p of ["../outside.cs", "Libraries/Forbidden.cs", "Common/bin/Hidden.cs", "Common/secrets.json", "Common/Web.config", path.join(root, "Common/A.cs"), "C:\\Windows\\system.ini"]) assert.equal((await code.execute({ operation: "read", path: p }, ctx)).isError, true);
    const found = await runCode({ operation: "find", pattern: "*" });
    assert.ok(!JSON.stringify(found).includes("Hidden.cs"));
    assert.ok(!(await code.execute({ operation: "search", pattern: "NEVER_EXPOSE" }, ctx)).output.includes("NEVER_EXPOSE"));
  });
  await test("A junction 越界拒绝", async () => {
    await fs.symlink(path.join(root, "Libraries"), path.join(root, "Common", "Link"), "junction");
    assert.equal((await code.execute({ operation: "read", path: "Common/Link/Forbidden.cs" }, ctx)).isError, true);
  });
  await test("A 行数/输出/单文件大小限制", async () => {
    await write("Common/Long.cs", Array.from({ length: 220 }, () => "x".repeat(1200)).join("\n"));
    const a = await code.execute({ operation: "read", path: "Common/Long.cs", limit: 200 }, ctx);
    assert.ok(a.output.length <= CODE_LIMITS.chars); assert.equal(decode(a).truncated, true);
    assert.ok(decode(a).count < 200);
    await write("Common/Large.cs", "x".repeat(CODE_LIMITS.bytes + 1));
    assert.equal((await code.execute({ operation: "read", path: "Common/Large.cs" }, ctx)).isError, true);
  });
  await test("A 缺失 rg 明确提示且不启动 shell", async () => {
    process.env.DCS_RG_PATH = path.join(root, "missing-rg");
    const result = await code.execute({ operation: "find", pattern: "*" }, ctx);
    assert.equal(result.isError, true); assert.match(result.output, /ripgrep/);
    if (saved.rg === undefined) delete process.env.DCS_RG_PATH; else process.env.DCS_RG_PATH = saved.rg;
  });
  await test("A 跨行凭据在 search/read 中都隐藏", async () => {
    for (const args of [{ operation: "read", path: "Common/Multiline.cs", offset: 2 }, { operation: "search", pattern: "NEVER_EXPOSE", path: "Common/Multiline.cs" }]) {
      const r = await code.execute(args as any, ctx); assert.ok(!r.output.includes("NEVER_EXPOSE")); assert.equal(r.isError, undefined);
    }
    assert.equal((await code.execute({ operation: "search", pattern: "宿舍\n入住" }, ctx)).isError, true);
  });
  await test("B list 命中/空/截断及绑定参数", async () => {
    const a = decode(await schema.execute({ operation: "list", keyword: "S2_", limit: 1 }, ctx));
    assert.equal(a.count, 1); assert.equal(a.truncated, true);
    assert.equal(decode(await schema.execute({ operation: "list", keyword: "NONE" }, ctx)).status, "empty");
    assert.ok(dbCalls.at(-1)?.sql.includes("INSTR")); assert.equal(dbCalls.at(-1)?.binds?.keyword, "NONE");
  });
  await test("B describe 多表实际字段、不伪造外键", async () => {
    const a = decode(await schema.execute({ operation: "describe", tables: ["S2_ROLE", "S2_PERMISSION"] }, ctx));
    assert.equal(a.tables.length, 2); assert.equal(a.tables[0].columns[0].COLUMN_NAME, "CODE");
    assert.deepEqual(a.tables[0].constraints, []); assert.equal(a.tables[0].businessRelationships, "unknown");
    assert.ok(!JSON.stringify(a).includes("本人菜单"));
  });
  await test("B 表不存在/不可见与真实空结果", async () => {
    absent = true;
    const a = decode(await schema.execute({ operation: "describe", tables: ["S2_ROLE"] }, ctx));
    assert.equal(a.status, "empty"); assert.equal(a.tables[0].status, "not_found_or_not_visible"); absent = false;
  });
  await test("B 只返回实际主键/外键，过滤未授权外键端点", async () => {
    constraints = { columns: ["TABLE_NAME", "CONSTRAINT_TYPE", "COLUMN_NAME", "REFERENCED_OWNER", "REFERENCED_TABLE", "REFERENCED_COLUMN"], rows: [
      ["S2_PERMISSION", "P", "ID", null, null, null],
      ["S2_PERMISSION", "R", "PID", "DCS", "S2_PERMISSION", "ID"],
      ["S2_PERMISSION", "R", "HIDDEN", "PRIVATE_OWNER", "SECRET_TABLE", "ID"],
    ] };
    const a = await schema.execute({ operation: "describe", tables: ["S2_PERMISSION"] }, ctx);
    assert.equal(decode(a).tables[0].constraints.length, 2); assert.ok(!a.output.includes("SECRET_TABLE"));
    assert.equal(dbCalls.at(-1)?.sql.includes("rcc.POSITION = cc.POSITION"), true);
    constraints = { columns: ["TABLE_NAME", "CONSTRAINT_TYPE", "COLUMN_NAME"], rows: [] };
  });
  await test("B 非法表名/超量/操作参数错误拒绝", async () => {
    for (const a of [{ operation: "describe", tables: ["X; DROP TABLE X"] }, { operation: "describe", tables: Array(6).fill("S2_ROLE") }, { operation: "list" }, { operation: "list", keyword: "x", limit: -1 }, { operation: "describe", tables: ["S2_ROLE"], keyword: "x" }]) assert.equal(decode(await schema.execute(a as any, ctx)).status, "invalid_args");
  });
  await test("B 非批准Schema/未知身份在访问数据库前拒绝", async () => {
    dbCalls = [];
    assert.equal(decode(await schema.execute({ operation: "describe", tables: ["S2_R_REGACCOM"], schema: "OTHER" }, ctx)).status, "denied");
    assert.equal(decode(await schema.execute({ operation: "list", keyword: "x" }, { session: createMockSession() })).status, "unverifiable");
    assert.equal(dbCalls.length, 0);
  });
  await test("B Schema 发现唯一/歧义/无效配置", async () => {
    delete process.env.DCS_DB_SCHEMA; resetIdentityCache(); owners = [["DCS"], ["OTHER"]];
    assert.equal(decode(await schema.execute({ operation: "list", keyword: "x" }, ctx)).status, "unavailable");
    owners = [["DCS"]]; assert.equal(decode(await schema.execute({ operation: "list", keyword: "x" }, ctx)).status, "success");
    process.env.DCS_DB_SCHEMA = "BAD;OWNER";
    assert.equal(decode(await schema.execute({ operation: "list", keyword: "x" }, ctx)).status, "unavailable"); process.env.DCS_DB_SCHEMA = "DCS";
  });
  await test("B 元数据权限不足", async () => {
    fail = "ORA-01031: insufficient privileges";
    assert.equal(decode(await schema.execute({ operation: "list", keyword: "x" }, ctx)).status, "unverifiable"); fail = "";
  });
  await test("C 授权 SELECT 使用可信工号绑定", async () => {
    dbCalls = [];
    const a = decode(await query.execute({ query: "self_permissions" }, ctx));
    assert.equal(a.status, "success"); assert.equal(a.rowCount, 1);
    assert.equal(dbCalls.length, 1); assert.equal(dbCalls[0].binds?.actor, "10086");
    assert.ok(dbCalls[0].sql.startsWith("SELECT")); assert.ok(!dbCalls[0].sql.includes("10086"));
  });
  await test("C Web/CLI/伪管理员拒绝", async () => {
    dbCalls = [];
    for (const source of ["web", "cli"] as const) {
      const session = createMockSession(); session.user.source = source; session.user.roles = ["管理员", "Developer"];
      assert.equal(decode(await query.execute({ query: "self_permissions" }, { session })).status, "unverifiable");
    }
    assert.equal(dbCalls.length, 0);
  });
  await test("C Web 测试开关绑定工号，保留 CLI/SQL/表范围限制，关闭后拒绝", async () => {
    const web = { session: createSession({ employeeNo: "31177047", name: "测试员工" }, "web-31177047", "web") };
    process.env.DCS_ALLOW_WEB_TEST_IDENTITY = "true";
    try {
      dbCalls = [];
      assert.equal(decode(await query.execute({ query: "self_permissions" }, web)).status, "success");
      assert.equal(dbCalls[0].binds?.actor, "31177047");
      assert.equal(decode(await schema.execute({ operation: "list", keyword: "S2_" }, web)).status, "success");
      dbCalls = [];
      assert.equal(decode(await query.execute({ query: "self_permissions" }, { session: createMockSession() })).status, "unverifiable");
      assert.equal(decode(await query.execute({ sql: "SELECT * FROM S2_EMPLOYEE" }, web)).status, "unsupported");
      assert.equal(decode(await schema.execute({ operation: "describe", tables: ["S2_EMPLOYEE"], schema: "OTHER" }, web)).status, "denied");
      assert.equal(dbCalls.length, 0);
    } finally { delete process.env.DCS_ALLOW_WEB_TEST_IDENTITY; }
    assert.equal(decode(await query.execute({ query: "self_permissions" }, web)).status, "unverifiable");
  });
  await test("C 任意 SQL/AND OR 优先级/跨员工/函数/DML 不可绕过", async () => {
    dbCalls = [];
    for (const sql of ["SELECT * FROM S2_EMPLOYEE", "SELECT * FROM X WHERE EmpCode='10086' AND X=1 OR 1=1", "SELECT * FROM X WHERE EmpCode='10087'", "SELECT pkg.mutate() FROM dual", "WITH FUNCTION x RETURN NUMBER IS BEGIN RETURN 1; END; SELECT x FROM dual", "DELETE FROM X", "SELECT COUNT(*) FROM S2_R_REGACCOM WHERE DT BETWEEN '2026-10-03' AND '2026-10-10'"]) assert.equal(decode(await query.execute({ sql }, ctx)).status, "unsupported");
    assert.equal(dbCalls.length, 0);
    assert.equal(decode(await query.execute({ query: "self_permissions", employeeNo: "10087" } as any, ctx)).status, "invalid_args");
  });
  await test("C 0行/行数截断/敏感信息/长度限制", async () => {
    answer = { columns: ["ROLE_NAME"], rows: [] };
    assert.equal(decode(await query.execute({ query: "self_permissions" }, ctx)).status, "empty");
    answer = { columns: ["ROLE_NAME"], rows: Array.from({ length: 105 }, () => ["13812345678"]) };
    const a = decode(await query.execute({ query: "self_permissions" }, ctx));
    assert.equal(a.rowCount, 105); assert.equal(a.returnedRowCount, 100); assert.equal(a.truncated, true);
    assert.ok(!JSON.stringify(a.rows).includes("13812345678"));
    answer = { columns: Array(10).fill("COL"), rows: Array.from({ length: 100 }, () => Array(10).fill("x".repeat(500))) };
    const b = await query.execute({ query: "self_permissions" }, ctx); assert.equal(decode(b).truncated, true); assert.ok(b.output.length < 64000);
  });
  await test("C SQL错误/Oracle语法/超时/连接错误不泄露凭据", async () => {
    for (const [code, status] of [["ORA-00904", "sql_error"], ["ORA-00933", "sql_error"], ["ORA-01013", "timeout"], ["NJS-530", "unavailable"]]) {
      fail = `${code}: password=NEVER_EXPOSE`;
      const r = await query.execute({ query: "self_permissions" }, ctx);
      assert.equal(r.isError, true); assert.equal(decode(r).status, status); assert.equal(decode(r).code, code); assert.ok(!r.output.includes("NEVER_EXPOSE"));
    }
    fail = "";
    setDbClientFactoryForTest(() => null); assert.equal(decode(await query.execute({ query: "self_permissions" }, ctx)).status, "unavailable"); setDbClientFactoryForTest(() => fake);
  });
  await test("V2.1 BLL/Data源码可读且Token变量保留，凭据字面值隐藏", async () => {
    await write("Libraries/Luxshare.DCS.BLL/Rule.cs", 'public void Check(CancellationToken token) { Use(token); }\nvar token = "NEVER_EXPOSE";');
    await write("Libraries/Luxshare.DCS.Data/Entity.cs", 'class Entity {}');
    const r = await code.execute({ operation: "read", path: "Libraries/Luxshare.DCS.BLL/Rule.cs" }, ctx);
    assert.match(r.output, /CancellationToken token/); assert.match(r.output, /Use\(token\)/); assert.ok(!r.output.includes("NEVER_EXPOSE"));
    assert.equal((await runCode({ operation: "find", pattern: "Entity.cs" })).count, 1);
  });
  await test("V2.1 任意可见业务表的元数据允许，但其他owner拒绝", async () => {
    const r = await schema.execute({ operation: "describe", tables: ["S2_R_REGACCOM"] }, ctx);
    assert.equal(r.isError, undefined);
    assert.ok(dbCalls.some(c => Object.values(c.binds ?? {}).includes("S2_R_REGACCOM")));
  });
  await test("V2.1 目录/未知查询/身份篡改参数不访问数据库", async () => {
    dbCalls = [];
    assert.equal(decode(await query.execute({ query: "list_available" }, ctx)).queries.length, 4);
    assert.equal(decode(await query.execute({ query: "all_employees" }, ctx)).status, "unsupported");
    for (const params of [{ actor: "B" }, { employeeNo: "X' OR 1=1" }, { limit: 101 }, { offset: -1 }, { kind: "invalid" }]) {
      assert.equal(decode(await query.execute({ query: "position_certificates", params }, ctx)).status, "invalid_args");
    }
    assert.equal(dbCalls.length, 0);
  });
  await test("V2.1 A本人/B授权他人/C无授权与未知授权：先验权后读数", async () => {
    const calls: Array<{ sql: string; binds: any }> = [];
    let broken = false;
    const secured: DbClient = { async close() {}, async execute(sql, binds) {
      calls.push({ sql, binds });
      if (sql.startsWith("SELECT 1")) {
        if (broken) throw new Error("NJS-530: password=NEVER_EXPOSE");
        // B仅有源码中的专用权限；C的管理员角色声明不起作用。
        return { columns: ["OK"], rows: binds?.actor === "B" ? [[1]] : [] };
      }
      return { columns: ["EMP_CODE"], rows: [[binds?.target ?? binds?.actor]] };
    } };
    const employee = (id: string) => ({ session: createSession({ employeeNo: id, name: id }, "verified-" + id) });
    setDbClientFactoryForTest(() => secured);
    try {
      assert.equal(decode(await query.execute({ query: "position_certificates" }, employee("A"))).status, "success");
      assert.equal(calls.length, 1); assert.equal(calls[0].binds.actor, "A"); assert.equal(calls[0].binds.target, "A");
      calls.length = 0;
      assert.equal(decode(await query.execute({ query: "position_certificates", params: { employeeNo: "OTHER" } }, employee("B"))).status, "success");
      assert.equal(calls.length, 2); assert.ok(calls[0].sql.includes("S2_AppMyMenu"));
      assert.equal(calls[0].binds.permission, "shanggangzhengchaxun");
      assert.match(calls[1].sql, /EXISTS.*S2_AppMyMenu/s); assert.match(calls[1].sql, /t.State=1/); assert.match(calls[1].sql, /t.State=2/);
      assert.equal(calls[1].binds.actor, "B"); assert.equal(calls[1].binds.target, "OTHER");
      calls.length = 0;
      const c = employee("C"); c.session.user.roles = ["管理员", "Developer"];
      assert.equal(decode(await query.execute({ query: "position_certificates", params: { employeeNo: "OTHER" } }, c)).status, "denied");
      assert.equal(calls.length, 1); assert.ok(calls.every(x => x.sql.startsWith("SELECT 1")));
      broken = true; calls.length = 0;
      const unknown = await query.execute({ query: "position_certificates", params: { employeeNo: "OTHER" } }, c);
      assert.equal(decode(unknown).status, "unverifiable"); assert.equal(calls.length, 1); assert.ok(!unknown.output.includes("NEVER_EXPOSE"));
    } finally { setDbClientFactoryForTest(() => fake); }
  });
  await test("V2.1 宿舍厂区边界、授权错误、餐饮本人、分页与日志", async () => {
    const calls: Array<{ sql: string; binds: any }> = [];
    let empty = false;
    const scoped: DbClient = { async close() {}, async execute(sql, binds) {
      calls.push({ sql, binds });
      if (sql.startsWith("SELECT 1")) return { columns: ["OK"], rows: binds?.company === "C1" ? [[1]] : [] };
      return { columns: ["ID"], rows: empty ? [] : [[1], [2], [3]] };
    } };
    setDbClientFactoryForTest(() => scoped);
    try {
      const params = { companyCode: "C1", roomId: 7, limit: 2 };
      const r = await query.execute({ query: "dorm_room_residents", params }, ctx), body = decode(r);
      assert.equal(body.status, "success"); assert.equal(body.returnedRowCount, 2); assert.equal(body.nextOffset, 2);
      assert.equal(calls.length, 2); assert.match(calls[1].sql, /BITAND\(dp.PowerTypes,1\)=1/);
      assert.match(calls[1].sql, /c.CompanyCode=:company/); assert.equal(calls[1].binds.actor, "10086");
      assert.equal((r.details as any).databaseQueries.length, 2);
      calls.length = 0;
      assert.equal(decode(await query.execute({ query: "dorm_room_residents", params: { ...params, companyCode: "C2" } }, ctx)).status, "denied");
      assert.equal(calls.length, 1);
      calls.length = 0; empty = true;
      assert.equal(decode(await query.execute({ query: "self_book_dinners_today" }, ctx)).status, "empty");
      assert.match(calls[0].sql, /EmpCode=:actor AND BookStatus<>2/); assert.equal(calls[0].binds.actor, "10086");
      assert.equal(decode(await query.execute({ query: "self_book_dinners_today", params: { employeeNo: "other" } }, ctx)).status, "invalid_args");
    } finally { setDbClientFactoryForTest(() => fake); }
  });
  await test("D Fake Model Schema → Code → Query → Final 完整消息接线", async () => {
    answer = { columns: ["ROLE_NAME", "PERMISSION_NAME"], rows: [["员工", "本人菜单"]] };
    const calls = [
      { name: "inspect_dcs_schema", args: { operation: "describe", tables: ["S2_ROLE"] } },
      { name: "investigate_dcs_code", args: { operation: "read", path: "Common/Dorm.cs", offset: 2, limit: 1 } },
      { name: "query_dcs_data", args: { query: "self_permissions" } },
    ];
    let turn = 0;
    const model: StreamFn = async function* (request) {
      assert.deepEqual(request.tools.map(t => t.name), dcsTools.map(t => t.name));
      const results = request.messages.filter(m => m.role === "toolResult");
      assert.equal(results.length, turn);
      results.forEach((r, i) => { assert.equal(r.toolCallId, `v2-${i}`); assert.equal(r.isError, false); assert.equal(JSON.parse(r.content).status, "success"); });
      const call = calls[turn];
      if (call) {
        yield { type: "tool_call_start", index: 0, toolCallId: `v2-${turn}`, name: call.name };
        yield { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(call.args) };
        turn++;
        yield { type: "message_end", stopReason: "toolCalls" };
      } else { yield { type: "text_delta", text: "查到本人菜单；宿舍范围尚未授权。" }; yield { type: "message_end", stopReason: "stop" }; }
    };
    const agent = createDcsAgent({ session: ctx.session, holder: { controller: new AbortController() }, streamFn: model });
    assert.equal(await agent.prompt("验证工具链"), "查到本人菜单；宿舍范围尚未授权。");
    assert.equal(agent.context.filter(m => m.role === "toolResult").length, 3);
    assert.equal(agent.context.at(-1)?.role, "assistant");
    console.log("Fake trace: inspect_dcs_schema(v2-0) → investigate_dcs_code(v2-1) → query_dcs_data(v2-2) → stop");
  });
  await test("C Oracle 驱动接线：只读事务/binds/超时/截断/异常回滚", async () => {
    const previousPool = oracledb.createPool;
    const savedEnv = [process.env.DCS_DB_USER, process.env.DCS_DB_PASSWORD, process.env.DCS_DB_CONNECT_STRING];
    const commands: string[] = [];
    let throwQuery = false;
    const connection = { callTimeout: 0,
      async execute(sql: string, binds?: unknown, options?: any) {
        commands.push(sql);
        if (sql.startsWith("SELECT")) {
          assert.deepEqual(binds, { employeeNo: "10086" }); assert.equal(options.maxRows, 1001);
          if (throwQuery) throw new Error("ORA-00904");
          return { metaData: [{ name: "X" }], rows: Array.from({ length: 1001 }, () => [1]) };
        }
        return {};
      }, async rollback() { commands.push("ROLLBACK"); }, async close() { commands.push("CLOSE"); },
    };
    try {
      (oracledb as any).createPool = async () => ({ async getConnection() { return connection; }, async close() {} });
      process.env.DCS_DB_USER = "synthetic"; process.env.DCS_DB_PASSWORD = "synthetic"; process.env.DCS_DB_CONNECT_STRING = "synthetic.invalid";
      setDbClientFactoryForTest(null);
      const result = await getDbClient()!.execute("SELECT :employeeNo FROM DUAL", { employeeNo: "10086" });
      assert.equal(result.truncated, true); assert.equal(result.rows.length, 1000); assert.equal(connection.callTimeout, 20000);
      assert.deepEqual(commands, ["SET TRANSACTION READ ONLY", "SELECT :employeeNo FROM DUAL", "ROLLBACK", "CLOSE"]);
      commands.length = 0; throwQuery = true;
      await assert.rejects(getDbClient()!.execute("SELECT :employeeNo FROM DUAL", { employeeNo: "10086" }));
      assert.deepEqual(commands.slice(-2), ["ROLLBACK", "CLOSE"]);
    } finally {
      await closeDbClient(); (oracledb as any).createPool = previousPool;
      ["DCS_DB_USER", "DCS_DB_PASSWORD", "DCS_DB_CONNECT_STRING"].forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
      setDbClientFactoryForTest(() => fake);
    }
  });
  console.log(`Tool V2.1: ${passed} 组全部通过（离线；不代表真实模型效率或 Oracle 上线验证）`);
} finally {
  for (const [key, value] of Object.entries({ DCS_SOURCE_ROOT: saved.root, DCS_RG_PATH: saved.rg, DCS_DB_SCHEMA: saved.owner, DCS_ALLOW_WEB_TEST_IDENTITY: saved.webTest })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  setDbClientFactoryForTest(null); resetIdentityCache();
  await fs.rm(root, { recursive: true, force: true });
}
