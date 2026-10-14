import type { ToolOutput } from "../../core/types.ts";
export function failure(status: string, message: string, code?: string): ToolOutput {
  return { output: JSON.stringify({ status, code, message, isError: true }), isError: true, details: { errorCode: code } };
}
export function databaseError(error: unknown): ToolOutput {
  const text = error instanceof Error ? error.message : String(error);
  if (/^(forbidden|unavailable):/.test(text)) {
    const [status, ...rest] = text.split(":");
    return failure(status, rest.join(":").trim());
  }
  const code = /(?:ORA|NJS|DPI)-\d+/.exec(text)?.[0];
  if (/ORA-01013|ORA-03156|DPI-1067|NJS-040|NJS-076|timeout|timed out/i.test(text)) return failure("timeout", "数据库查询超时，请缩小范围后重试。", code);
  if (/NJS-|DPI-|ORA-12\d+|ORA-03113|ORA-03114|ORA-01017|ORA-28000|ECONN|ENOTFOUND/i.test(text)) return failure("unavailable", "数据库连接不可用，请检查网络及数据库配置。", code);
  if (code === "ORA-01031") return failure("forbidden", "数据库账号缺少所需权限。", code);
  const descriptions: Record<string, string> = { "ORA-00904": "引用了不存在的字段。", "ORA-00933": "SQL 不符合 Oracle 语法。", "ORA-00942": "表或视图不存在，或账号无访问权限。" };
  return failure(code ? "sql_error" : "unavailable", descriptions[code ?? ""] ?? "数据库执行失败，请根据错误码检查服务端配置。", code);
}
