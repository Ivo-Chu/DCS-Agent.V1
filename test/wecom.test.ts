/**
 * Channel 层确定性测试（Step 5/6/7/8 + §11 话术卫生）。
 * 全部使用注入的假动作 / 假 Agent / 可控时钟与定时器，不依赖 WeCom SDK、
 * DeepSeek 或真实身份数据。
 *
 * 运行：npm run test:wecom
 */
import { AgentRunner, type UserAgentSlot } from "../src/wecom/agent-runner.ts";
import {
  CONFIRM_PROMPT,
  BUSY_PROMPT,
  ConversationManager,
  isConfirmText,
} from "../src/wecom/conversation.ts";
import { MsgIdDedup } from "../src/wecom/dedup.ts";
import { buildSystemPrompt } from "../src/dcs/prompt.ts";
import { createMockSession } from "../src/dcs/session.ts";
import { checkDcsPermissionTool } from "../src/dcs/tools.ts";

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

// ---------------------------------------------------------------------------
// 辅助：假动作记录器 + 可控时钟
// ---------------------------------------------------------------------------

interface LogEntry {
  kind: "askConfirm" | "notifyBusy" | "runAgent";
  userId?: string;
  question?: string;
}

function makeActions(log: LogEntry[], runImpl?: (userId: string, q: string) => Promise<void>) {
  return {
    async askConfirm(): Promise<void> {
      log.push({ kind: "askConfirm" });
    },
    async notifyBusy(): Promise<void> {
      log.push({ kind: "notifyBusy" });
    },
    async runAgent(userId: string, question: string): Promise<void> {
      log.push({ kind: "runAgent", userId, question });
      await runImpl?.(userId, question);
    },
  };
}

// ---------------------------------------------------------------------------
// 场景 M：输入确认状态机（Step 5）
// ---------------------------------------------------------------------------

section("M. 输入确认状态机");

{
  const log: LogEntry[] = [];
  const mgr = new ConversationManager({ actions: makeActions(log) });

  // M1: IDLE → 首条消息暂存并询问
  await mgr.handle("u1", "黄石智通已勾选无需协调员", "t1");
  check("M1 首条消息不进 Agent，触发询问确认", log.length === 1 && log[0].kind === "askConfirm");
  check("M2 状态进入 COLLECTING 且消息已暂存", mgr.stateOf("u1") === "COLLECTING" && mgr.bufferOf("u1").join() === "黄石智通已勾选无需协调员");

  // M3: 补充消息追加
  await mgr.handle("u1", "但是离职流程还是显示协调员信息", "t2");
  check("M3 补充消息仍不进 Agent，再次询问", log.length === 2 && log[1].kind === "askConfirm" && mgr.bufferOf("u1").length === 2);

  // M4: 确认 → 合并完整问题 → runAgent
  await mgr.handle("u1", "发送完毕", "t3");
  check(
    "M4 确认后合并完整问题进入 Agent",
    log.length === 3 && log[2].kind === "runAgent" && log[2].question === "黄石智通已勾选无需协调员，但是离职流程还是显示协调员信息",
    log[2]?.question
  );
  check("M5 Run 结束后回到 IDLE", mgr.stateOf("u1") === "IDLE");

  // M6: 处理中的新消息 → busy，不排队
  const log2: LogEntry[] = [];
  const releaseBox: { fn: undefined | (() => void) } = { fn: undefined };
  const gate = new Promise<void>((r) => {
    releaseBox.fn = r;
  });
  const mgr2 = new ConversationManager({
    actions: makeActions(log2, () => gate),
  });
  const runP = mgr2.handle("u2", "问题一", "t1"); // 进入 COLLECTING（askConfirm 是同步完成的）
  await runP;
  const confirmP = mgr2.handle("u2", "确认", "t2");
  check("M6 确认后状态为 PROCESSING", mgr2.stateOf("u2") === "PROCESSING");
  await mgr2.handle("u2", "处理中插进来的话", "t3");
  check("M7 处理中新消息 → notifyBusy，不进入 Agent", log2.some((e) => e.kind === "notifyBusy") && log2.filter((e) => e.kind === "runAgent").length === 1);
  releaseBox.fn?.();
  await confirmP;
  check("M8 Run 结束回到 IDLE，插话未排队", mgr2.stateOf("u2") === "IDLE" && log2.filter((e) => e.kind === "runAgent").length === 1);
}

// ---------------------------------------------------------------------------
// 场景 N：多员工会话隔离（Step 6）
// ---------------------------------------------------------------------------

section("N. 多员工会话隔离");

{
  const log: LogEntry[] = [];
  const resets: string[] = [];
  let fakeNow = 1_000_000;
  const mgr = new ConversationManager({
    actions: makeActions(log),
    now: () => fakeNow,
    idleMs: 30 * 60 * 1000,
    onReset: (u) => resets.push(u),
  });

  await mgr.handle("A", "A 的问题前半", "ta1");
  await mgr.handle("B", "B 的问题", "tb1");
  check("N1 A、B 各自独立暂存（互不串扰）", mgr.bufferOf("A").join() === "A 的问题前半" && mgr.bufferOf("B").join() === "B 的问题");

  await mgr.handle("A", "A 的问题后半", "ta2");
  check("N2 A 追加不影响 B", mgr.bufferOf("A").length === 2 && mgr.bufferOf("B").length === 1);

  await mgr.handle("B", "完毕", "tb2");
  const bRun = log.find((e) => e.kind === "runAgent" && e.userId === "B");
  check("N3 B 的问题独立进入 Agent", (bRun as { question: string } | undefined)?.question === "B 的问题");

  // N4: 空闲 30 分钟回收
  fakeNow += 31 * 60 * 1000;
  await mgr.handle("A", "新问题", "ta3");
  check("N4 空闲超阈值后会话重置（旧暂存被清空、onReset 触发）", resets.includes("A") && mgr.bufferOf("A").join() === "新问题");

  // N5: 未超阈值不回收
  await mgr.handle("A", "补充", "ta4");
  check("N5 活跃期间不重置", !resets.includes("A") || resets.filter((r) => r === "A").length === 1);
}

// ---------------------------------------------------------------------------
// 场景 O：msgid 去重（Step 7）
// ---------------------------------------------------------------------------

section("O. msgid 去重 + TTL");

{
  let fakeNow = 5_000_000;
  const dedup = new MsgIdDedup(10 * 60 * 1000, () => fakeNow);
  check("O1 首次出现 → false（正常处理）", dedup.seenBefore("m1") === false);
  check("O2 重复出现 → true（忽略）", dedup.seenBefore("m1") === true);
  check("O3 不同 msgid → false", dedup.seenBefore("m2") === false);

  fakeNow += 11 * 60 * 1000;
  check("O4 超过 TTL 后同 msgid 再次处理（TTL 生效）", dedup.seenBefore("m1") === false);
  check("O5 过期清扫控制内存增长（旧条目被清除）", dedup.size === 1, `实际 ${dedup.size}`);
}

// ---------------------------------------------------------------------------
// 场景 P：超时控制（Step 8）
// ---------------------------------------------------------------------------

section("P. 超时控制（runId 失效 / 迟到丢弃 / 实例废弃 / abort）");

{
  // 可挂起的假 Agent（holder 保存 resolver，避免 TS 控制流收窄）
  function makeFakeAgent() {
    const st = { resolver: null as null | ((v: string) => void), calls: 0 };
    const agent = {
      prompt(q: string): Promise<string> {
        void q;
        st.calls++;
        return new Promise<string>((r) => {
          st.resolver = r;
        });
      },
    };
    const slot: UserAgentSlot = { agent, controller: new AbortController() };
    return { slot, st };
  }

  const replies: { content: string; finish: boolean }[] = [];
  let streamSeq = 0;
  const slots = new Map<string, ReturnType<typeof makeFakeAgent>>();
  const discarded: string[] = [];
  const timerBox: { fn: null | (() => void) } = { fn: null };

  const runner = new AgentRunner({
    getSlot: (userId) => {
      let a = slots.get(userId);
      if (!a) {
        a = makeFakeAgent();
        slots.set(userId, a);
      }
      return a.slot;
    },
    discardAgent: (userId) => {
      discarded.push(userId);
      slots.delete(userId);
    },
    replyStream: async (_t, _sid, content, finish) => {
      replies.push({ content, finish });
    },
    newStreamId: () => `s${++streamSeq}`,
    budgetMs: 90_000,
    schedule: (fn) => {
      timerBox.fn = fn;
      return () => {
        timerBox.fn = null;
      };
    },
  });

  // 让 Runner 内部异步管线推进到 agent.prompt 已被调用
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  // P1–P3: 正常完成
  const run1 = runner.run("u1", "正常问题", "tok1");
  await tick();
  check("P1 Run 开始即发送占位语（finish=false）", replies.length === 1 && replies[0].content.includes("正在查询") && replies[0].finish === false, JSON.stringify(replies));
  check("P1b 占位语之后 Agent 已被调用（prompt 挂起等待）", slots.get("u1")!.st.calls === 1);
  slots.get("u1")!.st.resolver?.("正常答案");
  await run1;
  check("P2 正常答案以 finish=true 发送", replies.length === 2 && replies[1].content === "正常答案" && replies[1].finish === true, JSON.stringify(replies));
  check("P3 正常路径不废弃 Agent 实例", discarded.length === 0);

  // P4–P7: 超时路径
  replies.length = 0;
  const run2 = runner.run("u2", "会超时的问题", "tok2");
  await tick();
  const slot2 = slots.get("u2")!.slot;
  timerBox.fn?.(); // 手动触发超时
  await run2;
  check("P4 超时后 Run 立即结束（会话可回 IDLE）", true);
  check("P5 超时提示以 finish=true 发送", replies.length === 2 && replies[1].content.includes("超时") && replies[1].finish === true, JSON.stringify(replies));
  check("P6 超时废弃 Agent 实例（防 Context 污染）", discarded.includes("u2") && !slots.has("u2"));
  check("P7 超时即 abort（旧 Run 无法再发起模型请求）", slot2.controller.signal.aborted === true);

  // P8: 迟到结果不进入回复链
  replies.length = 0;
  const run3 = runner.run("u3", "迟到测试", "tok3");
  await tick();
  const st3 = slots.get("u3")!.st;
  timerBox.fn?.(); // 先超时
  await run3;
  const afterTimeout = replies.length;
  st3.resolver?.("迟到的答案"); // 旧 Run 迟到 resolve
  await tick();
  check(
    "P8 迟到结果不进入回复链（超时后 resolve 无新增回复）",
    replies.length === afterTimeout && !replies.some((r) => r.content === "迟到的答案"),
    JSON.stringify(replies)
  );

  // P9: 新 Run 使用新 controller（旧 abort 不影响新 Run）
  const run4 = runner.run("u2", "超时后的新问题", "tok4");
  await tick();
  check("P9 超时后新 Run 获得全新 Agent 与未中止的 controller", slots.has("u2") && slots.get("u2")!.slot.controller.signal.aborted === false);
  slots.get("u2")!.st.resolver?.("新答案");
  await run4;
  check("P10 新 Run 正常完成", replies.some((r) => r.content === "新答案" && r.finish === true));
}

// ---------------------------------------------------------------------------
// 场景 Q：确认词与话术卫生（§七 / §十一）
// ---------------------------------------------------------------------------

section("Q. 确认词与话术卫生");

{
  check("Q1 明确确认词识别（发送完毕/完毕/确认）", isConfirmText("发送完毕") && isConfirmText(" 完毕 ") && isConfirmText("确认") && !isConfirmText("还没说完") && !isConfirmText("确认一下还有补充"));
  check("Q2 确认提示话术与方案 §七一致", CONFIRM_PROMPT.includes("发送完毕") && CONFIRM_PROMPT.includes("请继续发送"));
  check("Q3 忙碌提示话术与方案 §八一致", BUSY_PROMPT.includes("正在处理中"));

  // §十一：不出现编造的联系信息
  const prompt = buildSystemPrompt(createMockSession());
  check("Q4 systemPrompt 无 8888 / IT 服务台", !prompt.includes("8888") && !prompt.includes("IT 服务台"), prompt.slice(0, 80));

  const dcsCtx = { session: createMockSession() };
  const perm = await checkDcsPermissionTool.execute({ menuName: "权限管理" }, dcsCtx);
  check("Q5 工具输出无 8888 / IT 服务台", !perm.output.includes("8888") && !perm.output.includes("IT 服务台"), perm.output);
  const permOk = await checkDcsPermissionTool.execute({ menuName: "报餐管理" }, dcsCtx);
  check("Q6 有权限输出格式正常", permOk.output.includes("拥有") && !permOk.isError);
}

console.log(`\n========== Channel 层测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
