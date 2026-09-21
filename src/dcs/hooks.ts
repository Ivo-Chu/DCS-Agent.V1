/**
 * dcs/hooks.ts
 * DCS Hook 实现：PII 脱敏。
 *
 * v1 不实现 beforeToolCall 的业务逻辑：
 * Agent 构造时传入的 tools 列表本身已经决定模型可以使用哪些工具，
 * 无需再叠加一层静态"工具白名单"校验。
 * 未来出现动态 Tool 权限 / 高风险 Tool 审批 / 参数安全检查时再实现。
 *
 * 只实现 afterToolCall：ToolResult 回填模型之前执行 PII 脱敏，
 * 管线为 execute → 原始 ToolResult → afterToolCall → 脱敏 → 写入消息 → 下一轮 LLM。
 */
import type { ToolHooks } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";

/** 11 位手机号（不做前后紧跟数字的匹配，避免截取身份证片段）。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 18 位身份证号（末位可为 X/x）。先于手机号处理，避免被部分匹配。 */
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;

/** 手机号 → 138****5678；身份证 → 掩码中段（前 6 后 4）。 */
export function maskPii(text: string): string {
  let out = text.replace(ID_CARD_RE, (m) => `${m.slice(0, 6)}********${m.slice(14)}`);
  out = out.replace(PHONE_RE, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
  return out;
}

export function createDcsToolHooks(): ToolHooks<DcsToolContext> {
  return {
    // beforeToolCall：v1 不实现（见文件头说明）
    afterToolCall(_toolName, _args, resultText, _ctx) {
      return maskPii(resultText);
    },
  };
}
