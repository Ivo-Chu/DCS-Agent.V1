/** 仅供旧 Runtime 剧本验证分发/消息/错误恢复，不证明生产数据授权。生产工具见 tools-v2.test.ts。 */
import { dcsTools } from "../src/dcs/tools.ts";
import { getDbClient } from "../src/dcs/db/client.ts";
import { guardSql } from "../src/dcs/db/guard.ts";
import { formatQueryResult } from "../src/dcs/db/format.ts";
import type { ToolDefinition } from "../src/core/types.ts";
import type { DcsToolContext } from "../src/dcs/session.ts";
export const runtimeQueryFixture: ToolDefinition<{ sql: string }, DcsToolContext> = {
  name: "query_dcs_data", label: "Runtime测试查询", description: "测试专用的假查询工具", parameters: { type: "object" },
  async execute(a) {
    const guard = guardSql(a.sql);
    if (!guard.ok) return { output: `SQL 被拒绝：${guard.reason} SELECT`, isError: true };
    const db = getDbClient();
    if (!db) return { output: "不可用 DCS_DB_USER", isError: true };
    try {
      const result = await db.execute(a.sql);
      return { output: formatQueryResult(result.columns, result.rows).output };
    } catch (e) { return { output: `${String(e)} 可修正 SQL 后重试`, isError: true }; }
  },
};
export const runtimeToolsFixture = dcsTools.map(t => t.name === runtimeQueryFixture.name ? runtimeQueryFixture : t);
