/**
 * Step 2 身份映射逻辑测试（不依赖真实身份数据，使用临时 fixture）。
 * 验证：
 * - 已登记 userid → 返回完整身份
 * - 未登记 userid → null（拒答，绝不默认映射）
 * - 文件不存在 → 全部 null + 警告
 * - JSON 损坏 / 条目缺字段 → fail fast 抛错
 * - 环境变量 DCS_IDENTITY_FILE 路径覆盖
 * 运行：npx tsx test/identity.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveIdentity, resetIdentityCache } from "../src/dcs/identity.ts";

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

console.log(`\n========== 身份映射测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
