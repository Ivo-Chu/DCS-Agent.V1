/**
 * dcs/db/guard.ts — SQL 稳定性护栏（纯函数，方案 query-dcs-data-plan-v1 §5）。
 *
 * 测试期最小集：仅防卡死与误写，不做权限收紧（账号本身只读，双保险）。
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
  return { ok: true };
}
