/**
 * dcs/hooks.ts
 * DCS Hook 实现：PII 脱敏 + 凭据脱敏。
 *
 * v1 不实现 beforeToolCall 的业务逻辑：
 * Agent 构造时传入的 tools 列表本身已经决定模型可以使用哪些工具，
 * 无需再叠加一层静态"工具白名单"校验。
 * 未来出现动态 Tool 权限 / 高风险 Tool 审批 / 参数安全检查时再实现。
 *
 * 只实现 afterToolCall：ToolResult 回填模型之前执行脱敏，
 * 管线为 execute → 原始 ToolResult → afterToolCall → 脱敏 → 写入消息 → 下一轮 LLM。
 * 脱敏内容：
 * - PII：11 位手机号、18 位身份证（掩码中段）；
 * - 凭据（方案 v2 §7）：Password / Pwd / Secret / Token / ApiKey / AccessKey
 *   的值，含 connectionString 中的密码字段——源码与配置可以被调查，
 *   但真实凭据值不能进入模型上下文。
 */
import type { ToolHooks } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";

/** 11 位手机号（不做前后紧跟数字的匹配，避免截取身份证片段）。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 18 位身份证号（末位可为 X/x）。最先处理，避免被部分匹配。 */
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
/**
 * 凭据脱敏（方案 v2 §7）：Password / Pwd / Secret / Token / ApiKey / AccessKey
 * 的赋值或配置值，含 connectionString 中的密码字段。
 * 源码与配置可以被调查（模型可知道"这里存在数据库配置"），
 * 但真实凭据值不能进入模型上下文。
 * 匹配形态：password=xxx / "Password": "xxx" / Password=xxx; / pwd: xxx
 */
const CREDENTIAL_RE =
  /(password|pwd|secret|apikey|accesskey)["']?\s*[=:]\s*["']?[^;"'\s,}]+/gi;

/** 手机号 → 138****5678；身份证 → 掩码中段（前 6 后 4）；凭据值 → 名称=***。 */
export function maskPii(text: string): string {
  let out = text.replace(ID_CARD_RE, (m) => `${m.slice(0, 6)}********${m.slice(14)}`);
  // 凭据先于手机号：凭据值可能是长数字串，先整段脱掉避免被手机正则截断成片段
  out = out.replace(CREDENTIAL_RE, (m) => {
    const name = m.match(/^[^=:]+/)?.[0]?.trim();
    return `${name ?? "credential"}=***`;
  });
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
