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
  rowCount: number;
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
  let truncated = total > MAX_ROWS || [...columns, ...limited.flat()].some(v => String(v ?? "").length > MAX_CELL_CHARS);
  let rowCount = 0;
  // 按 JSON 字符串预算计数，工具序列化时的引号/反斜杠转义也计入。
  let chars = JSON.stringify(parts.join("\n")).length;
  for (const row of limited) {
    const line = row.map((v) => renderCell(v)).join(" | ");
    const lineChars = JSON.stringify(line).length;
    if (chars + lineChars + 2 > MAX_OUTPUT_CHARS - 1000) { truncated = true; break; }
    parts.push(line); chars += lineChars + 2; rowCount++;
  }
  if (truncated) parts.push("…（行数、单元格或输出体积达上限已截断；未展示内容不可据此推断）");
  return { output: parts.join("\n"), truncated, rowCount };
}
