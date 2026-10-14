/**
 * observability/redact.ts — 日志凭据脱敏（写入终端/JSONL 之前的统一防线）。
 *
 * 分层铁律：core 不产生展示逻辑，本模块是唯一执行日志内容安全处理的位置。
 *
 * 边界（2026-10-13 用户澄清）：
 * - 开发者日志（Console / DEBUG / JSONL）允许员工工号、姓名、业务查询明细
 *   及排障所需源码路径——不再套用"禁止明文保存员工记录"（该限制针对
 *   Agent 对话输出，由 dcs/hooks.ts 的模型上下文脱敏管线负责，不在本模块）。
 * - 仍需脱敏：密码、API Key、Access Token、数据库连接凭据等访问凭据。
 *   按【字段名 + 嵌套结构】识别凭据（值脱敏语境）＋文本内常见凭据赋值形态
 *   （password=xxx / "apiKey": "xxx" 等）。
 * - Token 用量统计字段（inputTokens/cacheReadTokens 等）是数字，不是访问
 *   令牌，绝不能被误脱敏。
 *
 * 输出只用于日志副本，绝不修改工具参数、工具结果和模型上下文。
 */

/**
 * 文本内常见凭据赋值形态（仅日志副本，不修改业务 Hook）：password=xxx / "ApiKey": "xxx" / token: xxx 等。
 * 单独保留一份在本模块：observability 不反向依赖 dcs 业务层。
 */
export const CREDENTIAL_TEXT_RE =
  /\b(password|pwd|secret|api[-_]?key|access[-_]?(?:key|token|secret)|refresh[-_]?token|auth[-_]?token|token|connection[-_]?string|dsn)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^;\s,}]+)/gi;

/** 访问凭据字段名（按字段名识别值脱敏语境）。 */
const CREDENTIAL_KEY_RE =
  /^(?:pass(?:word)?|pwd|secret|token|api[-_]?key|access[-_]?(?:key|token|secret)|auth[-_]?token|refresh[-_]?token|authorization|proxy-authorization|credential|credentials|connection[-_]?string|dsn)$/i;

/**
 * Token 用量等统计字段（数字）——显式排除，永不脱敏。
 * 必须带 input/output/cache 等前缀或为复数 tokens；裸字段名 token 是访问
 * 令牌语境，按凭据脱敏。
 */
const USAGE_KEY_RE =
  /^(?:(?:input|output|cache|cached|total|prompt|completion|reasoning|cacheRead|cacheWrite)tokens?|tokens)$/i;

const MASKED = "***";

/** 脱敏字符串值中的文本凭据（不影响员工业务明细）。 */
export function redactCredentialsText(text: string): string {
  return text.replace(/\b((?:authorization|proxy-authorization)["']?\s*[=:]\s*["']?(?:Bearer|Basic)\s+)[^\s"',;}]+/gi, "$1***").replace(CREDENTIAL_TEXT_RE, (m) => {
    const name = m.match(/^[^=:]+/)?.[0]?.trim();
    return `${name ?? "credential"}=***`;
  });
}

/** 通用文本脱敏：仅处理凭据（员工业务数据、源码路径按新边界保留）。 */
export function redactText(text: string): string {
  return redactCredentialsText(text);
}

/**
 * SQL 脱敏：仅遮蔽凭据文本（连接串里的密码等）。
 * 保留字符串字面值（员工工号/姓名是排障必需的业务条件）与双引号字段标识符
 * （"ROOMNAME" 是字段名不是字面值，按新边界保留）。
 */
export function redactSql(sql: string): string {
  return redactCredentialsText(sql);
}

/**
 * 递归脱敏对象/数组：按字段名识别凭据并整体遮蔽；
 * 其余字符串值只处理文本凭据形态；用量统计字段明确跳过。
 * 返回新对象，不修改入参。
 */
export function redactValue(value: unknown, keyName?: string): unknown {
  if (keyName !== undefined && typeof value === "number" && USAGE_KEY_RE.test(keyName)) {
    return value; // Token 用量统计字段：原样保留
  }
  if (keyName !== undefined && CREDENTIAL_KEY_RE.test(keyName)) {
    return value == null ? value : MASKED;
  }
  if (typeof value === "string") {
    return redactCredentialsText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/**
 * 工具参数安全副本：递归按字段名+结构脱敏凭据。
 * 返回 JSON 单行字符串（供展示与 JSONL 落盘；重复调用指纹另见 observer，
 * 使用原始参数的内存规范化，不用本摘要）。
 */
export function redactArgs(_toolName: string, args: unknown): string {
  return JSON.stringify(redactValue(args));
}
