import { createNavigateDcsMenuTool } from "../src/dcs/navigation-tool.ts";
import type { DcsToolContext } from "../src/dcs/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function ssoCtx(employeeNo = "10086"): DcsToolContext {
  return {
    session: {
      user: { source: "web", userId: `web-${employeeNo}`, employeeNo, name: "张三", roles: [], authMethod: "dcs_sso" },
    },
  };
}

const calls: Array<{ employeeNo: string; menuName: string }> = [];
const tool = createNavigateDcsMenuTool(async (employeeNo, menuName) => {
  calls.push({ employeeNo, menuName });
  return { ok: true, message: `已打开：${menuName}（${employeeNo}）` };
});
check("SSO身份执行导航并使用当前会话员工", (await tool.execute({ menuName: "上岗证查询" }, ssoCtx())).output === "已打开：上岗证查询（10086）");
check("导航回调只收到员工与菜单名", calls.length === 1 && calls[0].employeeNo === "10086" && calls[0].menuName === "上岗证查询");
check("空菜单名被拒绝", (await tool.execute({ menuName: " " }, ssoCtx())).isError === true);
check("无SSO身份被拒绝", (await tool.execute({ menuName: "上岗证查询" }, { session: { user: { source: "web", userId: "web-10086", employeeNo: "10086", name: "张三", roles: [] } } })).isError === true);

const failing = createNavigateDcsMenuTool(async () => { throw new Error("浏览器未回传"); });
const failingResult = await failing.execute({ menuName: "上岗证查询" }, ssoCtx());
check("桥接失败返回错误ToolResult", failingResult.isError === true && failingResult.output.includes("浏览器未回传"));

const rejectedMenu = createNavigateDcsMenuTool(async () => ({ ok: false, message: "未找到菜单" }));
check("浏览器业务失败不会标记成功", (await rejectedMenu.execute({ menuName: "查询" }, ssoCtx())).isError === true);

console.log(`\n导航Tool配对测试：通过${passed}，失败${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
