import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient, type DbBinds, type DbQueryResult } from "./db/client.ts";
import { databaseError, failure } from "./db/result.ts";
import { guardSql } from "./db/guard.ts";
import { createArtifact } from "./artifacts.ts";

export interface QueryDcsDataArgs { sql: string; binds?: DbBinds; previewRows?: number }
export function serializeDbValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { encoding: "base64", value: value.toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}
export const queryDcsDataTool: ToolDefinition<QueryDcsDataArgs, DcsToolContext> = {
  name: "query_dcs_data", label: "DCS SQL查询",
  description: "执行Oracle SELECT/WITH查询，支持JOIN、CTE、聚合、窗口函数和命名绑定变量。未知对象先查inspect_dcs_schema或源码，使用已确认的schema限定表名。返回少量预览及完整JSON结果文件resultFile，可用read_dcs_result分页读取。complete表示已取完结果；previewTruncated仅表示预览缩短。NUMBER为十进制字符串，日期ISO，二进制base64。空结果不等于错误；错误返回Oracle诊断供修正。",
  parameters: { type: "object", additionalProperties: false, properties: {
    sql: { type: "string", minLength: 1 },
    binds: { type: "object", additionalProperties: { type: ["string", "number", "null"] }, description: "命名绑定变量（SQL中:name，键为name）。日期绑定ISO文本并在SQL显式TO_DATE/TO_TIMESTAMP。" },
    previewRows: { type: "integer", minimum: 0, maximum: 200, default: 50 },
  }, required: ["sql"] },
  async execute(args, ctx) {
    if (!args || typeof args.sql !== "string" || Object.keys(args).some(k => !["sql", "binds", "previewRows"].includes(k))) return failure("invalid_args", "需要sql，可选binds、previewRows。");
    const previewRows = args.previewRows ?? 50, binds = args.binds ?? {};
    if (!Number.isInteger(previewRows) || previewRows < 0 || previewRows > 200 || !binds || typeof binds !== "object" || Array.isArray(binds) ||
      Object.values(binds).some(v => v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v)))) return failure("invalid_args", "previewRows范围0–200；binds值只能是字符串、有限数值或null。");
    const guard = guardSql(args.sql);
    if (!guard.ok) return failure("invalid_args", guard.reason!);
    const sql = args.sql.trim().replace(/;\s*$/, "");
    const db = getDbClient();
    if (!db) return failure("unavailable", "数据库未配置（DCS_DB_USER/DCS_DB_PASSWORD/DCS_DB_CONNECT_STRING）。");
    const signal = ctx.holder?.controller.signal, started = Date.now();
    let resultFile: string | null = null, fetchedRows = 0, complete = false, previewChars = 0, previewTruncated = false;
    let columns: string[] = [], columnTypes: DbQueryResult["columnTypes"] = [], rows: unknown[][] = [];
    let artifact: Awaited<ReturnType<typeof createArtifact>> | undefined;
    let opened = false;
    const writeBatch = async (batch: DbQueryResult) => {
      signal?.throwIfAborted();
      if (!opened) {
        columns = batch.columns; columnTypes = batch.columnTypes ?? [];
        await artifact!.handle.writeFile(`{"columns":${JSON.stringify(columns)},"columnTypes":${JSON.stringify(columnTypes)},"rows":[`);
        opened = true;
      }
      for (const row of batch.rows) {
        const values = row.map(serializeDbValue), json = JSON.stringify(values);
        await artifact!.handle.writeFile(`${fetchedRows ? "," : ""}${json}`);
        fetchedRows++;
        if (rows.length < previewRows && previewChars + json.length <= 16000 && !previewTruncated) {
          rows.push(values); previewChars += json.length;
        } else previewTruncated = true;
      }
    };
    let error: unknown;
    try {
      signal?.throwIfAborted();
      artifact = await createArtifact("query", "json"); resultFile = artifact.filename;
      if (db.stream) { await db.stream(sql, binds, writeBatch, signal); complete = true; }
      else { const r = await db.execute(sql, binds); await writeBatch(r); complete = !r.truncated; }
      signal?.throwIfAborted();
    } catch (e) { error = e; complete = false; }
    finally {
      if (artifact) {
        try {
          if (!opened) await artifact.handle.writeFile('{"columns":[],"columnTypes":[],"rows":[');
          await artifact.handle.writeFile(`],"fetchedRows":${fetchedRows},"complete":${complete}}`);
        } catch (e) { error = e; complete = false; resultFile = null; }
        finally { await artifact.handle.close(); }
      }
    }
    const data = { columns, columnTypes, rows, fetchedRows, complete, previewTruncated, resultFile, durationMs: Date.now() - started };
    if (error !== undefined) {
      const failureResult = signal?.aborted ? failure("cancelled", "查询已取消，文件中可能只有部分结果。") : databaseError(error);
      return { ...failureResult, output: JSON.stringify({ ...JSON.parse(failureResult.output), ...data }) };
    }
    return { output: JSON.stringify({ status: fetchedRows ? "success" : "empty", ...data }),
      details: { rowCount: fetchedRows, columns, truncated: !complete || previewTruncated, empty: fetchedRows === 0 } };
  },
};
