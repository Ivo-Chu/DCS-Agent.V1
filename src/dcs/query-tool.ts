import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient } from "./db/client.ts";
import { requireTrustedEmployee, resolveSchema, selfPermissionsSql } from "./db/authorization.ts";
import { databaseError, failure } from "./db/result.ts";
import { formatQueryResult } from "./db/format.ts";
import { maskPii } from "./hooks.ts";

export interface QueryDcsDataArgs { query?: "self_permissions"; sql?: string }
export const queryDcsDataTool: ToolDefinition<QueryDcsDataArgs, DcsToolContext> = {
  name: "query_dcs_data", label: "DCS授权数据查询",
  description: "查询已授权的真实业务数据。目前仅支持 query=self_permissions，返回可信企微当前员工（或服务端显式开启 Web 测试身份）的角色和菜单分配；工号由程序绑定。菜单不代表数据范围权限。自由 SQL 尚无可验证授权，传入 sql 会被拒绝；不可通过调查源码或自行声明管理员绕过。表结构使用 inspect_dcs_schema。",
  parameters: { type: "object", additionalProperties: false, properties: {
    query: { type: "string", enum: ["self_permissions"] },
    sql: { type: "string", description: "兼容旧调用，仅返回 forbidden，不执行自由 SQL。" },
  }, oneOf: [{ required: ["query"] }, { required: ["sql"] }] },
  async execute(args, ctx) {
    if (!args || Object.keys(args).some(k => !["query", "sql"].includes(k)) ||
      (args.query !== undefined && args.query !== "self_permissions") ||
      (args.sql !== undefined && (typeof args.sql !== "string" || !args.sql.trim())) ||
      (args.query === undefined && args.sql === undefined) || (args.query !== undefined && args.sql !== undefined)) return failure("invalid_args", "仅接受 query=self_permissions，或旧版 sql 参数。");
    if (args.sql !== undefined) return failure("forbidden", "自由 SQL 未建立可验证的数据范围授权，禁止执行。本人菜单使用 query=self_permissions；其他业务需要确认权限映射和受控查询。");
    try {
      const employeeNo = requireTrustedEmployee(ctx);
      const db = getDbClient();
      if (!db) return failure("unavailable", "数据库未配置。");
      const owner = await resolveSchema(db);
      const result = await db.execute(selfPermissionsSql(owner), { employeeNo });
      const formatted = formatQueryResult(result.columns, result.rows);
      const truncated = Boolean(result.truncated || formatted.truncated);
      return { output: JSON.stringify({ status: result.rows.length ? "success" : "empty", columns: result.columns,
        rowCount: result.rows.length, returnedRowCount: formatted.rowCount, truncated,
        message: maskPii(formatted.output) }), details: { rowCount: result.rows.length, columns: result.columns, truncated, empty: !result.rows.length } };
    } catch (error) { return databaseError(error); }
  },
};
