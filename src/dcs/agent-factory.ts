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
import { createDeepSeekStreamFn } from "../core/model/deepseek.ts";
import type { StreamFn } from "../core/types.ts";
import { createDcsToolHooks } from "./hooks.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { DcsSession, DcsToolContext } from "./session.ts";
import { dcsTools } from "./tools.ts";

/** 可变取消信号持有器（Channel 层持有并替换 controller，模型读取同一对象）。 */
export interface DcsAgentHolder {
  controller: AbortController;
}

export interface CreateDcsAgentOptions {
  /** 已构造的 DCS 会话（身份由 Channel 层解析，工厂不关心来源）。 */
  session: DcsSession;
  /** 取消信号持有器：与 Channel 层运行时替换/abort 的是同一个对象。 */
  holder: DcsAgentHolder;
  /** 测试注入的假模型；缺省为真实 DeepSeek（读取环境变量）。 */
  streamFn?: StreamFn;
  /** 单 Run 最大轮数，默认 24（测试期宽松安全阀，非生产参数）。 */
  maxTurns?: number;
}

export const DEFAULT_MAX_TURNS = 24;

export function createDcsAgent(opts: CreateDcsAgentOptions): Agent<DcsToolContext> {
  const { session, holder, streamFn, maxTurns = DEFAULT_MAX_TURNS } = opts;
  return new Agent<DcsToolContext>({
    systemPrompt: buildSystemPrompt(session),
    tools: dcsTools,
    // signalProvider 每次模型调用求值：holder.controller 被 Channel 层替换后，
    // 下一轮模型请求立即使用新信号；被 abort 后旧 Run 无法再发起新请求
    streamFn: streamFn ?? createDeepSeekStreamFn({
      signalProvider: () => holder.controller.signal,
    }),
    // holder 同时进入 toolContext：search_dcs_knowledge 等需要外部请求的工具
    // 读取同一 holder——模型请求与工具请求看到同一个取消信号
    toolContext: { session, holder },
    hooks: createDcsToolHooks(),
    maxTurns,
  });
}
