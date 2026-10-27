/**
 * dcs/db/guard.ts — SQL 稳定性护栏（纯函数，方案 query-dcs-data-plan-v1 §5）。
 *
 * 查询语句预检查，不是SQL解析器。数据库继续使用只读事务。
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
  // 字符串、带引号标识符和注释中的关键字/分号不属于SQL操作。
  let out = "", i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; out += " "; }
    else if (sql.startsWith("/*", i)) { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; out += " "; }
    else if ((sql[i] === "q" || sql[i] === "Q") && sql[i + 1] === "'") {
      const open = sql[i + 2], close = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(`${close}'`, i + 3); i = end < 0 ? sql.length : end + 2; out += " value ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      while (i < sql.length) { if (sql[i++] === quote) { if (sql[i] === quote) i++; else break; } }
      out += " value ";
    } else out += sql[i++];
  }
  return out.trim().replace(/;\s*$/, "");
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
    return { ok: false, reason: "本工具执行查询，不接受写入、过程调用或内嵌 PL/SQL。" };
  }
  return { ok: true };
}
