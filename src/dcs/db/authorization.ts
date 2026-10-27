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
