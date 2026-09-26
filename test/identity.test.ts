/**
 * Step 2 身份映射逻辑测试（不依赖真实身份数据，使用临时 fixture）。
 * 验证：
 * - 已登记 userid → 返回完整身份
 * - 未登记 userid → null（拒答，绝不默认映射）
 * - 文件不存在 → 全部 null + 警告
 * - JSON 损坏 / 条目缺字段 → fail fast 抛错
 * - 环境变量 DCS_IDENTITY_FILE 路径覆盖
 * - （2026-09-24）两级链路：identity.json 覆盖优先 → S2_Employee 数据库解析
 * 运行：npx tsx test/identity.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveIdentity, resolveIdentityAsync, resetIdentityCache, getDiscoveredSchema } from "../src/dcs/identity.ts";
import { queryDcsDataTool } from "../src/dcs/tools.ts";
import { setDbClientFactoryForTest, type DbClient } from "../src/dcs/db/client.ts";

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

function writeFixture(content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dcs-identity-")), "identity.json");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

console.log("[场景] I. 身份映射（Step 2）");

{
  const file = writeFixture(
    JSON.stringify({
      "1000001": { employeeNo: "C000001", name: "测试甲", department: "测试部", roles: ["普通员工"] },
      "8888888": { employeeNo: "C000002", name: "测试乙" },
    })
  );
  resetIdentityCache();
  const a = resolveIdentity("1000001", file);
  check("I1 已登记 userid 返回完整身份", a?.employeeNo === "C000001" && a?.name === "测试甲" && a?.department === "测试部" && a?.roles?.[0] === "普通员工", JSON.stringify(a));
  const b = resolveIdentity("8888888", file);
  check("I2 可选字段缺省时 roles 默认空数组", b?.employeeNo === "C000002" && b?.roles?.length === 0, JSON.stringify(b));
  const c = resolveIdentity("9999999", file);
  check("I3 未登记 userid 返回 null（拒答，不默认映射）", c === null);
  const d = resolveIdentity("", file);
  check("I4 空 userid 返回 null", d === null);
}
{
  const file = writeFixture("{broken json");
  resetIdentityCache();
  let threw = false;
  try {
    resolveIdentity("1000001", file);
  } catch {
    threw = true;
  }
  check("I5 映射文件损坏 → fail fast 抛错", threw);
}
{
  const file = writeFixture(JSON.stringify({ "1000001": { employeeNo: "C000001" } }));
  resetIdentityCache();
  let threw = false;
  try {
    resolveIdentity("1000001", file);
  } catch (err) {
    threw = String(err).includes("不完整");
  }
  check("I6 条目缺 name → 抛错（身份不完整不放行）", threw);
}
{
  resetIdentityCache();
  const missing = resolveIdentity("1000001", path.join(os.tmpdir(), "definitely-missing-identity.json"));
  check("I7 文件不存在 → null（无人登记）", missing === null);
}

console.log("\n[场景] II. 两级身份链路（identity.json 覆盖 → S2_Employee 数据库）");

/** 不存在的 identity 文件路径（隔离项目本地 identity.json 的覆盖项）。 */
const NO_FILE = path.join(os.tmpdir(), "definitely-missing-identity.json");

/** 假库：1000001 在职、2000002 在职无部门、3000003 离职（LeaveDate 过滤后空）、其他未登记。 */
const fakeDb: DbClient = {
  async execute(sql) {
    if (sql.includes("ALL_TABLES")) {
      return { columns: ["OWNER"], rows: [["FAKEOWNER"]] };
    }
    if (sql.includes("'1000001'")) {
      return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [["C000001", "库中甲", "制造一部"]] };
    }
    if (sql.includes("'2000002'")) {
      return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [["C000002", "库中乙", null]] };
    }
    // 3000003：真实库中 LeaveDate IS NULL 过滤后无行
    return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [] };
  },
  async close() {},
};

{
  setDbClientFactoryForTest(() => fakeDb);
  resetIdentityCache();

  const a = await resolveIdentityAsync("1000001", NO_FILE);
  check(
    "I8 数据库解析：S2_Employee 命中 → 工号/姓名/部门",
    a?.employeeNo === "C000001" && a?.name === "库中甲" && a?.department === "制造一部",
    JSON.stringify(a)
  );
  check("I9 数据库解析：roles 为空数组（ADM 权限表未接入）", a?.roles?.length === 0, JSON.stringify(a?.roles));

  const b = await resolveIdentityAsync("2000002", NO_FILE);
  check("I10 数据库解析：部门为 NULL → department 为 undefined", b?.employeeNo === "C000002" && b?.department === undefined, JSON.stringify(b));

  const c = await resolveIdentityAsync("3000003", NO_FILE);
  check("I11 离职员工（LeaveDate 非空被过滤）→ null（拒答）", c === null, JSON.stringify(c));

  const d = await resolveIdentityAsync("9999999", NO_FILE);
  check("I12 数据库未命中 → null（拒答，不默认映射）", d === null);

  // 覆盖优先级：identity.json 命中时优先于数据库
  const overrideFile = writeFixture(
    JSON.stringify({ "1000001": { employeeNo: "OVERRIDE01", name: "覆盖身份", roles: ["测试角色"] } })
  );
  resetIdentityCache();
  const e = await resolveIdentityAsync("1000001", overrideFile);
  check("I13 identity.json 覆盖优先于数据库解析", e?.employeeNo === "OVERRIDE01" && e?.name === "覆盖身份", JSON.stringify(e));

  // 覆盖文件存在但未命中该 userid → 落到数据库层
  const f = await resolveIdentityAsync("2000002", overrideFile);
  check("I14 覆盖文件未命中 → 落到数据库层解析", f?.employeeNo === "C000002", JSON.stringify(f));

  // 非常规 userid（防注入白名单）→ 不查库直接 null
  let queriedBadUserid = false;
  setDbClientFactoryForTest(() => ({
    async execute(sql) {
      if (sql.includes("'1000001'")) return { columns: ["CODE"], rows: [] };
      queriedBadUserid = true;
      return { columns: ["CODE"], rows: [] };
    },
    async close() {},
  }));
  resetIdentityCache();
  const g = await resolveIdentityAsync("bad'userid--", NO_FILE);
  check("I15 非常规 userid（含引号等）→ null 且不查库（防注入）", g === null && !queriedBadUserid);

  // 数据库故障 → null（拒答，不崩溃），且不缓存失败
  setDbClientFactoryForTest(() => ({
    async execute() {
      throw new Error("ORA-01017: invalid username/password");
    },
    async close() {},
  }));
  resetIdentityCache();
  const h = await resolveIdentityAsync("1000001", NO_FILE);
  check("I16 数据库故障 → null（拒答，不抛异常）", h === null);

  // 未配置数据库（工厂返回 null）→ 链路止于文件层
  setDbClientFactoryForTest(() => null);
  resetIdentityCache();
  const i = await resolveIdentityAsync("1000001", NO_FILE);
  check("I17 未配置数据库 → null（链路止于文件层）", i === null);

  // DCS_DB_SCHEMA 前缀：只读账号非表所有者时必须用 schema 限定表名（防 ORA-00942）
  let capturedSql = "";
  setDbClientFactoryForTest(() => ({
    async execute(sql) {
      capturedSql = sql;
      return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [["C000001", "库中甲", "制造一部"]] };
    },
    async close() {},
  }));
  process.env.DCS_DB_SCHEMA = "TESTSCHEMA";
  resetIdentityCache();
  const j = await resolveIdentityAsync("1000001", NO_FILE);
  check(
    "I18 DCS_DB_SCHEMA 设置时身份查询带 schema 前缀（TESTSCHEMA.S2_Employee）",
    j?.employeeNo === "C000001" && capturedSql.includes("TESTSCHEMA.S2_Employee"),
    capturedSql
  );
  delete process.env.DCS_DB_SCHEMA;

  // schema 自动发现：未设 DCS_DB_SCHEMA 时查 ALL_TABLES 取唯一 OWNER
  let lastSql = "";
  setDbClientFactoryForTest(() => ({
    async execute(sql) {
      lastSql = sql;
      if (sql.includes("ALL_TABLES")) {
        return { columns: ["OWNER"], rows: [["AUTOOWNER"]] };
      }
      return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [["C000009", "自动甲", "测试部"]] };
    },
    async close() {},
  }));
  resetIdentityCache();
  const k = await resolveIdentityAsync("4000004", NO_FILE);
  check(
    "I19 schema 自动发现：ALL_TABLES 唯一 OWNER → 查询带 AUTOOWNER.S2_Employee 前缀",
    k?.employeeNo === "C000009" && lastSql.includes("AUTOOWNER.S2_Employee"),
    lastSql
  );

  // 方案A+B：query_dcs_data 描述（getter）复用自动发现的 schema，且含常用表数据字典
  // ——修复"未设 DCS_DB_SCHEMA 时回退登录用户名"把模型引向 0 行数据字典的死路
  // 2026-09-24 真机修正：主权限表为 S2_UserRole 组（无 ADM 前缀），ADM 组为管理模块独立权限
  check(
    "I21 query_dcs_data 描述复用自动发现 schema 且含主权限表数据字典（AUTOOWNER.S2_Employee + S2_UserRole + S2_RolePermission）",
    getDiscoveredSchema() === "AUTOOWNER" &&
      queryDcsDataTool.description.includes("AUTOOWNER.S2_Employee") &&
      queryDcsDataTool.description.includes("S2_UserRole") &&
      queryDcsDataTool.description.includes("S2_RolePermission"),
    queryDcsDataTool.description.slice(0, 200)
  );

  // 多 schema 歧义 → null（要求 DCS_DB_SCHEMA 显式指定）
  setDbClientFactoryForTest(() => ({
    async execute(sql) {
      if (sql.includes("ALL_TABLES")) {
        return { columns: ["OWNER"], rows: [["OWNA"], ["OWNB"]] };
      }
      return { columns: ["CODE", "NAME", "DEPTNAME"], rows: [["X", "Y", "Z"]] };
    },
    async close() {},
  }));
  resetIdentityCache();
  const m = await resolveIdentityAsync("4000004", NO_FILE);
  check("I20 S2_EMPLOYEE 存在于多个 schema → null（歧义，要求显式指定）", m === null);

  setDbClientFactoryForTest(null);
  resetIdentityCache();
}

console.log(`\n========== 身份映射测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
