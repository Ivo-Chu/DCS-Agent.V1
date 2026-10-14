import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { investigateDcsCodeTool } from "./code-tool.ts";
import { inspectDcsSchemaTool } from "./schema-tool.ts";
import { queryDcsDataTool } from "./query-tool.ts";
import { searchDcsKnowledgeTool } from "./knowledge/tool.ts";
export { investigateDcsCodeTool, inspectDcsSchemaTool, queryDcsDataTool };
export type { InvestigateDcsCodeArgs } from "./code-tool.ts";
export type { QueryDcsDataArgs } from "./query-tool.ts";
export const dcsTools: ToolDefinition<any, DcsToolContext>[] = [
  searchDcsKnowledgeTool, investigateDcsCodeTool, inspectDcsSchemaTool, queryDcsDataTool,
];
