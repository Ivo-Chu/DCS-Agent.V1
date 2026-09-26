/**
 * dcs/identity.ts — Step 2：企微 userid → DCS 员工身份。
 *
 * 身份链路（2026-09-24 起，两级解析）：
 * 1. identity.json 手动覆盖（可选）——文件存在且命中该 userid 时优先，
 *    用于测试时指定特定身份；
 * 2. DCS 数据库（S2_Employee.UserId → Code/Name/DeptName）——与 DCS 系统
 *    企微链路同一映射（源码证据：EmployeeSet.GetEmpCode(userId)），
 *    仅在职员工（LeaveDate IS NULL）；表名恒带 schema 前缀
 *    （DCS_DB_SCHEMA 显式指定 > ALL_TABLES 自动发现，防 ORA-00942）。
 *
 * 身份铁律（方案 §四）：
 * - 身份完全来自企微可信消息（body.from.userid），用户文字不能改变查询身份
 * - 两级都未命中 → 返回 null（拒绝服务），绝不默认映射到测试用户
 * - identity.json 含真实员工身份信息，已加入 .gitignore，不入 Git
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbClient } from "./db/client.ts";

/** 已登记员工的 DCS 身份。 */
export interface DcsIdentity {
  /** DCS 工号。 */
  employeeNo: string;
  name: string;
  department?: string;
  /** DCS 角色（ADM 权限表接入前的可选字段，默认空；权限问题由模型查库解决）。 */
  roles?: string[];
}

const DEFAULT_IDENTITY_FILE = path.resolve(process.cwd(), "identity.json");

let cache: Map<string, DcsIdentity> | null = null;
let cacheFile = "";

/**
 * userid 合法字符白名单（字母/数字/下划线/连字符/点，≤64 字符）。
 * 数据库查询按字符串拼接 WHERE 值，白名单外的 userid 一律不查库（防注入）。
 */
const USERID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 数据库身份解析缓存 TTL（毫秒）；命中/未命中均缓存，进程重启即刷新。 */
const DB_CACHE_TTL_MS = 10 * 60 * 1000;

const dbCache = new Map<string, { identity: DcsIdentity | null; at: number }>();

/**
 * S2_Employee 所属 schema（进程内一次性发现）。
 * undefined = 尚未发现；null = 发现失败（多 owner 歧义 / 账号无权访问 / 发现查询出错）。
 */
let discoveredSchema: string | null | undefined;

/**
 * 发现 S2_Employee 所属 schema（每进程一次）。
 * 优先级：DCS_DB_SCHEMA 显式指定 > ALL_TABLES 自动发现（与 DCS 自身 EmployeeSet 同一映射）。
 * 只读账号通常不是表所有者，裸表名会 ORA-00942，因此除显式空场景外恒用 schema 前缀。
 */
async function resolveEmployeeSchema(client: NonNullable<ReturnType<typeof getDbClient>>): Promise<string | null> {
  if (discoveredSchema !== undefined) return discoveredSchema;
  const configured = process.env.DCS_DB_SCHEMA?.trim();
  if (configured) {
    discoveredSchema = configured;
    return configured;
  }
  try {
    const { rows } = await client.execute(
      "SELECT OWNER FROM ALL_TABLES WHERE TABLE_NAME = 'S2_EMPLOYEE'"
    );
    const owners = [...new Set(rows.map((r) => String(r[0])))].sort();
    if (owners.length === 1) {
      discoveredSchema = owners[0];
      console.log(`[identity] 自动发现 S2_Employee schema：${owners[0]}（可用 DCS_DB_SCHEMA 覆盖）`);
    } else if (owners.length === 0) {
      console.error(
        "[identity] 账号在 ALL_TABLES 中看不到 S2_EMPLOYEE：权限不足（缺 SELECT 权限）或表名不同，" +
          "身份解析不可用。可确认账号权限，或用 DCS_DB_SCHEMA 显式指定。"
      );
      discoveredSchema = null;
    } else {
      console.error(
        `[identity] S2_EMPLOYEE 存在于多个 schema（${owners.join("、")}），存在歧义。` +
          "请在 DCS_DB_SCHEMA 环境变量中显式指定 DCS 主库的 schema。"
      );
      discoveredSchema = null;
    }
  } catch (err) {
    console.error(
      `[identity] schema 自动发现失败：${String(err).slice(0, 200)}（可用 DCS_DB_SCHEMA 显式指定绕过）`
    );
    discoveredSchema = null;
  }
  return discoveredSchema;
}

/**
 * 当前已发现的业务表 schema（2026-09-24 方案A：与工具层数据字典提示共享）。
 * undefined = 尚未发现；null = 发现失败/多 schema 歧义；string = 已发现的 OWNER。
 * identity 链路完成首次解析后即可供 query_dcs_data 描述动态引用，
 * 避免工具提示回退到登录用户名（只读账号非表所有者，会把模型引向死路）。
 */
export function getDiscoveredSchema(): string | null | undefined {
  return discoveredSchema;
}

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
 * 企微 userid → DCS 身份（仅 identity.json 文件层，同步）。
 * 未登记 / 未提供 userid → null（调用方以中性话术拒答）。
 * 供 identity.json 单独验证与手动覆盖场景使用；
 * 正式链路（含数据库解析）见 resolveIdentityAsync。
 */
export function resolveIdentity(
  userid: string,
  identityFile: string = process.env.DCS_IDENTITY_FILE ?? DEFAULT_IDENTITY_FILE
): DcsIdentity | null {
  if (!userid) return null;
  const map = loadIdentityMap(identityFile);
  return map.get(userid) ?? null;
}

/**
 * 企微 userid → DCS 身份（正式两级链路，异步）。
 * 1. identity.json 手动覆盖（文件存在且命中时优先）；
 * 2. 数据库 S2_Employee（UserId → Code/Name/DeptName，仅在职）；
 * 两级都未命中 / 数据库故障 → null（拒答，不让 bot 崩溃）。
 */
export async function resolveIdentityAsync(
  userid: string,
  identityFile: string = process.env.DCS_IDENTITY_FILE ?? DEFAULT_IDENTITY_FILE
): Promise<DcsIdentity | null> {
  if (!userid) return null;

  // 第 1 层：identity.json 手动覆盖（文件不存在时静默跳过，不算错误）
  if (fs.existsSync(identityFile)) {
    const fromFile = loadIdentityMap(identityFile).get(userid);
    if (fromFile) return fromFile;
  }

  // 第 2 层：DCS 数据库（未配置数据库 → 链路止于文件层）
  const client = getDbClient();
  if (!client) return null;
  // 白名单外的 userid 不查库（本查询为字符串拼接，防注入）
  if (!USERID_RE.test(userid)) return null;

  const cached = dbCache.get(userid);
  if (cached && Date.now() - cached.at < DB_CACHE_TTL_MS) return cached.identity;

  let identity: DcsIdentity | null = null;
  try {
    const schema = await resolveEmployeeSchema(client);
    if (schema === null) return null;
    const sql =
      `SELECT Code, Name, DeptName FROM ${schema}.S2_Employee ` +
      `WHERE UserId = '${userid}' AND LeaveDate IS NULL AND ROWNUM <= 1`;
    const { rows } = await client.execute(sql);
    const row = rows[0];
    if (row && row[0] !== null && row[1] !== null) {
      identity = {
        employeeNo: String(row[0]),
        name: String(row[1]),
        department: row[2] === null || row[2] === undefined ? undefined : String(row[2]),
        roles: [], // ADM 权限表接入前为空；菜单权限类问题由模型查库解决
      };
      console.log(
        `[identity] userid=${userid} → ${identity.name}/${identity.employeeNo}` +
          `（数据库解析，部门：${identity.department ?? "未知"}）`
      );
    }
  } catch (err) {
    // 数据库故障按未识别处理（拒答）；错误不缓存，下次消息重试
    console.error(`[identity] 数据库身份解析失败（userid=${userid}）：${String(err).slice(0, 200)}`);
    return null;
  }
  dbCache.set(userid, { identity, at: Date.now() });
  return identity;
}

/** 测试辅助：清空映射缓存（文件层、数据库层与 schema 发现）。 */
export function resetIdentityCache(): void {
  cache = null;
  cacheFile = "";
  dbCache.clear();
  discoveredSchema = undefined;
}

/**
 * 工号 → DCS 身份（Web 通道测试期身份入口：页面输入工号建档）。
 * 与企微链路同表同约束（S2_Employee，仅在职 LeaveDate IS NULL），
 * 按 Code 精确匹配；复用同一 schema 发现与缓存（key 加 "code:" 前缀）。
 * 未命中 / 数据库故障 → null（调用方以中性话术拒答，不崩溃）。
 * 上线前替换为真实认证（企微扫码 / SSO）时仅需替换调用方。
 */
export async function resolveEmployeeByCode(code: string): Promise<DcsIdentity | null> {
  if (!code || !USERID_RE.test(code)) return null;
  const client = getDbClient();
  if (!client) {
    // 静默失败会让使用者误以为工号不存在——明确打出原因
    console.warn("[identity] 数据库未配置（DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING），工号身份解析不可用。");
    return null;
  }

  const cacheKey = `code:${code}`;
  const cached = dbCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DB_CACHE_TTL_MS) return cached.identity;

  let identity: DcsIdentity | null = null;
  try {
    const schema = await resolveEmployeeSchema(client);
    if (schema === null) return null;
    const sql =
      `SELECT Code, Name, DeptName FROM ${schema}.S2_Employee ` +
      `WHERE Code = '${code}' AND LeaveDate IS NULL AND ROWNUM <= 1`;
    const { rows } = await client.execute(sql);
    const row = rows[0];
    if (row && row[0] !== null && row[1] !== null) {
      identity = {
        employeeNo: String(row[0]),
        name: String(row[1]),
        department: row[2] === null || row[2] === undefined ? undefined : String(row[2]),
        roles: [],
      };
      console.log(
        `[identity] 工号=${code} → ${identity.name}/${identity.employeeNo}` +
          `（web 通道数据库解析，部门：${identity.department ?? "未知"}）`
      );
    }
  } catch (err) {
    // 数据库故障按未识别处理（拒答）；错误不缓存，下次重试
    console.error(`[identity] 工号身份解析失败（code=${code}）：${String(err).slice(0, 200)}`);
    return null;
  }
  dbCache.set(cacheKey, { identity, at: Date.now() });
  return identity;
}
