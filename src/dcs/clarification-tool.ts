import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";

/** The model selects missing information, never writes an unchecked answer through this tool. */
export const clarificationQuestions = {
  business_object: "请补充要了解的功能名称或业务对象。",
  page: "请补充当前页面名称，或说明你要在哪个功能页面操作。",
  filters: "请补充要查询的范围或筛选条件。",
  time_range: "请补充要查询的日期或时间范围。",
  record: "请补充要查询的记录编号或可用于定位该记录的信息。",
} as const;
export type MissingInfo = keyof typeof clarificationQuestions;
export function clarificationQuestion(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(clarificationQuestions, value)
    ? clarificationQuestions[value as MissingInfo] : undefined;
}
export const requestClarificationTool: ToolDefinition<{ missingInfo: MissingInfo }, DcsToolContext> = {
  name: "request_clarification", label: "补充问题信息",
  description: "仅在缺少业务对象、页面、筛选范围、时间或记录信息，导致无法确定调查目标时，请用户补充。已有明确目标时应继续调查，不能用追问代替调查。此工具不返回业务结论、不取得证据。",
  parameters: { type: "object", additionalProperties: false, properties: {
    missingInfo: { type: "string", enum: Object.keys(clarificationQuestions) },
  }, required: ["missingInfo"] },
  async execute(args) {
    const question = clarificationQuestion(args?.missingInfo);
    if (!args || Object.keys(args).some(key => key !== "missingInfo") || !question) {
      return { output: JSON.stringify({ status: "invalid_args", message: "missingInfo 必须是支持的缺失信息类型，不接受自定义回答。" }), isError: true };
    }
    return { output: JSON.stringify({ status: "awaiting_input", missingInfo: args.missingInfo, question }) };
  },
};
