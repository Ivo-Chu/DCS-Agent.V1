import type { DcsToolContext } from "../session.ts";
import { getDiscoveredSchema } from "../identity.ts";
import type { DbClient } from "./client.ts";

// 仅用于服务端确定的Oracle Schema和元数据标识符。
export const IDENTIFIER = /^[A-Z][A-Z0-9_$#]{0,127}$/;
export function requireTrustedEmployee(ctx: DcsToolContext): string {
  const u = ctx?.session?.user;
  if (!u?.userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(u.employeeNo)) {
    throw new Error("unverifiable: 缺少可用的员工会话。");
  }
  if (u.source === "wecom") return u.employeeNo;
  // Web 正式身份只信任 Node 服务端 SSO 校验成功后设置的标记；
  // 显式测试开关仅用于本地调试。两者都不能由模型或浏览器提交。
  const webTestAllowed = u.source === "web" && process.env.DCS_ALLOW_WEB_TEST_IDENTITY === "true";
  if (u.source === "web" && u.authMethod === "dcs_sso") return u.employeeNo;
  if (webTestAllowed) return u.employeeNo;
  throw new Error("unverifiable: Web身份未通过DCS SSO校验；本地测试需服务端启用 DCS_ALLOW_WEB_TEST_IDENTITY=true。");
}

export type AuthorizationDecision = { status: "authorized"; basis: string } |
  { status: "denied" | "unverifiable"; message: string; code?: string };

/** GetCertInfo: 只允许本人，或当前请求者具有明确的跨员工证书查询授权。 */
export async function authorizeCertificates(db: DbClient, owner: string, actor: string, target: string): Promise<AuthorizationDecision> {
  if (actor === target) return { status: "authorized", basis: "ElearningController.GetCertInfo: 本人证书" };
  try {
    const result = await db.execute(`SELECT 1 FROM ${owner}.S2_AppMyMenu WHERE EmpCode = :actor AND INSTR(MenuCodes, :permission) > 0 AND ROWNUM <= 1`,
      { actor, permission: "shanggangzhengchaxun" });
    return result.rows.length ? { status: "authorized", basis: "GetCertInfo: 请求者AppMyMenu明确授予跨员工证书查询" } :
      { status: "denied", message: "当前员工没有GetCertInfo要求的跨员工上岗证查询授权；不代表没有其他页面的权限。" };
  } catch (error) { return unknownAuthorization(error); }
}

/** GetDormitory + GetCompanyCodes(DormAdmin)：只复用显式厂区授权，不移植IsDeveloper绕过。 */
export async function authorizeDormitory(db: DbClient, owner: string, actor: string, company: string): Promise<AuthorizationDecision> {
  try {
    const r = await db.execute(`SELECT 1 FROM ${owner}.S2_R_DataPermission p JOIN ${owner}.S2_Company c ON c.Code=p.CompanyCode
      WHERE p.EmpCode=:actor AND p.CompanyCode=:company AND BITAND(p.PowerTypes,1)=1 AND ROWNUM<=1`, { actor, company });
    return r.rows.length ? { status: "authorized", basis: "R_DataPermissionSet.GetCompanyCodes: 显式DormAdmin厂区授权" } :
      { status: "denied", message: "未授予该厂区的显式DormAdmin权限；Agent不继承DCS特殊开发者绕过。" };
  } catch (error) { return unknownAuthorization(error); }
}
function unknownAuthorization(error: unknown): AuthorizationDecision {
  return { status: "unverifiable", message: "业务授权查询失败，无法确定权限；未读取目标员工业务数据。",
    code: /(?:ORA|NJS|DPI)-\d+/.exec(String(error))?.[0] };
}
export async function resolveSchema(db: DbClient): Promise<string> {
  let owner = process.env.DCS_DB_SCHEMA?.trim().toUpperCase() || getDiscoveredSchema();
  if (owner === undefined) {
    const found = await db.execute("SELECT OWNER FROM ALL_TABLES WHERE TABLE_NAME = :tableName ORDER BY OWNER", { tableName: "S2_EMPLOYEE" });
    const owners = [...new Set(found.rows.map(r => String(r[0])))];
    if (found.truncated || owners.length !== 1) throw new Error("unavailable: 无法唯一确定 Schema，请配置 DCS_DB_SCHEMA。");
    owner = owners[0];
  }
  if (!owner || !IDENTIFIER.test(owner)) throw new Error("unavailable: DCS_DB_SCHEMA 无效或 Schema 发现存在歧义。");
  return owner;
}
