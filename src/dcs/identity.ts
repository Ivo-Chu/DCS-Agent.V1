/**
 * dcs/identity.ts — Step 2：企微 userid → DCS 员工身份。
 *
 * 当前实现：人工维护映射文件（方案 §四优先级最后一档）。
 * 数据库只读查询（S2_Employee.UserId → Code）的权限复杂，暂缓补齐；
 * 届时只需替换本模块的数据源，调用方（Channel / Session 构造）零改动。
 *
 * 身份铁律（方案 §四）：
 * - 身份完全来自企微可信消息（body.from.userid），用户文字不能改变查询身份
 * - 未登记 userid 一律返回 null（拒绝服务），绝不默认映射到测试用户
 * - identity.json 含真实员工身份信息，已加入 .gitignore，不入 Git
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 已登记员工的 DCS 身份。 */
export interface DcsIdentity {
  /** DCS 工号。 */
  employeeNo: string;
  name: string;
  department?: string;
  /** DCS 角色（真实菜单权限接入前的可选字段，默认空）。 */
  roles?: string[];
}

const DEFAULT_IDENTITY_FILE = path.resolve(process.cwd(), "identity.json");

let cache: Map<string, DcsIdentity> | null = null;
let cacheFile = "";

function loadIdentityMap(file: string): Map<string, DcsIdentity> {
  if (cache && cacheFile === file) return cache;
  const map = new Map<string, DcsIdentity>();
  if (!fs.existsSync(file)) {
    // 文件不存在视为"无人登记"：所有 userid 返回 null（拒答），不算错误
    console.warn(`[identity] 身份映射文件不存在（${file}），所有员工将无法识别。`);
    cache = map;
    cacheFile = file;
    return map;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // 身份链路数据损坏必须 fail fast：静默降级可能放行错误身份
    throw new Error(`身份映射文件损坏（${file}）：${String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`身份映射文件格式错误（${file}）：应为 { "userid": { employeeNo, name, ... } }`);
  }
  for (const [userid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.employeeNo !== "string" || typeof v.name !== "string") {
      throw new Error(`身份映射文件条目不完整（${file}，userid=${userid}）：employeeNo 与 name 必填`);
    }
    map.set(userid, {
      employeeNo: v.employeeNo,
      name: v.name,
      department: typeof v.department === "string" ? v.department : undefined,
      roles: Array.isArray(v.roles) ? v.roles.filter((r) => typeof r === "string") : [],
    });
  }
  cache = map;
  cacheFile = file;
  return map;
}

/**
 * 企微 userid → DCS 身份。
 * 未登记 / 未提供 userid → null（调用方以中性话术拒答）。
 */
export function resolveIdentity(
  userid: string,
  identityFile: string = process.env.DCS_IDENTITY_FILE ?? DEFAULT_IDENTITY_FILE
): DcsIdentity | null {
  if (!userid) return null;
  const map = loadIdentityMap(identityFile);
  return map.get(userid) ?? null;
}

/** 测试辅助：清空映射缓存。 */
export function resetIdentityCache(): void {
  cache = null;
  cacheFile = "";
}
