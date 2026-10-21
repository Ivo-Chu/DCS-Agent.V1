/** 复用 DCS CheckSSOCode；只接受其实际成功返回契约。 */
export async function checkSsoCodeWithDcs(
  code: string,
  checkUrl: string,
  log: (msg: string) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string | null> {
  const configured = options.timeoutMs ?? Number(process.env.DCS_SSO_TIMEOUT_MS ?? 10000);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const res = await fetch(checkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { IsSuccess?: unknown; Data?: { EmpCode?: unknown } } | null;
    return body?.IsSuccess === true && typeof body.Data?.EmpCode === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(body.Data.EmpCode) ? body.Data.EmpCode : null;
  } catch {
    // 不把远端响应、code 或可能包含凭据的异常字符串写入日志。
    log(controller.signal.aborted ? "[web] DCS SSO 校验超时或已取消" : "[web] DCS SSO 校验失败");
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
