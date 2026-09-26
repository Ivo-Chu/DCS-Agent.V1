/**
 * dcs/db/format.ts — 查询结果格式化（纯函数，方案 §5）。
 *
 * - maxRows=100：超出截断并注明（提示模型加 WHERE 收窄）；
 * - 输出总体积 60KB 保险：超出截断并注明；
 * - 单元格渲染：null→NULL，其余 String()，超长截断。
 */
export const MAX_ROWS = 100;
export const MAX_OUTPUT_CHARS = 60 * 1024;
const MAX_CELL_CHARS = 200;

export interface FormattedQueryResult {
  /** 格式化文本。 */
  output: string;
  /** 是否因行数 / 体积被截断。 */
  truncated: boolean;
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "string" ? v : String(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

export function formatQueryResult(columns: string[], rows: unknown[][]): FormattedQueryResult {
  const total = rows.length;
  const limited = rows.slice(0, MAX_ROWS);
  const parts: string[] = [];
  parts.push(`查询成功：返回 ${total} 行${total > MAX_ROWS ? `（已截断至前 ${MAX_ROWS} 行，建议加 WHERE 收窄）` : ""}。`);
  parts.push(columns.map((c) => renderCell(c)).join(" | "));
  for (const row of limited) {
    parts.push(row.map((v) => renderCell(v)).join(" | "));
  }
  let text = parts.join("\n");
  let truncated = total > MAX_ROWS;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出体积达上限已截断，建议加 WHERE 收窄查询范围）`;
    truncated = true;
  }
  return { output: text, truncated };
}
