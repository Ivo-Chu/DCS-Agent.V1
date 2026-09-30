/**
 * dcs/agent-factory.ts 组装链路测试（2026-09-28 取消信号修复的回归）。
 *
 * 核心验证：不注入假 streamFn，走真实组装（createDcsAgent →
 * createDeepSeekStreamFn({signalProvider}) → fetch），仅拦截全局 fetch：
 * - 模型请求实际收到的 AbortSignal 必须就是 holder.controller.signal
 *   （同一对象，不是复制引用——复制正是旧 bug：超时 abort 打不到模型请求）；
 * - abort 后模型调用失败（错误编码为最终回复，Run 不崩溃）；
 * - 替换 holder.controller 后新 Run 的模型请求使用新的、未中止的信号；
 * - 旧 Run 迟到的模型结果不进入新回复。
 *
 * 运行：npm run test:factory
 */
import { createDcsAgent, DEFAULT_MAX_TURNS, type DcsAgentHolder } from "../src/dcs/agent-factory.ts";
import { createMockSession } from "../src/dcs/session.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n[场景] ${t}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
};

// ---------------------------------------------------------------------------
// 拦截全局 fetch：记录每次模型请求收到的 signal，返回永不结束的 SSE 流
// ---------------------------------------------------------------------------

interface FetchRecord {
  signal: AbortSignal | undefined;
  abortedAtCall: boolean;
}

const fetchCalls: FetchRecord[] = [];

const realFetch = globalThis.fetch;
// 模型请求挂起直至取消：signal abort 时 fetch 以 AbortError 拒绝（对齐真实
// fetch 的取消口径）。⚠ 不要改成"永不结束的 ReadableStream"：不接 signal 的
// 挂起流会让 reader.read() 永不 settle 且不占事件循环，Node 排空队列后静默
// 退出（退出码 0）——F3 之后的断言全部没跑，测试假绿（2026-09-28 实测踩坑）。
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const signal = init?.signal as AbortSignal | undefined;
  fetchCalls.push({
    signal,
    abortedAtCall: Boolean(signal?.aborted),
  });
  return new Promise<Response>((_resolve, reject) => {
    const abortNow = (): void => reject(signal?.reason ?? new Error("This operation was aborted"));
    if (signal?.aborted) {
      abortNow();
      return;
    }
    signal?.addEventListener("abort", abortNow, { once: true });
  });
}) as typeof fetch;

async function main(): Promise<void> {
  // createDeepSeekStreamFn 在工厂内读取环境变量；测试注入哑 key（不发真实请求）
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "sk-test-factory";

  section("F. agent-factory 取消信号组装链路（拦截 fetch，真实 DeepSeek StreamFn）");

  const holder: DcsAgentHolder = { controller: new AbortController() };
  const session = createMockSession();
  const agent = createDcsAgent({ session, holder });

  check("F0 默认 maxTurns 为 24（与 bot/web/CLI 同口径）", DEFAULT_MAX_TURNS === 24);

  // ---- F1/F2：第一轮 —— 模型请求收到的就是 holder 内的 signal ----
  const run1 = agent.prompt("第一问");
  check(
    "F1 模型请求实际发出且仅一次（真实组装链路触达 fetch）",
    await waitFor(() => fetchCalls.length === 1) && fetchCalls.length === 1,
    `fetchCalls=${fetchCalls.length}`
  );
  check(
    "F2 模型请求收到的 signal 就是 holder.controller.signal（同一对象，非复制引用）",
    fetchCalls[0]?.signal === holder.controller.signal,
    `signal 一致性失败：${String(fetchCalls[0]?.signal)}`
  );

  // ---- F3：超时 abort → 模型调用失败，错误编码为最终回复（Run 不崩溃）----
  holder.controller.abort();
  const reply1 = await run1;
  check(
    "F3 abort 后模型调用失败被编码为错误回复（含取消说明，prompt 不 reject）",
    reply1.includes("模型调用失败") && reply1.includes("已取消"),
    reply1.slice(0, 120)
  );

  // ---- F4/F5：新 Run —— 替换 holder.controller，新请求用新的未中止信号 ----
  const newController = new AbortController();
  holder.controller = newController;
  const run2 = agent.prompt("超时后的新问题");
  check(
    "F4 新 Run 的模型请求已发出",
    await waitFor(() => fetchCalls.length === 2) && fetchCalls.length === 2
  );
  check(
    "F5 新 Run 模型请求收到新 holder.controller.signal（未中止，旧 abort 不影响）",
    fetchCalls[1]?.signal === newController.signal && newController.signal.aborted === false,
    `aborted=${String(newController.signal.aborted)}`
  );

  // ---- F6：旧 Run 迟到结果不进入新回复（新回复只包含自己的内容）----
  newController.abort();
  const reply2 = await run2;
  check(
    "F6 新 Run 正常以错误回复结束（迟到概念由 finished 标志在 Channel 层隔离，见 wecom P8）",
    reply2.includes("模型调用失败") && reply2.includes("已取消"),
    reply2.slice(0, 120)
  );

  // ---- F7：企微/Web 的运行时替换路径 —— 模拟 Channel 层每 Run 替换 ----
  holder.controller = new AbortController();
  const run3 = agent.prompt("第三问");
  await waitFor(() => fetchCalls.length === 3);
  const signal3 = fetchCalls[2]?.signal;
  check(
    "F7 每次替换 holder.controller 后，下一次模型请求立即使用新信号",
    signal3 === holder.controller.signal && signal3 !== newController.signal,
    undefined
  );
  holder.controller.abort();
  const reply3 = await run3;
  check("F8 第三轮同样被正确取消并返回错误回复", reply3.includes("已取消"), reply3.slice(0, 120));

  console.log(`\n========== agent-factory 测试结果 ==========`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
}

main().finally(() => {
  globalThis.fetch = realFetch;
});
