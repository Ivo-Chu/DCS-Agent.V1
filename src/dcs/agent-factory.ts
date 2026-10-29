/**
 * dcs/agent-factory.ts — DCS Agent 统一组装工厂。
 *
 * 2026-09-28 取消信号修复（用户方案一）：
 * 此前 bot.ts / server.ts 各自组装 Agent，并把 holder.controller 的初始值
 * 复制进 entry；每 Run 替换的是 entry.controller，模型 signalProvider 闭包
 * 读取的 holder 从未更新——超时 abort 打在模型不读的控制器上，取消无效。
 *
 * 现在的约定：
 * - 工厂接收【会话 + 可变 holder 对象】，signalProvider 每次求值读
 *   holder.controller.signal；
 * - Channel 层（bot/web）把同一个 holder 对象存进 entry，每 Run 开始时
 *   替换 holder.controller = new AbortController()，超时/断开时 abort 它；
 * - 模型读取、运行时替换、超时取消三者始终是同一个对象，复制即 bug。
 *
 * 不新增框架层：就是一次函数调用，CLI / Web / 企微 / 验收脚本共用。
 */
import { Agent } from "../core/agent.ts";
import { createOpenAiStreamFn } from "../core/model/openai-compatible.ts";
import type { StreamFn } from "../core/types.ts";
import { createDcsToolHooks } from "./hooks.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { DcsSession, DcsToolContext } from "./session.ts";
import { dcsTools } from "./tools.ts";
import { prepareEvidenceRun } from "./evidence.ts";
import type { ToolDefinition } from "../core/types.ts";
import { statSync } from "node:fs";
import { sourceRoot } from "./read-path.ts";
import { isDbConfigured } from "./db/client.ts";
import { getKnowledgeConfig } from "./knowledge/config.ts";
import { indexExists } from "./knowledge/store.ts";
import { requestClarificationTool } from "./clarification-tool.ts";
import type { EvidenceRunOptions } from "./evidence.ts";
import { searchSourceMap } from "./source-map.ts";

/** 可变取消信号持有器（Channel 层持有并替换 controller，模型读取同一对象）。 */
export interface DcsAgentHolder {
  controller: AbortController;
}

export interface CreateDcsAgentOptions {
  /** 已构造的 DCS 会话（身份由 Channel 层解析，工厂不关心来源）。 */
  session: DcsSession;
  /** 取消信号持有器：与 Channel 层运行时替换/abort 的是同一个对象。 */
  holder: DcsAgentHolder;
  /** 测试注入的假模型；缺省为真实 LLM（读取环境变量）。 */
  streamFn?: StreamFn;
  /** 单 Run 最大轮数，默认 24（测试期宽松安全阀，非生产参数）。 */
  maxTurns?: number;
  /** Channel 专用工具（如 Web 菜单导航）；不改变核心调查工具。 */
  extraTools?: ToolDefinition[];
  /** Server-side restriction for isolated runs; never supplied by browser input. */
  allowedToolNames?: string[];
}

export const DEFAULT_MAX_TURNS = 32;

export function createDcsAgent(opts: CreateDcsAgentOptions): Agent<DcsToolContext> {
  const { session, holder, streamFn, maxTurns = DEFAULT_MAX_TURNS } = opts;
  const defaultEvidence = session.user.source === "web";
  const tools = [...dcsTools, ...(opts.extraTools ?? []), ...(defaultEvidence ? [requestClarificationTool] : [])];
  return new Agent<DcsToolContext>({
    systemPrompt: buildSystemPrompt(session) + (session.user.source === "web" && opts.extraTools?.some(t => t.name === "navigate_dcs_menu") ? "\n【Web 页面导航规则】明确要求打开、进入、切换页面时，优先调用 navigate_dcs_menu，不强制先查知识库。询问操作方法、申请流程、制度说明时再按问题检索知识库。needs_selection 时界面已展示完整候选按钮，只需简短提示用户点击选择，不再列出候选路径，不猜选；只有工具实际返回 opened/switched 才能报告打开/切换成功。unsupported仅表示打开方式不支持，不能推断为管理员权限、后台同步或业务不可用。" : ""),
    tools,
    prepareRun: async (text, history, requestContext) => {
      let sourceAvailable = false;
      try { sourceAvailable = (!defaultEvidence || !!process.env.DCS_SOURCE_ROOT?.trim()) && statSync(sourceRoot()).isDirectory(); } catch { /* unavailable */ }
      const knowledge = getKnowledgeConfig();
      const availableToolNames = tools.filter(t => {
        if (opts.allowedToolNames && !opts.allowedToolNames.includes(t.name)) return false;
        if (t.name === "search_dcs_code" || t.name === "read_dcs_code") return sourceAvailable;
        if (t.name === "search_dcs_knowledge") return !!knowledge && indexExists(knowledge.indexDir);
        if (["inspect_dcs_schema", "query_dcs_data", "read_dcs_result"].includes(t.name)) return isDbConfigured();
        return true;
      }).map(t => t.name);
      const evidenceOptions: EvidenceRunOptions = { defaultEvidence, history,
        availableToolNames: defaultEvidence || opts.allowedToolNames ? availableToolNames : undefined,
        pageContext: requestContext?.pageContext as EvidenceRunOptions["pageContext"],
      };
      let prepared = prepareEvidenceRun(text, tools, evidenceOptions);
      if (prepared.policy && prepared.text.trim() && availableToolNames.some(n => n === "search_dcs_code" || n === "read_dcs_code")) {
        // Lightweight local lookup only: these verified references remain clues, never source evidence.
        try {
          const query = [prepared.text, evidenceOptions.pageContext?.title, evidenceOptions.pageContext?.path].filter(Boolean).join(" ");
          const result = await searchSourceMap(query, 0, 30);
          evidenceOptions.verifiedTargets = result.items;
          evidenceOptions.indexState = { status: result.status, indexSha256: result.indexSha256, hasMore: result.hasMore, rejected: result.rejected };
        } catch {
          evidenceOptions.indexState = { status: "unavailable", hint: "地图不可用，继续普通源码搜索。" };
        }
        prepared = prepareEvidenceRun(text, tools, evidenceOptions);
      }
      // Exempt Web requests keep streaming/auto, while retaining the same server-side tool boundary.
      if (!prepared.policy && (defaultEvidence || opts.allowedToolNames)) {
        prepared.policy = { prepareTurn: () => ({ toolChoice: "auto", toolNames: availableToolNames }),
          systemPromptSuffix: "\n本次为简短寒暄或明确改写。改写时保留原回答的条件和不确定性，不增加新的业务事实，也不能把历史助手表述当作新核实的依据。",
          snapshot: () => ({ requireEvidence: false }) };
      }
      return prepared;
    },
    signalProvider: () => holder.controller.signal,
    // signalProvider 每次模型调用求值：holder.controller 被 Channel 层替换后，
    // 下一轮模型请求立即使用新信号；被 abort 后旧 Run 无法再发起新请求
    streamFn: streamFn ?? createOpenAiStreamFn({
      signalProvider: () => holder.controller.signal,
    }),
    // holder 同时进入 toolContext：search_dcs_knowledge 等需要外部请求的工具
    // 读取同一 holder——模型请求与工具请求看到同一个取消信号
    toolContext: { session, holder },
    hooks: createDcsToolHooks(),
    maxTurns,
  });
}
