import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { searchDcsCodeTool, readDcsCodeTool } from "./source-tools.ts";
import { readDcsResultTool } from "./result-tool.ts";
import { inspectDcsSchemaTool } from "./schema-tool.ts";
import { queryDcsDataTool } from "./query-tool.ts";
import { searchDcsKnowledgeTool } from "./knowledge/tool.ts";
export { searchDcsCodeTool, readDcsCodeTool, readDcsResultTool, inspectDcsSchemaTool, queryDcsDataTool };
export type { QueryDcsDataArgs } from "./query-tool.ts";
export const dcsTools: ToolDefinition<any, DcsToolContext>[] = [
  searchDcsKnowledgeTool, searchDcsCodeTool, readDcsCodeTool, inspectDcsSchemaTool, queryDcsDataTool, readDcsResultTool,
];
