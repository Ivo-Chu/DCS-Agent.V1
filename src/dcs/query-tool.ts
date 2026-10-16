import type { ToolDefinition, ToolOutput } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient, type DbClient } from "./db/client.ts";
import { requireTrustedEmployee, resolveSchema } from "./db/authorization.ts";
import { databaseError, failure } from "./db/result.ts";
import { queryCatalog, validateParams, executeBusinessQuery, type Params } from "./db/queries/catalog.ts";
import { maskPii } from "./hooks.ts";

export interface QueryDcsDataArgs { query?: string; params?: Params; sql?: string }
export const queryDcsDataTool: ToolDefinition<QueryDcsDataArgs, DcsToolContext> = {
  name: "query_dcs_data", label: "DCS授权数据查询",
  description: "用list_available发现固定业务查询及参数。本人和授权他人均可查询，由程序绑定请求者并验证真实业务规则。菜单不等于数据范围。unsupported是工具未覆盖，denied是明确无授权，unverifiable是无法验权，empty仅表示当前查询条件无记录。自由SQL不执行；元数据使用inspect_dcs_schema。",
  parameters: { type: "object", additionalProperties: false, properties: {
    query: { type: "string", enum: ["list_available", ...queryCatalog.map(q => q.name)] },
    params: { type: "object", description: "业务参数由list_available返回的各查询Schema定义；不能指定请求者或SQL。" },
    sql: { type: "string", description: "旧参数只返回unsupported，不执行。" },
  }, oneOf: [{ required: ["query"] }, { required: ["sql"] }] },
  async execute(args, ctx) {
    if (!args || Object.keys(args).some(k => !["query", "params", "sql"].includes(k)) ||
      (args.query === undefined) === (args.sql === undefined) ||
      (args.query !== undefined && typeof args.query !== "string") ||
      (args.sql !== undefined && (typeof args.sql !== "string" || !args.sql.trim())) ||
      (args.params !== undefined && (!args.params || typeof args.params !== "object" || Array.isArray(args.params)))) return failure("invalid_args", "请指定query和params；请求者身份来自会话。");
    if (args.sql !== undefined) return failure("unsupported", "自由SQL未实现受控授权，不执行；使用list_available发现已支持查询。这不代表DCS禁止该业务。");
    const name = args.query!;
    const p = args.params ?? {};
    if (name === "list_available") return Object.keys(p).length ? failure("invalid_args", "list_available不接受参数。") :
      { output: JSON.stringify({ status: "success", queries: queryCatalog, message: "这是工具能力目录，不是当前员工已获授权清单；执行时验权。" }) };
    if (!queryCatalog.some(q => q.name === name)) return failure("unsupported", "工具尚未覆盖此业务查询；可继续调查源码/操作文档，不能据此判定用户无权限。");
    const invalid = validateParams(name, p);
    if (invalid) return failure("invalid_args", invalid);
    const databaseQueries: Array<Record<string, unknown>> = [];
    const traced = (output: ToolOutput): ToolOutput => ({ ...output, details: { ...output.details, ...{ databaseQueries } } });
    try {
      const actor = requireTrustedEmployee(ctx), client = getDbClient();
      if (!client) return failure("unavailable", "数据库未配置。");
      const db: DbClient = { close: () => client.close(), async execute(sql, binds) {
        const start = Date.now();
        const trace: Record<string, unknown> = { sql, binds };
        databaseQueries.push(trace);
        try { const r = await client.execute(sql, binds); trace.rowCount = r.rows.length; trace.status = "success"; return r; }
        catch (error) { trace.status = "error"; trace.code = /(?:ORA|NJS|DPI)-\d+/.exec(String(error))?.[0]; throw error; }
        finally { trace.durationMs = Date.now() - start; }
      } };
      const owner = await resolveSchema(db);
      const execution = await executeBusinessQuery(name, p, db, owner, actor);
      const auth = execution.authorization;
      if (auth.status !== "authorized") return traced(failure(auth.status, auth.message, auth.code));
      const result = execution.result!, limit = Number(p.limit ?? 100), offset = Number(p.offset ?? 0);
      let contentTruncated = false;
      const rows = result.rows.slice(0, limit).map(row => row.map(value => {
        if (value === null || typeof value === "number" || typeof value === "boolean") return value;
        const text = maskPii(value instanceof Date ? value.toISOString() : String(value));
        if (text.length > 200) contentTruncated = true;
        return text.slice(0, 200);
      }));
      while (JSON.stringify(rows).length > 50000) { rows.pop(); contentTruncated = true; }
      const hasMore = Boolean(result.truncated || result.rows.length > rows.length);
      const truncated = hasMore || contentTruncated;
      return traced({ output: JSON.stringify({ status: result.rows.length ? "success" : "empty", query: name,
        authorization: auth, filters: execution.filters, columns: result.columns, rows,
        rowCount: result.rows.length, rowCountMeaning: "本次取回行数（含分页探测行），不是总命中数", returnedRowCount: rows.length,
        offset, hasMore, nextOffset: hasMore ? offset + rows.length : null, truncated, contentTruncated }),
        details: { rowCount: result.rows.length, columns: result.columns, truncated, empty: !result.rows.length } });
    } catch (error) { return traced(databaseError(error)); }
  },
};
