/**
 * Step 2 真实验收：企微真实 userid → 两级身份链路 → DcsSession 构造。
 *
 * userid 通过环境变量 WECOM_TEST_USERID 提供（来自企微 Echo 联调的真实回调，
 * 不硬编码在代码中）。
 * 身份链路（2026-09-24 起）：identity.json 手动覆盖（可选）→
 * S2_Employee 数据库自动解析（需 DCS_DB_* 环境变量）。
 *
 * 运行：$env:WECOM_TEST_USERID = "真实userid"; npx tsx test/identity-live.ts
 * 未设置 WECOM_TEST_USERID 时输出 SKIPPED（跳过 ≠ 通过）。
 */
import { resolveIdentityAsync } from "../src/dcs/identity.ts";
import { createSession } from "../src/dcs/session.ts";

const REAL_WECOM_USERID = process.env.WECOM_TEST_USERID ?? "";

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

console.log("=== Step 2 身份链路验证（真实 userid + 两级解析） ===");

if (!REAL_WECOM_USERID) {
  console.log("========== 未验证（SKIPPED） ==========");
  console.log("未设置 WECOM_TEST_USERID（企微真实 userid，来自 Echo 联调回调）。");
  console.log('设置后运行：$env:WECOM_TEST_USERID = "xxxx"; npx tsx test/identity-live.ts');
  process.exit(0);
}

const identity = await resolveIdentityAsync(REAL_WECOM_USERID);
check(
  `S1 真实企微 userid 成功解析身份（identity.json 覆盖或 S2_Employee 数据库）`,
  identity !== null && identity.employeeNo.length > 0 && identity.name.length > 0,
  identity === null
    ? "两级均未命中：检查 identity.json 覆盖项，或 DCS_DB_* 环境变量与 S2_Employee.UserId 数据"
    : JSON.stringify(identity)
);
check(
  "S2 解析结果为真实身份特征（工号为 DCS 工号格式，非 T000001 测试占位）",
  identity?.employeeNo !== "T000001",
  identity?.employeeNo
);

const session = createSession(identity!, REAL_WECOM_USERID);
check(
  "S3 DcsSession 构造正确（source=wecom，userId 为真实 userid）",
  session.user.source === "wecom" && session.user.userId === REAL_WECOM_USERID && session.user.employeeNo === identity!.employeeNo,
  JSON.stringify(session)
);
check("S4 Agent 工具上下文可用（ctx.session.user 为该身份）", session.user.name === identity!.name);

const unknown = await resolveIdentityAsync("0000000");
check("S5 未识别 userid → null（拒答，不默认映射）", unknown === null);

console.log(`\n=== 结果 ===`);
if (failed > 0) {
  console.log(`FAIL：${failed} 项未通过`);
  process.exit(1);
}
console.log("PASS：真实 userid → DCS 身份 → DcsSession 链路成立（两级解析：identity.json 覆盖 → S2_Employee 数据库）");
