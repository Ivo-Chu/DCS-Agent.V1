import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient, type DbBinds, type DbQueryResult } from "./db/client.ts";
import { resolveSchema } from "./db/authorization.ts";
import { databaseError, failure } from "./db/result.ts";
import { createArtifact } from "./artifacts.ts";
import { serializeDbValue } from "./query-tool.ts";

const OBJECT_TYPES = ["TABLE", "VIEW", "MATERIALIZED VIEW", "SYNONYM", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY", "TRIGGER", "TYPE", "TYPE BODY"];
const SEARCH_IN = ["objectName", "columnName", "comment"];
const INCLUDE = ["columns", "comments", "constraints", "indexes", "dependencies"];
export interface InspectSchemaArgs {
  operation: "search" | "describe" | "definition";
  schema?: string; keyword?: string; objectTypes?: string[]; searchIn?: string[];
  objects?: string[]; include?: string[]; offset?: number; limit?: number;
}
const records = (r: DbQueryResult) => r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, serializeDbValue(row[i])])));
const validList = (v: unknown, choices: string[]) => Array.isArray(v) && v.length > 0 && v.every(x => choices.includes(x)) && new Set(v).size === v.length;
const pageSql = (sql: string) => `SELECT * FROM (SELECT q.*, ROWNUM AS DCS_PAGE_ROW FROM (${sql}) q WHERE ROWNUM <= :pageEnd) WHERE DCS_PAGE_ROW > :pageOffset`;

export const inspectDcsSchemaTool: ToolDefinition<InspectSchemaArgs, DcsToolContext> = {
  name: "inspect_dcs_schema", label: "DCS数据库结构调查",
  description: "Oracle结构调查。search按对象名/字段名/注释的字面子串发现表、视图、同义词、过程等；describe批量读取已知objects的字段、注释、约束、索引和依赖；definition读取视图SQL、ALL_SOURCE程序源码、同义词指向。schema可指定，缺省配置/自动发现DCS所有者；名称按Oracle大小写原样传入。search和程序源码支持offset/limit分页。返回truncated/complete及nextOffset；数据库外键仅表示已登记关系，不代表全部业务关联。大结果保存在UTF-8 JSON文件供read_dcs_result分页读取。",
  parameters: { type: "object", additionalProperties: false, properties: {
    operation: { type: "string", enum: ["search", "describe", "definition"] },
    schema: { type: "string", minLength: 1 }, keyword: { type: "string", minLength: 1 },
    objectTypes: { type: "array", items: { type: "string", enum: OBJECT_TYPES }, minItems: 1, uniqueItems: true },
    searchIn: { type: "array", items: { type: "string", enum: SEARCH_IN }, minItems: 1, uniqueItems: true },
    objects: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20, uniqueItems: true },
    include: { type: "array", items: { type: "string", enum: INCLUDE }, minItems: 1, uniqueItems: true },
    offset: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
  }, required: ["operation"], allOf: [
    { if: { properties: { operation: { const: "search" } } }, then: { required: ["keyword"] } },
    { if: { properties: { operation: { enum: ["describe", "definition"] } } }, then: { required: ["objects"] } },
  ] },
  async execute(a, ctx) {
    if (!a || !["search", "describe", "definition"].includes(a.operation) ||
      Object.keys(a).some(k => !["operation", "schema", "keyword", "objectTypes", "searchIn", "objects", "include", "offset", "limit"].includes(k))) return failure("invalid_args", "operation必须为search/describe/definition。");
    const offset = a.offset ?? 0, limit = a.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit + 1) || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
      (a.schema !== undefined && (typeof a.schema !== "string" || !a.schema.trim())) ||
      (a.objectTypes !== undefined && !validList(a.objectTypes, OBJECT_TYPES)) ||
      (a.searchIn !== undefined && !validList(a.searchIn, SEARCH_IN)) ||
      (a.include !== undefined && !validList(a.include, INCLUDE))) return failure("invalid_args", "检查schema、分页参数或选项列表。");
    if (a.operation === "search" ? (typeof a.keyword !== "string" || !a.keyword.trim() || a.objects !== undefined || a.include !== undefined) :
      (!Array.isArray(a.objects) || !a.objects.length || a.objects.length > 20 || a.objects.some(x => typeof x !== "string" || !x.trim()) || new Set(a.objects).size !== a.objects.length || a.keyword !== undefined || a.searchIn !== undefined)) return failure("invalid_args", "search需要keyword；describe/definition需要1–20个不重复的objects名称。");
    if ((a.operation === "describe" && (a.offset !== undefined || a.limit !== undefined || a.objectTypes !== undefined)) ||
      (a.operation === "definition" && a.include !== undefined)) return failure("invalid_args", "describe仅接受schema/objects/include；definition不接受include。");
    const signal = ctx.holder?.controller.signal;
    try {
      signal?.throwIfAborted();
      const db = getDbClient();
      if (!db) return failure("unavailable", "数据库未配置。");
      const owner = a.schema?.trim() || await resolveSchema(db);
      let complete = true;
      const read = async (sql: string, binds: DbBinds) => {
        signal?.throwIfAborted();
        const r = await db.execute(sql, binds);
        signal?.throwIfAborted();
        if (r.truncated) complete = false;
        return r;
      };
      const typeBinds: DbBinds = {};
      const types = a.objectTypes ?? OBJECT_TYPES;
      types.forEach((t, i) => { typeBinds[`type${i}`] = t; });
      const typeNames = types.map((_, i) => `:type${i}`).join(",");
      let payload: Record<string, unknown>;
      if (a.operation === "search") {
        const scope = a.searchIn ?? SEARCH_IN;
        const clauses: string[] = [];
        if (scope.includes("objectName")) clauses.push("INSTR(UPPER(OBJECT_NAME), :keyword) > 0");
        if (scope.includes("columnName")) clauses.push("INSTR(UPPER(COLUMN_NAME), :keyword) > 0");
        if (scope.includes("comment")) clauses.push("INSTR(UPPER(COMMENTS), :keyword) > 0");
        const sql = `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, COLUMN_NAME, COMMENTS FROM (
          SELECT o.OWNER, o.OBJECT_NAME, o.OBJECT_TYPE, CAST(NULL AS VARCHAR2(128)) COLUMN_NAME, c.COMMENTS
          FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER=o.OWNER AND c.TABLE_NAME=o.OBJECT_NAME
          WHERE o.OWNER=:owner AND o.SUBOBJECT_NAME IS NULL
          UNION ALL
          SELECT c.OWNER, c.TABLE_NAME OBJECT_NAME, o.OBJECT_TYPE, c.COLUMN_NAME, cc.COMMENTS
          FROM ALL_TAB_COLUMNS c JOIN ALL_OBJECTS o ON o.OWNER=c.OWNER AND o.OBJECT_NAME=c.TABLE_NAME AND o.SUBOBJECT_NAME IS NULL AND o.OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW')
          LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER=c.OWNER AND cc.TABLE_NAME=c.TABLE_NAME AND cc.COLUMN_NAME=c.COLUMN_NAME
          WHERE c.OWNER=:owner
        ) WHERE OBJECT_TYPE IN (${typeNames}) AND (${clauses.join(" OR ")}) ORDER BY OBJECT_NAME, OBJECT_TYPE, COLUMN_NAME`;
        const r = await read(pageSql(sql), { owner, keyword: a.keyword!.trim().toUpperCase(), ...typeBinds, pageOffset: offset, pageEnd: offset + limit + 1 });
        const items = records(r).slice(0, limit).map(({ DCS_PAGE_ROW, ...item }) => item);
        const hasMore = Boolean(r.truncated || r.rows.length > limit);
        payload = { status: items.length ? "success" : "empty", owner, items, offset, hasMore, nextOffset: hasMore ? offset + items.length : null, complete: complete && !hasMore };
      } else {
        const objects: Record<string, unknown>[] = [];
        for (const name of a.objects!) {
          const binds = { owner, name };
          const item: Record<string, unknown> = { name };
          if (a.operation === "describe") {
            const includes = a.include ?? INCLUDE;
            const queries: Record<string, string> = {
              columns: `SELECT c.COLUMN_NAME,c.DATA_TYPE,c.DATA_LENGTH,c.DATA_PRECISION,c.DATA_SCALE,c.CHAR_LENGTH,c.CHAR_USED,c.NULLABLE,c.DATA_DEFAULT,cc.COMMENTS FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER=c.OWNER AND cc.TABLE_NAME=c.TABLE_NAME AND cc.COLUMN_NAME=c.COLUMN_NAME WHERE c.OWNER=:owner AND c.TABLE_NAME=:name ORDER BY c.COLUMN_ID`,
              comments: `SELECT TABLE_NAME,TABLE_TYPE,COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER=:owner AND TABLE_NAME=:name`,
              constraints: `SELECT c.CONSTRAINT_NAME,c.CONSTRAINT_TYPE,c.STATUS,c.SEARCH_CONDITION,cc.COLUMN_NAME,cc.POSITION,rc.OWNER REFERENCED_OWNER,rc.TABLE_NAME REFERENCED_TABLE,rcc.COLUMN_NAME REFERENCED_COLUMN FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONS_COLUMNS cc ON cc.OWNER=c.OWNER AND cc.CONSTRAINT_NAME=c.CONSTRAINT_NAME LEFT JOIN ALL_CONSTRAINTS rc ON rc.OWNER=c.R_OWNER AND rc.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME LEFT JOIN ALL_CONS_COLUMNS rcc ON rcc.OWNER=rc.OWNER AND rcc.CONSTRAINT_NAME=rc.CONSTRAINT_NAME AND rcc.POSITION=cc.POSITION WHERE c.OWNER=:owner AND c.TABLE_NAME=:name ORDER BY c.CONSTRAINT_NAME,cc.POSITION`,
              indexes: `SELECT i.INDEX_NAME,i.INDEX_TYPE,i.UNIQUENESS,i.STATUS,c.COLUMN_NAME,c.COLUMN_POSITION,c.DESCEND FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER=i.OWNER AND c.INDEX_NAME=i.INDEX_NAME WHERE i.TABLE_OWNER=:owner AND i.TABLE_NAME=:name ORDER BY i.INDEX_NAME,c.COLUMN_POSITION`,
              dependencies: `SELECT OWNER,NAME,TYPE,REFERENCED_OWNER,REFERENCED_NAME,REFERENCED_TYPE,DEPENDENCY_TYPE FROM ALL_DEPENDENCIES WHERE (OWNER=:owner AND NAME=:name) OR (REFERENCED_OWNER=:owner AND REFERENCED_NAME=:name) ORDER BY OWNER,NAME,TYPE,REFERENCED_OWNER,REFERENCED_NAME`,
            };
            for (const include of includes) item[include] = records(await read(queries[include], binds));
          } else {
            const source = await read(pageSql(`SELECT NAME,TYPE,LINE,TEXT FROM ALL_SOURCE WHERE OWNER=:owner AND NAME=:name AND TYPE IN (${typeNames}) ORDER BY TYPE,LINE`),
              { ...binds, ...typeBinds, pageOffset: offset, pageEnd: offset + limit + 1 });
            item.source = records(source).slice(0, limit).map(({ DCS_PAGE_ROW, ...r }) => r);
            item.nextOffset = source.truncated || source.rows.length > limit ? offset + Math.min(limit, source.rows.length) : null;
            if (item.nextOffset !== null) complete = false;
            if (types.includes("VIEW")) item.views = records(await read("SELECT VIEW_NAME,TEXT FROM ALL_VIEWS WHERE OWNER=:owner AND VIEW_NAME=:name", binds));
            if (types.includes("MATERIALIZED VIEW")) item.materializedViews = records(await read("SELECT MVIEW_NAME,QUERY FROM ALL_MVIEWS WHERE OWNER=:owner AND MVIEW_NAME=:name", binds));
            if (types.includes("SYNONYM")) item.synonyms = records(await read("SELECT SYNONYM_NAME,TABLE_OWNER,TABLE_NAME,DB_LINK FROM ALL_SYNONYMS WHERE OWNER=:owner AND SYNONYM_NAME=:name", binds));
          }
          item.status = Object.values(item).some(v => Array.isArray(v) && v.length) ? "success" : "not_found_or_no_metadata";
          objects.push(item);
        }
        payload = { status: objects.some(o => o.status === "success") ? "success" : "empty", owner, objects, complete,
          message: "数据库登记的依赖/约束不是完整业务关系；动态SQL与应用代码关系请结合源码调查。" };
      }
      const output = JSON.stringify(payload);
      if (output.length <= 24000) return { output };
      const artifact = await createArtifact("schema", "json");
      try { await artifact.handle.writeFile(output); } finally { await artifact.handle.close(); }
      return { output: JSON.stringify({ status: payload.status, owner, complete: payload.complete, previewTruncated: true,
        resultFile: artifact.filename, message: "元数据输出较长，完整本次结果已保存；用read_dcs_result选择items/objects继续读取。complete=false时还需分页或进一步SQL调查。" }) };
    } catch (error) { return signal?.aborted ? failure("cancelled", "数据库结构调查已取消。") : databaseError(error); }
  },
};
