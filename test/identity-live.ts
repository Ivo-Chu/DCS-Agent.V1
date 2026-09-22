/**
 * Step 2 真实验收：企微真实 userid → 身份映射 → DcsSession 构造。
 *
 * userid 是 Echo 联调时从真实企微消息中取得的（5759529）；
 * 身份数据当前为 identity.json 中明确标记的测试数据（TEST DATA），
 * 上线前替换数据源，本脚本无需改动。
 *
 * 运行：npx tsx test/identity-live.ts
 */
import { resolveIdentity } from "../src/dcs/identity.ts";
import { createSession } from "../src/dcs/session.ts";

const REAL_WECOM_USERID = "5759529"; // 来自 2026-09-22 Echo 联调真实回调

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

console.log("=== Step 2 身份链路验证（真实 userid + 测试身份数据） ===");

const identity = resolveIdentity(REAL_WECOM_USERID);
check(
  `S1 真实企微 userid ${REAL_WECOM_USERID} 成功解析身份`,
  identity !== null && identity.employeeNo.length > 0 && identity.name.length > 0,
  JSON.stringify(identity)
);
check("S2 身份字段完整（工号/姓名/部门/角色）", identity?.department !== undefined && (identity?.roles?.length ?? 0) > 0);

const session = createSession(identity!, REAL_WECOM_USERID);
check(
  "S3 DcsSession 构造正确（source=wecom，userId 为真实 userid）",
  session.user.source === "wecom" && session.user.userId === REAL_WECOM_USERID && session.user.employeeNo === identity!.employeeNo,
  JSON.stringify(session)
);
check("S4 Agent 工具上下文可用（ctx.session.user 为该身份）", session.user.name === identity!.name);

const unknown = resolveIdentity("0000000");
check("S5 未登记 userid → null（拒答，不默认映射）", unknown === null);

console.log(`\n=== 结果 ===`);
if (failed > 0) {
  console.log(`FAIL：${failed} 项未通过`);
  process.exit(1);
}
console.log("PASS：真实 userid → 测试 DCS 身份 → DcsSession 链路成立（数据源为 TEST DATA，上线前替换）");
