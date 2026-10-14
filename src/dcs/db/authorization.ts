import type { DcsToolContext } from "../session.ts";
import { getDiscoveredSchema } from "../identity.ts";
import type { DbClient } from "./client.ts";

// 仅本人权限查询所需的结构；不是全库元数据授权。
export const METADATA_TABLES = ["S2_USERROLE", "S2_ROLE", "S2_ROLEPERMISSION", "S2_PERMISSION"];
export const IDENTIFIER = /^[A-Z][A-Z0-9_$#]{0,127}$/;
export function requireTrustedEmployee(ctx: DcsToolContext): string {
  const u = ctx?.session?.user;
  // Web 工号仅在显式开启本地测试开关时接受；CLI mock、模型 roles 不能授权。
  const allowWebTest = u?.source === "web" && process.env.DCS_ALLOW_WEB_TEST_IDENTITY === "true";
  if (!u || (u.source !== "wecom" && !allowWebTest) || !u.userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(u.employeeNo)) {
    throw new Error("forbidden: 需要企微可信身份；Web 测试需由服务端启用 DCS_ALLOW_WEB_TEST_IDENTITY=true，CLI 模拟身份不能授权数据库访问。");
  }
  return u.employeeNo;
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

/** 实体映射与 UserRoleSet.GetRoleCodesByEmpCode 已核对。只返回本人分配的角色/菜单，不能推导数据范围。 */
export function selfPermissionsSql(owner: string): string {
  if (!IDENTIFIER.test(owner)) throw new Error("unavailable: Schema 无效");
  return `SELECT r.Name AS ROLE_NAME, p.Name AS PERMISSION_NAME FROM ${owner}.S2_UserRole ur
    JOIN ${owner}.S2_Role r ON r.Code = ur.RoleCode
    LEFT JOIN ${owner}.S2_RolePermission rp ON rp.RoleCode = ur.RoleCode
    LEFT JOIN ${owner}.S2_Permission p ON p.Id = rp.PermissionId
    WHERE ur.EmpCode = :employeeNo ORDER BY r.Code, p.Id`;
}
