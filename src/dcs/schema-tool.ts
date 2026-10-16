import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient, type DbQueryResult } from "./db/client.ts";
import { IDENTIFIER, requireTrustedEmployee, resolveSchema } from "./db/authorization.ts";
import { databaseError, failure } from "./db/result.ts";

export interface InspectSchemaArgs { operation: "list" | "describe"; keyword?: string; tables?: string[]; limit?: number; schema?: string }
const records = (r: DbQueryResult) => r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
export const inspectDcsSchemaTool: ToolDefinition<InspectSchemaArgs, DcsToolContext> = {
  name: "inspect_dcs_schema", label: "DCS数据库结构调查",
  description: "调查允许暴露的数据库元数据，不读取业务记录。list 按 keyword 字面子串找表（默认20，最多50）；describe 一次最多5张表，返回字段、主键及数据库实际外键。开发诊断可查看批准的DCS Schema内数据库账号可见的表结构；元数据可见不代表业务数据授权。没有外键不代表不存在业务关系，未知关系不可猜测。",
  parameters: { type: "object", additionalProperties: false, properties: {
    schema: { type: "string", description: "可选，必须与服务端批准/发现的DCS Schema一致" },
    operation: { type: "string", enum: ["list", "describe"] }, keyword: { type: "string", minLength: 1, maxLength: 128 },
    tables: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  }, required: ["operation"] },
  async execute(a, ctx) {
    if (!a || Object.keys(a).some(k => !["operation", "keyword", "tables", "limit", "schema"].includes(k)) || !["list", "describe"].includes(a.operation)) return failure("invalid_args", "operation 必须为 list/describe。");
    if (a.operation === "list" ? (typeof a.keyword !== "string" || !a.keyword.trim() || a.keyword.length > 128 || a.tables !== undefined || (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 50))) :
      (!Array.isArray(a.tables) || !a.tables.length || a.tables.length > 5 || a.tables.some(t => typeof t !== "string" || !IDENTIFIER.test(t.toUpperCase())) || new Set(a.tables.map(t => t.toUpperCase())).size !== a.tables.length || a.keyword !== undefined || a.limit !== undefined)) return failure("invalid_args", "list 需要 keyword；describe 需要1至5个不重复的合法表名。");
    try {
      requireTrustedEmployee(ctx);
      const tables = a.operation === "describe" ? a.tables!.map(t => t.toUpperCase()) : [];
      const db = getDbClient();
      if (!db) return failure("unavailable", "数据库未配置。");
      const owner = await resolveSchema(db);
      if (a.schema !== undefined && (typeof a.schema !== "string" || !IDENTIFIER.test(a.schema.toUpperCase()))) return failure("invalid_args", "schema必须是合法标识符。");
      if (a.schema && a.schema.toUpperCase() !== owner) return failure("denied", "此Schema不在服务端批准的数据源范围内。");
      const binds: Record<string, string | number> = { owner };
      tables.forEach((t, i) => { binds[`t${i}`] = t; });
      const names = tables.map((_, i) => `:t${i}`).join(",");
      if (a.operation === "list") {
        const limit = a.limit ?? 20;
        const result = await db.execute(`SELECT OWNER, TABLE_NAME FROM (SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER = :owner AND INSTR(TABLE_NAME, :keyword) > 0 ORDER BY TABLE_NAME) WHERE ROWNUM <= :take`, { ...binds, keyword: a.keyword!.trim().toUpperCase(), take: limit + 1 });
        const rows = records(result).slice(0, limit);
        return { output: JSON.stringify({ status: rows.length ? "success" : "empty", tables: rows, count: rows.length, truncated: Boolean(result.truncated || result.rows.length > limit) }) };
      }
      const columns = await db.execute(`SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER = :owner AND TABLE_NAME IN (${names}) ORDER BY TABLE_NAME, COLUMN_ID`, binds);
      const keys = await db.execute(`SELECT c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, cc.COLUMN_NAME, cc.POSITION,
        rc.OWNER AS REFERENCED_OWNER, rc.TABLE_NAME AS REFERENCED_TABLE, rcc.COLUMN_NAME AS REFERENCED_COLUMN
        FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
        LEFT JOIN ALL_CONSTRAINTS rc ON rc.OWNER = c.R_OWNER AND rc.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
        LEFT JOIN ALL_CONS_COLUMNS rcc ON rcc.OWNER = rc.OWNER AND rcc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND rcc.POSITION = cc.POSITION
        WHERE c.OWNER = :owner AND c.TABLE_NAME IN (${names}) AND c.CONSTRAINT_TYPE IN ('P', 'R')
        ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`, binds);
      // 不暴露指向未授权对象的外键端点。
      const visibleKeys = records(keys).filter(k => k.CONSTRAINT_TYPE === "P" || (k.REFERENCED_OWNER === owner));
      const allColumns = records(columns);
      let truncated = Boolean(columns.truncated || keys.truncated);
      const output = { status: allColumns.length ? "success" : "empty", owner, tables: tables.map(table => ({ table,
        status: allColumns.some(c => c.TABLE_NAME === table) ? "success" : "not_found_or_not_visible",
        columns: allColumns.filter(c => c.TABLE_NAME === table), constraints: visibleKeys.filter(k => k.TABLE_NAME === table),
        businessRelationships: "unknown" })), truncated,
        message: "仅返回数据库实际约束；不可见或未定义的关系均未知。未读取业务样例。" };
      while (JSON.stringify(output).length > 24000) {
        const largest = [...output.tables].sort((x, y) => (y.columns.length + y.constraints.length) - (x.columns.length + x.constraints.length))[0];
        if (largest.columns.length) largest.columns.pop(); else largest.constraints.pop();
        output.truncated = true;
      }
      return { output: JSON.stringify(output) };
    } catch (e) { return databaseError(e); }
  },
};
