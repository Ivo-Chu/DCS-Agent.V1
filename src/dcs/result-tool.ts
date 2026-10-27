import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { toolOutputDirectory } from "./artifacts.ts";
import { failure } from "./db/result.ts";
import { integer, resolveReadPath, validKeys } from "./read-path.ts";

interface ResultArgs { resultFile: string; select?: Array<string | number>; offset?: number; limit?: number }
// 大条目只展示结构；完整值可通过返回的select路径继续读取，不静默截断。
function preview(value: unknown): { value: unknown; partial: boolean } {
  if (value === null || typeof value !== "object") return typeof value === "string" && value.length > 1000
    ? { value: value.slice(0, 1000), partial: true } : { value, partial: false };
  const keys = Object.keys(value);
  const summary = Array.isArray(value) ? { type: "array", length: value.length }
    : { type: "object", keys: keys.slice(0, 20), totalKeys: keys.length };
  // 先限制遍历范围，避免为顶层rows预览再次序列化完整大结果。
  if (keys.length > 20) return { value: summary, partial: true };
  for (const key of keys) if (preview((value as Record<string, unknown>)[key]).partial) return { value: summary, partial: true };
  return JSON.stringify(value).length <= 2000 ? { value, partial: false } : { value: summary, partial: true };
}

export const readDcsResultTool: ToolDefinition<ResultArgs, DcsToolContext> = {
  name: "read_dcs_result", label: "查询结果读取",
  description: "只读SQL/结构工具生成的resultFile。select是JSON属性/数组下标路径，如[\"rows\"]、[\"objects\",0,\"columns\"]，不传则列出顶层条目。数组/对象按条目分页，字符串按字符分页，offset从0开始。partial条目用其select继续读取；sourceComplete表示原查询完整性，hasMore仅表示当前值仍有下一页。",
  parameters: { type: "object", additionalProperties: false, properties: {
    resultFile: { type: "string", minLength: 1 }, select: { type: "array", maxItems: 20, items: { type: ["string", "integer"] } },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 },
  }, required: ["resultFile"] },
  async execute(a, ctx) {
    if (!validKeys(a, ["resultFile", "select", "offset", "limit"]) || typeof a.resultFile !== "string" ||
      (a.select !== undefined && (!Array.isArray(a.select) || a.select.length > 20 || a.select.some(v => typeof v !== "string" && !integer(v, 0, Number.MAX_SAFE_INTEGER)))) ||
      !integer(a.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) || !integer(a.limit ?? 50, 1, 16000)) return failure("invalid_args", "检查resultFile、select及分页参数。");
    const signal = ctx.holder?.controller.signal;
    try {
      signal?.throwIfAborted();
      const filename = await resolveReadPath(toolOutputDirectory(), a.resultFile);
      if (!/^(query|schema)-[0-9a-f-]{36}\.json$/i.test(path.basename(filename))) return failure("invalid_args", "只支持SQL或结构工具生成的结果文件。");
      const root = JSON.parse(await fs.readFile(filename, { encoding: "utf8", signal }));
      const kind = path.basename(filename).startsWith("query-") ? "query" : "schema";
      if (!root || typeof root !== "object" || typeof root.complete !== "boolean" ||
        (kind === "query" ? !Array.isArray(root.rows) || !Array.isArray(root.columns) : !Array.isArray(root.items) && !Array.isArray(root.objects))) throw new Error("结果文件格式不支持。");
      const selected = a.select ?? [];
      let value: any = root;
      for (const key of selected) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return failure("invalid_args", "select指向的条目不存在。");
        value = value[key];
      }
      const offset = a.offset ?? 0;
      const metadata = { sourceComplete: root.complete, ...(kind === "query" ? { columns: root.columns, fetchedRows: root.fetchedRows } : {}) };
      if (typeof value === "string") {
        const text = value.slice(offset, offset + (a.limit ?? 4000));
        const hasMore = offset + text.length < value.length;
        return { output: JSON.stringify({ ...metadata, select: selected, text, length: value.length, hasMore, nextOffset: hasMore ? offset + text.length : null }) };
      }
      if (value === null || typeof value !== "object") return { output: JSON.stringify({ ...metadata, select: selected, value, hasMore: false, nextOffset: null }) };
      const keys = Object.keys(value), limit = Math.min(a.limit ?? 50, 100);
      const entries = []; let chars = 0;
      for (const key of keys.slice(offset, offset + limit)) {
        const entry = { select: [...selected, Array.isArray(value) ? Number(key) : key], ...preview(value[key]) };
        const size = JSON.stringify(entry).length;
        if (entries.length && chars + size > 16000) break;
        entries.push(entry); chars += size;
      }
      signal?.throwIfAborted();
      const hasMore = offset + entries.length < keys.length;
      return { output: JSON.stringify({ ...metadata, select: selected, entries, totalEntries: keys.length, hasMore, nextOffset: hasMore ? offset + entries.length : null }) };
    } catch (e) { return failure(signal?.aborted ? "cancelled" : "read_error", String(e)); }
  },
};
