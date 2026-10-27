export async function requestLoginMaterial(signal: AbortSignal, host: Window = window, timeoutMs = 12000): Promise<string> {
    const origin = (() => { try {
        return new URL(host.document.referrer).origin;
    }
    catch {
        return null;
    } })();
    if (!origin || host.parent === host)
        throw new Error("请从DCS父页面重新打开助手。");
    if (signal.aborted)
        throw new Error("cancelled");
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        let done = false;
        const finish = (code?: string, error?: string) => { if (done)
            return; done = true; clearTimeout(timer); host.removeEventListener("message", listener); signal.removeEventListener("abort", abort); code ? resolve(code) : reject(new Error(error)); };
        const listener = (e: MessageEvent) => {
            if (e.source !== host.parent || e.origin !== origin || e.data?.type !== "dcs_agent_auth_result" || e.data.requestId !== requestId)
                return;
            finish(typeof e.data.code === "string" ? e.data.code : undefined, e.data.status === "invalid" ? "login_invalid" : "login_unavailable");
        };
        const abort = () => finish(undefined, "cancelled"), timer = setTimeout(() => finish(undefined, "login_unavailable"), timeoutMs);
        host.addEventListener("message", listener);
        signal.addEventListener("abort", abort, { once: true });
        host.parent.postMessage({ type: "dcs_agent_reauthenticate", requestId }, origin);
    });
}
