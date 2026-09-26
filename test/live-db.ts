/**
 * query_dcs_data 真实库验证（query-dcs-data-plan-v1 §7）。
 *
 * 门控模式与 test:live 一致：DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING
 * 任一未设置 → 输出"未验证（SKIPPED）"并退出，跳过 ≠ 通过，不以假数据冒充。
 *
 * 验证内容：
 * 1. 连接与最简查询（SELECT 1 FROM DUAL）；
 * 2. 数据字典查询（ALL_TABLES，模型自主探索表结构的同一通路）；
 * 3. 工具层端到端（guard → execute → format，走 queryDcsDataTool 本体）；
 * 4. 护栏在真实链路生效（UPDATE 拒绝）。
 *
 * 运行：npm run test:live:db
 */
import { queryDcsDataTool } from "../src/dcs/tools.ts";
import { closeDbClient } from "../src/dcs/db/client.ts";
import { createMockSession, type DcsToolContext } from "../src/dcs/session.ts";

const dcsCtx: DcsToolContext = { session: createMockSession() };

let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const missing = ["DCS_DB_USER", "DCS_DB_PASSWORD", "DCS_DB_CONNECT_STRING"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    console.log("========== 未验证（SKIPPED） ==========");
    console.log(`未设置：${missing.join(" / ")}——真实库验证未执行。`);
    console.log("PowerShell：$env:DCS_DB_USER='用户名'; $env:DCS_DB_PASSWORD='密码'; $env:DCS_DB_CONNECT_STRING='主机:端口/服务名'");
    console.log("然后执行：npm run test:live:db");
    process.exit(0);
  }

  console.log("========== query_dcs_data 真实库验证 ==========");

  // 1. 最简查询（工具层端到端）
  const dual = await queryDcsDataTool.execute({ sql: "SELECT 1 AS ONE FROM DUAL" }, dcsCtx);
  check("L-DB1 连接成功且最简查询返回（guard → execute → format 全链路）",
    !dual.isError && dual.output.includes("返回 1 行") && dual.output.includes("ONE"),
    dual.output.slice(0, 200));

  // 2. 数据字典 + S2_Employee 的 OWNER 发现（只读账号通常不是表所有者，
  //    不带 schema 前缀查询业务表会 ORA-00942 —— 2026-09-24 真人测试实际踩坑）
  const empOwners = await queryDcsDataTool.execute({
    sql: `SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE TABLE_NAME = 'S2_EMPLOYEE'`,
  }, dcsCtx);
  const ownersFound = /返回 [1-9]\d* 行/.test(empOwners.output);
  const schema = process.env.DCS_DB_SCHEMA?.trim();
  check("L-DB2 数据字典可查且能看到 S2_Employee 表（含 OWNER）",
    !empOwners.isError && ownersFound,
    ownersFound
      ? `${empOwners.output.slice(0, 300)}${schema ? `（当前 DCS_DB_SCHEMA=${schema}）` : "——请把输出中的 OWNER 设为 DCS_DB_SCHEMA 环境变量后重启"}`
      : empOwners.output.slice(0, 300));
  if (!schema && ownersFound) {
    const m = empOwners.output.match(/^\s*([A-Za-z0-9_$#]+)\s*\|\s*S2_EMPLOYEE/im);
    if (m) {
      console.log(`\n[提示] S2_Employee 属于 schema「${m[1]}」。若身份解析/业务查询报 ORA-00942，请设置：`);
      console.log(`       PowerShell：$env:DCS_DB_SCHEMA = "${m[1]}"（然后重启 bot）`);
    }
  }

  // 3. 护栏在真实链路生效
  const rejected = await queryDcsDataTool.execute({ sql: `UPDATE ${schema ? schema + "." : ""}S2_Employee SET NAME = 'x'` }, dcsCtx);
  check("L-DB3 写操作被护栏拒绝（不触达数据库）", !rejected.isError && rejected.output.includes("SQL 被拒绝"));

  // 4. ORA 错误透传（真实错误码）
  const oraErr = await queryDcsDataTool.execute({ sql: "SELECT * FROM DCS_AGENT_NOT_EXIST_TABLE" }, dcsCtx);
  check("L-DB4 ORA 错误透传供模型自修正（含错误码）", !oraErr.isError && oraErr.output.includes("ORA-"),
    oraErr.output.slice(0, 200));

  // 5. 身份链路 SQL 可达（identity.ts 使用的同一条查询；带 schema 前缀）
  {
    const table = schema ? `${schema}.S2_Employee` : "S2_Employee";
    const idQuery = await queryDcsDataTool.execute({
      sql: `SELECT Code, Name, DeptName FROM ${table} WHERE UserId = 'DCS_AGENT_PROBE_NO_SUCH_USER' AND LeaveDate IS NULL AND ROWNUM <= 1`,
    }, dcsCtx);
    check("L-DB5 身份链路 SQL 可达（S2_Employee 可查询，无论有无匹配行）",
      !idQuery.isError && idQuery.output.includes("查询成功") && !idQuery.output.includes("ORA-"),
      idQuery.output.slice(0, 200));
  }

  // 5. PII 脱敏管线对真实 DB 结果生效（手机号列若存在）
  console.log("\n[说明] maskPii 管线对 DB ToolResult 生效已由冒烟 L11 锁定；真实库无需构造含 PII 的表。");

  // 关闭连接池：poolMin=1 的常驻连接会让事件循环保持活跃，
  // 不显式关闭则所有断言打印完后进程仍不退出（表现为终端"卡住"无法输入）。
  await closeDbClient().catch(() => undefined);

  console.log("\n========== 真实库验证结果 ==========");
  if (failed > 0) {
    console.log(`FAIL：${failed} 项未通过`);
    process.exit(1);
  }
  console.log("PASS：连接 / 数据字典（含 S2_Employee OWNER 发现）/ 护栏 / 错误透传 / 身份链路 SQL 全部通过");
}

main();
