/**
 * dcs/db/guard.ts — SQL 稳定性护栏（纯函数，方案 query-dcs-data-plan-v1 §5）。
 *
 * 文本预检查，不是 SQL 解析器或授权边界。生产 query_dcs_data 不执行自由 SQL；
 * 由 authorization.ts 的可信身份及固定参数化查询决定可执行内容。
 * - 仅允许 SELECT / WITH 开头；
 * - 单语句（含注释中藏分号的检测）；
 * - 拒绝 FOR UPDATE 锁定。
 */
export interface SqlGuardResult {
  ok: boolean;
  /** 拒绝原因（ok=false 时存在，供模型修正）。 */
  reason?: string;
}

/** 去掉行注释 / 块注释 / 首尾空白与结尾分号，返回用于校验的语句体。 */
function stripForCheck(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "");
}

export function guardSql(sql: string): SqlGuardResult {
  const body = stripForCheck(sql ?? "");
  if (body.length === 0) {
    return { ok: false, reason: "SQL 为空。" };
  }
  // 单语句：语句体任何位置不得再出现分号（注释已在上面移除）
  if (body.includes(";")) {
    return { ok: false, reason: "仅允许单条语句（检测到多条语句，请去掉分号后重试）。" };
  }
  if (!/^(select|with)\b/i.test(body)) {
    return { ok: false, reason: "仅允许 SELECT / WITH 开头的只读查询。" };
  }
  if (/\bfor\s+update\b/i.test(body)) {
    return { ok: false, reason: "不允许锁定语句（FOR UPDATE）。" };
  }
  if (/\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|execute|begin|declare|function|procedure)\b/i.test(body)) {
    return { ok: false, reason: "不接受写入、过程或内嵌 PL/SQL；此预检查不代表查询已获授权。" };
  }
  return { ok: true };
}
