import type { NavigationResult } from "./api";

/** 一次导航一次等待；成功、超时和取消均移除监听器与定时器。 */
export function waitForNavigation(
  requestId: string, menuName: string, origin: string | null, signal: AbortSignal,
  host: Window = window, timeoutMs = 25000,
): Promise<NavigationResult> {
  if (!origin || host.parent === host) return Promise.resolve({ ok: false, message: "未找到DCS父页面，导航未执行。" });
  if (signal.aborted) return Promise.resolve({ ok: false, message: "已停止等待导航结果。" });
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: NavigationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.removeEventListener("message", listener);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== host.parent) return;
      const data = event.data;
      if (data?.type !== "dcs_agent_navigate_result" || data.requestId !== requestId ||
          typeof data.ok !== "boolean" || typeof data.message !== "string") return;
      finish({ ok: data.ok, message: data.message, ...(data.status ? { status: data.status } : {}), ...(Array.isArray(data.candidates) ? { candidates: data.candidates.map((c: {title:string;path:string}) => ({title:c.title,path:c.path})) } : {}) });
    };
    const abort = () => finish({ ok: false, message: "已停止等待导航结果。" });
    const timer = setTimeout(() => finish({ ok: false, message: "DCS页面未返回导航结果。" }), timeoutMs);
    host.addEventListener("message", listener);
    signal.addEventListener("abort", abort, { once: true });
    try { host.parent.postMessage({ type: "dcs_agent_navigate", requestId, menuName }, origin); }
    catch { finish({ ok: false, message: "无法向DCS页面发送导航请求。" }); }
  });
}
