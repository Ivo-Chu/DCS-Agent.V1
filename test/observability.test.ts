/**
 * observability 日志系统确定性测试（FakeStreamFn + Fake Tool，无真实模型/数据库）。
 *
 * 覆盖验收清单：
 * 1.  单轮模型直接回复（无工具）
 * 2.  一轮模型产生多个 Tool Call（turn 关联、step 连续）
 * 3.  Tool 正常成功
 * 4.  Tool 返回 0 行（empty，不算失败）
 * 5.  Tool 返回执行错误（ORA 错误码）
 * 6.  模型调用异常（model_error 结束原因）
 * 7.  达到最大模型轮次（max_turns）
 * 8.  多 Run 并发（runId 隔离，互不串日志）
 * 9.  Token Usage 有值（真实统计）
 * 10. Provider 未返回 Usage（记为"未提供"，不估算）
 * 11. Context 消息数量增长（messageCount / delta）
 * 12. 终端 NORMAL / DEBUG 输出差异
 * 13. JSONL 每行可独立解析 + 事件字段完整
 * 14. 日志写入失败不影响正常任务
 * 15. 敏感信息不明文输出（SQL 字面值 / 手机号 / 凭据）
 * 16. 结束统计与真实调用数量一致
 *
 * 运行：tsx test/observability.test.ts（已并入 npm run check）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Emitter } from "../src/core/events.ts";
import { createOpenAiStreamFn } from "../src/core/model/openai-compatible.ts";
import { Agent } from "../src/core/agent.ts";
import type {
  AgentMessage,
  ModelStreamEvent,
  StreamFn,
  ToolDefinition,
  ToolOutput,
} from "../src/core/types.ts";
import { attachRunObserver } from "../src/observability/observer.ts";
import { redactArgs, redactSql, redactText } from "../src/observability/redact.ts";

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

function section(title: string): void {
  console.log(`\n[场景] ${title}`);
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

interface TurnPlan {
  text?: string;
  toolCalls?: { name: string; arguments: string }[];
  stopReason?: "stop" | "toolCalls" | "error";
  errorMessage?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** Provider 原始 finish_reason（与归一化 stopReason 分开）。 */
  finishReason?: string;
}

function createFakeStreamFn(plans: TurnPlan[]): StreamFn {
  let call = 0;
  return async function* (): AsyncGenerator<ModelStreamEvent> {
    const plan = plans[call];
    call++;
    if (!plan) {
      yield { type: "message_end", stopReason: "error", errorMessage: "脚本轮次耗尽" };
      return;
    }
    if (plan.text) yield { type: "text_delta", text: plan.text };
    const tcs = plan.toolCalls ?? [];
    for (let i = 0; i < tcs.length; i++) {
      yield { type: "tool_call_start", index: i, toolCallId: `call_${call}_${i}`, name: tcs[i].name };
      yield { type: "tool_call_delta", index: i, argumentsDelta: tcs[i].arguments };
    }
    yield {
      type: "message_end",
      stopReason: plan.stopReason ?? (tcs.length > 0 ? "toolCalls" : "stop"),
      errorMessage: plan.errorMessage,
      usage: plan.usage,
      finishReason: plan.finishReason,
    };
  };
}

/** 脚本化数据库工具：按 SQL 内容返回剧本化结果（成功 / 0 行 / ORA 错误）。 */
function createFakeDbTool(): ToolDefinition<{ sql: string }, unknown> {
  return {
    name: "query_dcs_data",
    label: "DCS数据库查询",
    description: "假数据库工具",
    parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    async execute(args): Promise<ToolOutput> {
      const sql = args.sql;
      if (sql.includes("BAD_FIELD")) {
        return {
          output: '查询出错（可修正 SQL 后重试）：ORA-00904: "BAD_FIELD": invalid identifier',
          isError: true,
          details: { errorCode: "ORA-00904" },
        };
      }
      if (sql.includes("EMPTY_TABLE")) {
        return {
          output: "查询成功：返回 0 行。\nCODE | NAME",
          details: { rowCount: 0, columns: ["CODE", "NAME"], truncated: false, empty: true },
        };
      }
      return {
        output: "查询成功：返回 2 行。\nCODE | NAME\n10086 | 张三\n10087 | 李四",
        details: { rowCount: 2, columns: ["CODE", "NAME"], truncated: false, empty: false },
      };
    },
  };
}

interface RunCapture {
  consoleText: string;
  logsDir: string;
}

/** 运行一次 Agent.prompt 并捕获终端输出与 JSONL 文件。 */
async function runAndCapture(
  agent: Agent<unknown>,
  prompt: string,
  opts: { level?: "normal" | "debug" } = {}
): Promise<RunCapture & { reply: string }> {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-obs-"));
  let consoleText = "";
  const observer = attachRunObserver(agent, {
    channel: "CLI",
    level: opts.level ?? "normal",
    logsDir,
    write: (t) => {
      consoleText += t + "\n";
    },
  });
  const reply = await agent.prompt(prompt);
  // 等待 observer flush 完成（不依赖固定睡眠猜测落盘时间）
  await observer.end("detached").catch(() => undefined);
  return { consoleText, logsDir, reply };
}

function readJsonl(logsDir: string): { fileName: string; records: Record<string, unknown>[] } {
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length !== 1) throw new Error(`预期 1 个 JSONL 文件，实际 ${files.length}：${files.join(",")}`);
  const content = fs.readFileSync(path.join(logsDir, files[0]), "utf8").trim();
  const records = content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { fileName: files[0], records };
}

const makeAgent = (
  plans: TurnPlan[],
  tools: ToolDefinition<any, unknown>[] = [],
  maxTurns = 8
): Agent<unknown> =>
  new Agent<unknown>({
    systemPrompt: "测试 systemPrompt",
    tools,
    streamFn: createFakeStreamFn(plans),
    toolContext: {},
    maxTurns,
  });

// ---------------------------------------------------------------------------
// 场景 O1：单轮直接回复（无工具）+ Usage 有值 + JSONL 可解析
// ---------------------------------------------------------------------------

section("O1. 单轮模型直接回复（无工具，Token Usage 有值）");

{
  const agent = makeAgent([
    { text: "你好，我是 DCS 助手。", usage: { inputTokens: 6200, outputTokens: 186 } },
  ]);
  const { consoleText, logsDir, reply } = await runAndCapture(agent, "你好");

  check("O1-1 最终回复正确", reply.includes("DCS 助手"));
  check("O1-2 终端显示 Run 开始（通道/Run ID/模型/Provider 标识）",
    consoleText.includes("DCS Agent 开始执行") && consoleText.includes("CLI") &&
    consoleText.includes("模型：未知") && !consoleText.includes("openai-compatible"),
    consoleText.slice(0, 300));
  check("O1-3 终端显示第 1 轮模型调用与 Token",
    consoleText.includes("第 1 轮") && consoleText.includes("6,200") && consoleText.includes("186"));
  check("O1-4 终端显示统计摘要（模型 1 次 / 工具 0 次）",
    consoleText.includes("模型调用：1 次") && consoleText.includes("工具调用：0 次"));
  check("O1-5 状态成功 / 原因正常完成",
    consoleText.includes("状态：成功") || (consoleText.includes("正常完成")));

  const { fileName, records } = readJsonl(logsDir);
  check("O1-6 JSONL 文件名含 runId 且格式安全", /^[\d-]+_[\d-]+_[a-zA-Z0-9_-]+\.jsonl$/.test(fileName), fileName);
  check("O1-7 JSONL 每行可独立解析且含 timestamp/runId/event",
    records.every((r) => typeof r.timestamp === "string" && typeof r.runId === "string" && typeof r.event === "string"));
  check("O1-8 JSONL 事件序列完整（run_start→model_call_start→model_call_end→run_end）",
    records.map((r) => r.event).join(",") === "run_start,model_call_start,model_call_end,run_end",
    records.map((r) => r.event).join(","));
  const mce = records.find((r) => r.event === "model_call_end");
  check("O1-9 model_call_end 记录真实 Token 用量",
    mce?.inputTokens === 6200 && mce?.outputTokens === 186, JSON.stringify(mce));
  const mcStart = records.find((r) => r.event === "model_call_start");
  check("O1-10 model_call_start 记录上下文消息数（1 条 user 消息）",
    mcStart?.messageCount === 1 && mcStart?.messageCountDelta === 1, JSON.stringify(mcStart));
}

// ---------------------------------------------------------------------------
// 场景 O2：一轮多 Tool Call + 0 行空结果 + Usage 未提供
// ---------------------------------------------------------------------------

section("O2. 一轮模型产生多个 Tool Call + 0 行空结果 + Usage 未提供");

{
  const dbTool = createFakeDbTool();
  const agent = makeAgent([
    {
      toolCalls: [
        { name: "query_dcs_data", arguments: '{"sql":"SELECT CODE, NAME FROM S2_Employee"}' },
        { name: "query_dcs_data", arguments: '{"sql":"SELECT CODE FROM EMPTY_TABLE"}' },
      ],
      // 故意不提供 usage（模拟 Provider 未返回）
    },
    { text: "查询完成：员工 2 行，空表 0 行。" },
  ], [dbTool]);
  const { consoleText, logsDir } = await runAndCapture(agent, "查员工");

  check("O2-1 终端显示 2 个工具调用且编号连续（[01]/[02]）",
    consoleText.includes("[01]") && consoleText.includes("[02]"));
  check("O2-2 0 行结果标记为空结果而非失败",
    consoleText.includes("空结果") && !consoleText.includes("✗ 执行失败"));
  check("O2-3 统计：模型 2 次 / 工具 2 次（成功 2 / 失败 0）/ 空结果 1",
    consoleText.includes("模型调用：2 次") &&
    consoleText.includes("工具调用：2 次（成功 2 / 失败 0）") &&
    consoleText.includes("空结果：1 次"),
    consoleText.slice(-600));
  check("O2-4 Usage 未提供时显示「未提供」而非 0",
    consoleText.includes("未提供") && !consoleText.includes("输入 Token：0"));
  // 字段列表为 DEBUG 专属展示，NORMAL 不出现（覆盖 formatter 分支）
  check("O2-10 NORMAL 不显示字段列表（DEBUG 专属）", !consoleText.includes("字段："));

  const { records } = readJsonl(logsDir);
  const toolEnds = records.filter((r) => r.event === "tool_end");
  check("O2-5 两个 tool_end 同属 turn 1、step 连续 1/2",
    toolEnds.length === 2 && toolEnds[0].turn === 1 && toolEnds[1].turn === 1 &&
    toolEnds[0].step === 1 && toolEnds[1].step === 2,
    JSON.stringify(toolEnds.map((t) => [t.turn, t.step])));
  check("O2-6 0 行工具记录 empty=true、isError=false、rowCount=0",
    toolEnds[1].empty === true && toolEnds[1].isError === false && toolEnds[1].rowCount === 0,
    JSON.stringify(toolEnds[1]));
  const mce = records.filter((r) => r.event === "model_call_end");
  check("O2-7 未提供 Usage 时 inputTokens 为 null（不估算冒充）",
    mce.every((r) => r.inputTokens === null), JSON.stringify(mce));
  const runEnd = records.find((r) => r.event === "run_end");
  check("O2-8 run_end 统计与真实调用一致（modelCalls=2, toolCalls=2）",
    runEnd?.modelCalls === 2 && runEnd?.toolCalls === 2, JSON.stringify(runEnd));
  // Context 增长：第 2 轮消息 = 1 user + 1 assistant + 2 toolResult = 4（+3）
  const starts = records.filter((r) => r.event === "model_call_start");
  check("O2-9 上下文消息数量增长记录（第 2 轮 4 条 +3）",
    starts[1]?.messageCount === 4 && starts[1]?.messageCountDelta === 3,
    JSON.stringify(starts));
}

// ---------------------------------------------------------------------------
// 场景 O3：Tool 执行错误（ORA-00904）+ DEBUG 模式差异
// ---------------------------------------------------------------------------

section("O3. Tool 执行错误（ORA 错误码）+ NORMAL/DEBUG 差异");

{
  const plans: TurnPlan[] = [
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT BAD_FIELD FROM S2_R_ROOM"}' }] },
    { text: "字段不存在，请检查。" },
  ];
  const dbTool = createFakeDbTool();

  const normalAgent = makeAgent(plans, [dbTool]);
  const normal = await runAndCapture(normalAgent, "查宿舍");
  check("O3-1 NORMAL 显示失败状态与错误码",
    normal.consoleText.includes("✗ 执行失败") && normal.consoleText.includes("ORA-00904"));
  check("O3-2 NORMAL 显示失败结果摘要（发给模型的错误信息）",
    normal.consoleText.includes("invalid identifier"));
  check("O3-3 NORMAL 不显示 DEBUG 专属字段（toolCallId 详情）",
    !normal.consoleText.includes("toolCallId："));

  const debugAgent = makeAgent(plans, [dbTool]);
  const debug = await runAndCapture(debugAgent, "查宿舍", { level: "debug" });
  check("O3-4 DEBUG 显示 toolCallId 与轮次详情",
    debug.consoleText.includes("toolCallId：call_1_0（第 1 轮）"), debug.consoleText.slice(0, 800));
  check("O3-5 DEBUG 显示停止原因",
    debug.consoleText.includes("停止原因：toolCalls") || debug.consoleText.includes("停止原因：stop"));
  // 失败路径无 columns，字段列表不应出现（O2-10 的镜像断言；成功路径在 O3-6b 覆盖）
  check("O3-6 DEBUG 失败路径无字段列表", !debug.consoleText.includes("字段："));
  const okPlans: TurnPlan[] = [
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE, NAME FROM S2_Employee"}' }] },
    { text: "查到 2 行。" },
  ];
  const okDebug = await runAndCapture(makeAgent(okPlans, [createFakeDbTool()]), "查员工", { level: "debug" });
  check("O3-6b DEBUG 成功路径显示字段列表",
    okDebug.consoleText.includes("字段：CODE, NAME"), okDebug.consoleText.slice(0, 900));
  const { records } = readJsonl(debug.logsDir);
  const toolEnd = records.find((r) => r.event === "tool_end");
  check("O3-7 JSONL 记录 ORA 错误码与失败标记",
    toolEnd?.errorCode === "ORA-00904" && toolEnd?.isError === true, JSON.stringify(toolEnd));
}

// ---------------------------------------------------------------------------
// 场景 O4：模型调用异常 + 最大轮次
// ---------------------------------------------------------------------------

section("O4. 模型调用异常 / 达到最大模型轮次");

{
  const errAgent = makeAgent([
    { stopReason: "error", errorMessage: "模型调用失败（HTTP 500）：内部错误" },
  ]);
  const { consoleText, logsDir } = await runAndCapture(errAgent, "测试");
  check("O4-1 模型失败终端显示错误",
    consoleText.includes("✗ 模型调用失败") && consoleText.includes("HTTP 500"));
  check("O4-2 模型失败统计：状态失败 / 原因模型接口失败",
    consoleText.includes("状态：失败") && consoleText.includes("模型接口失败"));
  const { records } = readJsonl(logsDir);
  const runEnd = records.find((r) => r.event === "run_end");
  check("O4-3 JSONL run_end reason=model_error, status=failed",
    runEnd?.reason === "model_error" && runEnd?.status === "failed", JSON.stringify(runEnd));
}

{
  // maxTurns=2，模型每轮都发起工具调用 → 轮次耗尽
  const dbTool = createFakeDbTool();
  const agent = makeAgent(
    [
      { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
      { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 2 FROM DUAL"}' }] },
    ],
    [dbTool],
    2
  );
  const { consoleText, logsDir } = await runAndCapture(agent, "测试");
  check("O4-4 maxTurns 耗尽：状态失败 / 原因达到最大执行轮次",
    consoleText.includes("达到最大执行轮次"));
  const { records } = readJsonl(logsDir);
  const runEnd = records.find((r) => r.event === "run_end");
  check("O4-5 JSONL run_end reason=max_turns（modelCalls=2, toolCalls=2）",
    runEnd?.reason === "max_turns" && runEnd?.modelCalls === 2 && runEnd?.toolCalls === 2,
    JSON.stringify(runEnd));
}

// ---------------------------------------------------------------------------
// 场景 O5：多 Run 并发隔离
// ---------------------------------------------------------------------------

section("O5. 多 Run 并发（runId 隔离，互不串日志）");

{
  const mkAgent = (tag: string): Agent<unknown> =>
    makeAgent([{ text: `回复-${tag}`, usage: { inputTokens: 100, outputTokens: 10 } }]);
  const agentA = mkAgent("A");
  const agentB = mkAgent("B");
  const [capA, capB] = await Promise.all([
    runAndCapture(agentA, "问题A"),
    runAndCapture(agentB, "问题B"),
  ]);
  const a = readJsonl(capA.logsDir);
  const b = readJsonl(capB.logsDir);
  check("O5-1 两个 Run 各自生成独立 JSONL 文件（runId 不同）",
    a.fileName !== b.fileName && a.records[0].runId !== b.records[0].runId,
    `${a.fileName} vs ${b.fileName}`);
  check("O5-2 文件内所有记录 runId 一致（不串日志）",
    a.records.every((r) => r.runId === a.records[0].runId) &&
    b.records.every((r) => r.runId === b.records[0].runId));
}

// ---------------------------------------------------------------------------
// 场景 O6：敏感数据保护
// ---------------------------------------------------------------------------

section("O6. 开发者日志边界（业务明细可入日志；凭据脱敏；DEBUG 详细）");

{
  // 纯函数层：凭据脱敏保留，业务数据/字面值/双引号字段名不再遮蔽
  const sql = redactSql(`SELECT "ROOMNAME" FROM S2_R_ROOM WHERE Code = '10086' AND Name = '张三'`);
  check("O6-1 SQL 双引号字段标识符与业务字面值保留（开发者排障需要）",
    sql.includes('"ROOMNAME"') && sql.includes("'10086'") && sql.includes("'张三'"),
    sql);
  check("O6-2 文本凭据赋值形态脱敏（Password=***）",
    redactText("Password=SuperSecret123;").includes("Password=***") &&
    !redactText("Password=SuperSecret123;").includes("SuperSecret123"));
  check("O6-3 SQL 中连接凭据脱敏（password 字段值 → ***）",
    redactSql("CONNECT user/password=TopSecret99@db").includes("password=***") &&
    !redactSql("CONNECT user/password=TopSecret99@db").includes("TopSecret99"));
  // 结构化凭据：字段名识别（F1 核心）
  const structArgs = redactArgs("any_tool", {
    password: "SYNTH_PASSWORD",
    token: "SYNTH_TOKEN",
    config: { apiKey: "SYNTH_APIKEY", nested: { accessToken: "SYNTH_ACCTOKEN" } },
    list: [{ secret: "SYNTH_SECRET" }],
    code: "10086",
    name: "张三",
    usage: { inputTokens: 6200, cacheWriteTokens: 7 },
  });
  check("O6-4 结构化凭据按字段名脱敏（password/token/apiKey/accessToken/secret）",
    !structArgs.includes("SYNTH_PASSWORD") && !structArgs.includes("SYNTH_TOKEN") &&
    !structArgs.includes("SYNTH_APIKEY") && !structArgs.includes("SYNTH_ACCTOKEN") &&
    !structArgs.includes("SYNTH_SECRET"),
    structArgs);
  check("O6-5 员工业务数据与 Token 用量字段不误脱敏",
    structArgs.includes("10086") && structArgs.includes("张三") &&
    structArgs.includes("6200") && structArgs.includes('"cacheWriteTokens":7'),
    structArgs);

  // 端到端：员工业务明细与双引号字段名进入开发者日志（允许）
  const dbTool = createFakeDbTool();
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT \\"ROOMNAME\\", NAME FROM S2_R_ROOM WHERE CODE = \'10086\' AND NAME = \'张三\'"}' }] },
    { text: "查到员工信息。" },
  ], [dbTool]);
  const { consoleText, logsDir } = await runAndCapture(agent, "查我自己", { level: "debug" });
  const jsonlRaw = fs.readFileSync(
    path.join(logsDir, fs.readdirSync(logsDir)[0]),
    "utf8"
  );
  check("O6-6 DEBUG 终端保留完整 SQL：双引号字段名与业务字面值可见",
    consoleText.includes('"ROOMNAME"') && consoleText.includes("'10086'") && consoleText.includes("'张三'"),
    consoleText.slice(0, 600));
  // JSONL 是转义后的 JSON 文本，须解析记录再判断（\"ROOMNAME\" 在原始文本中是转义的）
  const o6Records = readJsonl(logsDir).records;
  const o6ToolEnd = o6Records.find((r) => r.event === "tool_end");
  const o6ToolStart = o6Records.find((r) => r.event === "tool_start");
  check("O6-7 JSONL 保留业务明细（员工工号/姓名/字段名可复盘）",
    typeof o6ToolEnd?.resultText === "string" &&
    (o6ToolEnd.resultText as string).includes("10086") &&
    (o6ToolEnd.resultText as string).includes("张三") &&
    typeof o6ToolStart?.args === "string" &&
    (o6ToolStart.args as string).includes("ROOMNAME"));
  // 排障所需源码路径允许进入开发者日志
  check("O6-8 排障所需源码路径允许进入开发者日志（路径保护仅针对对话输出）",
    redactText("命中 D:\\code\\Luxshare.DCS.WebApi\\A.cs").includes("Luxshare"));
}

// ---------------------------------------------------------------------------
// 场景 O7：日志写入失败不影响正常任务 + 重复调用统计
// ---------------------------------------------------------------------------

section("O7. JSONL 写入失败不影响任务 + 重复工具调用统计");

{
  const agent = makeAgent([{ text: "正常回复。" }]);
  // logsDir 指向一个已存在的【文件】→ mkdir/appendFile 必然失败
  const blockerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dcs-obs-block-")), "not-a-dir");
  fs.writeFileSync(blockerFile, "x");
  const reply = await agent.prompt("测试");
  // observer 未挂载时无日志；再验证挂载后写入失败不炸
  const obs = attachRunObserver(agent, {
    channel: "CLI",
    logsDir: blockerFile,
    write: () => undefined,
  });
  let threw = false;
  let reply2 = "";
  try {
    reply2 = await agent.prompt("再来一次");
  } catch {
    threw = true;
  }
  await obs.end("detached").catch(() => undefined);
  check("O7-1 日志目录不可写时任务不受影响（不抛异常，正常回复）",
    !threw && reply.length > 0 && reply2.length > 0, `reply2=${reply2.slice(0, 40)}`);
}

{
  const dbTool = createFakeDbTool();
  const sameSql = '{"sql":"SELECT CODE, NAME FROM S2_Employee"}';
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: sameSql }] },
    { toolCalls: [{ name: "query_dcs_data", arguments: sameSql }] },
    { text: "两次相同查询完成。" },
  ], [dbTool]);
  const { consoleText } = await runAndCapture(agent, "重复查询");
  check("O7-2 重复工具调用被统计（重复调用：1 次）",
    consoleText.includes("重复调用：1 次"), consoleText.slice(-500));
}

// ---------------------------------------------------------------------------
// 场景 O8：重复调用指纹（F4）——SQL 字面值不同不误报；键序不同识别为重复
// ---------------------------------------------------------------------------

section("O8. 重复调用指纹（SQL 字面值不同 ≠ 重复；键序不同 = 重复）");

{
  const dbTool = createFakeDbTool();
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE FROM S2_Employee WHERE NAME = \'A\'"}' }] },
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE FROM S2_Employee WHERE NAME = \'B\'"}' }] },
    { text: "两次不同查询完成。" },
  ], [dbTool]);
  const { consoleText } = await runAndCapture(agent, "不同查询");
  check("O8-1 仅 SQL 字面值不同的调用不误报重复",
    !consoleText.includes("重复调用"), consoleText.slice(-500));
}

{
  const echoTool: ToolDefinition<Record<string, unknown>, unknown> = {
    name: "search_dcs_knowledge",
    label: "知识库检索",
    description: "回显参数的假检索工具",
    parameters: { type: "object" },
    async execute(): Promise<ToolOutput> {
      return { output: "检索完成：3 个片段", details: { chunkCount: 3 } };
    },
  };
  const agent = makeAgent([
    { toolCalls: [{ name: "search_dcs_knowledge", arguments: '{"query":"宿舍","limit":5,"offset":0}' }] },
    { toolCalls: [{ name: "search_dcs_knowledge", arguments: '{"offset":0,"limit":5,"query":"宿舍"}' }] },
    { text: "两次相同参数（键序不同）调用完成。" },
  ], [echoTool]);
  const { consoleText } = await runAndCapture(agent, "检索");
  check("O8-2 对象键顺序不同但值相同识别为同一次参数组合（重复 1 次）",
    consoleText.includes("重复调用：1 次"), consoleText.slice(-500));
}

// ---------------------------------------------------------------------------
// 场景 O9：Usage 汇总（F5）——部分缺失标未知；缓存读写分开；真实 0 区分
// ---------------------------------------------------------------------------

section("O9. Usage 汇总（部分缺失标未知 / 缓存读写分开 / 真实 0）");

{
  // 部分缺失：第一轮（带工具调用，保证循环继续）有 usage，第二轮没有
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE, NAME FROM S2_Employee"}' }], usage: { inputTokens: 100, outputTokens: 5, cacheWriteTokens: 7 } },
    { text: "最终回复。" },
  ], [createFakeDbTool()]);
  const { consoleText, logsDir } = await runAndCapture(agent, "测试");
  check("O9-1 部分缺失时总量标未知并显示已知小计与覆盖轮数",
    consoleText.includes("未知") && consoleText.includes("已知小计 100") && consoleText.includes("1/2 轮"),
    consoleText.slice(-600));
  check("O9-2 缓存写入统计单独展示（不与输入重复相加）",
    consoleText.includes("缓存 Token（写入）：未知（已知小计 7，覆盖 1/2 轮）"), consoleText.slice(-600));
  const { records } = readJsonl(logsDir);
  const runEnd = records.find((r) => r.event === "run_end");
  check("O9-3 JSONL run_end 总量为 null + coverage 记录小计与轮数",
    runEnd?.totalInputTokens === null &&
    (runEnd?.inputCoverage as { known?: number; turns?: number; of?: number } | null)?.known === 100 &&
    (runEnd?.inputCoverage as { turns?: number } | null)?.turns === 1,
    JSON.stringify(runEnd));
  check("O9-4 JSONL 缓存写入已知小计为 7，缺失轮次不计为零",
    runEnd?.cacheWriteTokens === null && (runEnd?.cacheWriteCoverage as { known: number })?.known === 7, JSON.stringify(runEnd));
}

{
  // 全部轮次有 usage（含真实 0）：总量完整
  const agent = makeAgent([
    { text: "回复。", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
  ]);
  const { consoleText } = await runAndCapture(agent, "测试");
  check("O9-5 真实 0 与未提供区分（0 显示为 0，不是未提供）",
    consoleText.includes("总输入 Token：0") && consoleText.includes("总输出 Token：0") &&
    consoleText.includes("缓存 Token（读取）：0"),
    consoleText.slice(-500));
}

{
  // 全部有值：完整总量（首轮带工具调用，保证循环继续到第二轮）
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE, NAME FROM S2_Employee"}' }], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
    { text: "b", usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 } },
  ], [createFakeDbTool()]);
  const { consoleText } = await runAndCapture(agent, "测试");
  check("O9-6 全部有值时完整总量（300/30），缓存读取 200",
    consoleText.includes("总输入 Token：300") && consoleText.includes("总输出 Token：30") &&
    consoleText.includes("缓存 Token（读取）：200"),
    consoleText.slice(-500));
}

// ---------------------------------------------------------------------------
// 场景 O10：ToolResult 三层（F6）——hook 前后差异可复盘；超过 120 字可查
// ---------------------------------------------------------------------------

section("O10. ToolResult 三层（hook 前后差异 / 尾部诊断信息）");

{
  const longTail = "X".repeat(50) + "TAIL_MARKER_DIAGNOSTIC";
  const rawTool: ToolDefinition<Record<string, unknown>, unknown> = {
    name: "query_dcs_data",
    label: "数据库查询",
    description: "返回带尾部诊断的假工具",
    parameters: { type: "object" },
    async execute(): Promise<ToolOutput> {
      return { output: `查询成功：返回 1 行。\n${"A".repeat(200)}\n${longTail}`, details: { rowCount: 1, ...{ databaseQueries: [{ sql: "SELECT :actor FROM DUAL", binds: { actor: "10086", token: "NEVER_LOG_TRACE_TOKEN" }, durationMs: 4 }] } } };
    },
  };
  const agent = new Agent<unknown>({
    systemPrompt: "测试",
    tools: [rawTool],
    streamFn: createFakeStreamFn([
      { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
      { text: "完成。" },
    ]),
    toolContext: {},
    hooks: {
      afterToolCall: (_name, _args, text) => `[hook已处理] ${text}`,
    },
    maxTurns: 8,
  });
  const { consoleText, logsDir } = await runAndCapture(agent, "测试", { level: "debug" });
  const jsonlRaw = fs.readFileSync(
    path.join(logsDir, fs.readdirSync(logsDir)[0]),
    "utf8"
  );
  check("O10-1 超过 120 字的尾部诊断信息在 DEBUG/JSONL 可查",
    consoleText.includes("TAIL_MARKER_DIAGNOSTIC") && jsonlRaw.includes("TAIL_MARKER_DIAGNOSTIC"),
    consoleText.slice(0, 400));
  check("O10-2 hook 处理后的结果与原始结果均可复盘（[hook已处理] 前缀可见）",
    consoleText.includes("[hook已处理]") && jsonlRaw.includes("[hook已处理]"));
  const { records } = readJsonl(logsDir);
  const toolEnd = records.find((r) => r.event === "tool_end");
  check("O10-3 JSONL 记录处理前后差异（resultChanged=true，rawResult 不带 hook 前缀）",
    toolEnd?.resultChanged === true &&
    typeof toolEnd?.rawResult === "string" && !(toolEnd.rawResult as string).includes("[hook已处理]"),
    JSON.stringify(toolEnd?.resultChanged));
  check("O10-6 参数化SQL日志保留员工绑定但遮蔽凭据", jsonlRaw.includes("SELECT :actor FROM DUAL") && jsonlRaw.includes("10086") && !jsonlRaw.includes("NEVER_LOG_TRACE_TOKEN"));
  // 相同场景：无 hook 时 resultChanged=false
  const agent2 = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT 1 FROM DUAL"}' }] },
    { text: "完成。" },
  ], [rawTool]);
  const cap2 = await runAndCapture(agent2, "测试2", { level: "debug" });
  const { records: records2 } = readJsonl(cap2.logsDir);
  const toolEnd2 = records2.find((r) => r.event === "tool_end");
  check("O10-4 处理前后相同时标注一致不重复保存（resultChanged=false, rawResult=null）",
    toolEnd2?.resultChanged === false && toolEnd2?.rawResult === null,
    JSON.stringify(toolEnd2?.resultChanged));
  check("O10-5 chunkCount/hitLimitReached 等已取得的 details 写入 JSONL",
    records.some((r) => r.event === "tool_end" && "chunkCount" in r && "hitLimitReached" in r));
}

// ---------------------------------------------------------------------------
// 场景 O11：模型观测元数据（F8）——原始 finishReason / 模型与 Provider 标识
// ---------------------------------------------------------------------------

section("O11. 模型观测（原始 finish_reason / 实际模型与 Provider 标识）");

{
  const agent = makeAgent([
    { text: "回复。", stopReason: "stop", finishReason: "content_filter" },
  ]);
  const { consoleText, logsDir } = await runAndCapture(agent, "测试", { level: "debug" });
  check("O11-1 DEBUG 显示 Provider 原始停止原因（与归一化 stopReason 分开）",
    consoleText.includes("Provider 原始停止原因：content_filter") && consoleText.includes("停止原因：stop"),
    consoleText.slice(0, 800));
  const { records } = readJsonl(logsDir);
  const mce = records.find((r) => r.event === "model_call_end");
  check("O11-2 JSONL model_call_end 同时记录 stopReason 与原始 finishReason",
    mce?.stopReason === "stop" && mce?.finishReason === "content_filter", JSON.stringify(mce));
  const runStart = records.find((r) => r.event === "run_start");
  check("O11-3 自定义 Fake Provider 未提供元数据时标记未知",
    typeof runStart?.model === "string" && (runStart.model as string).length > 0 &&
    runStart?.model === "未知" && runStart?.provider === null,
    JSON.stringify(runStart));
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------


section("O12. 凭据分支、未完成调用及真实 Provider 元数据回归");
{
  const nested = { credentials: { password: "SYNTH_NESTED" }, token: ["SYNTH_ARRAY"], password: 123456, inputTokens: 10 };
  const safe = redactArgs("test", nested);
  check("O12-1 凭据容器和数字密码遮蔽，原对象及用量不变",
    !safe.includes("SYNTH_") && !safe.includes("123456") && safe.includes('"inputTokens":10') && nested.credentials.password === "SYNTH_NESTED");
  check("O12-2 常见文本令牌和带空格的密码完整遮蔽",
    !redactText('token=SYNTH_TOKEN access_token=SYNTH_ACCESS Authorization: Bearer SYNTH_AUTH password="SYNTH WITH SPACE"').includes("SYNTH"));
  for (const level of ["normal", "debug"] as const) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-credential-"));
    const emitter = new Emitter();
    let output = "";
    const observer = attachRunObserver(emitter, { channel: "test", level, logsDir, write: t => { output += t; } });
    const runId = `credential-${level}`;
    emitter.emit({ type: "run_start", runId, startedAt: new Date().toISOString() });
    emitter.emit({ type: "tool_execution_start", runId, turn: 1, step: 1, toolCallId: "c", toolName: "exec_command", args: { query: "password=SYNTH_QUERY", ...nested } });
    emitter.emit({ type: "tool_execution_end", runId, turn: 1, step: 1, toolCallId: "c", toolName: "exec_command", durationMs: 1, isError: true, summary: "token=SYNTH_RESULT", contextText: "Authorization: Bearer SYNTH_RESULT", rawText: 'password="SYNTH RAW"' });
    await observer.end("detached");
    check(`O12-3 ${level} 终端和 JSONL 所有已测输出分支均无凭据`,
      !output.includes("SYNTH") && !JSON.stringify(readJsonl(logsDir).records).includes("SYNTH"));
  }
}
{
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-inflight-"));
  const emitter = new Emitter();
  let output = "";
  const observer = attachRunObserver(emitter, { channel: "test", logsDir, write: t => { output += t; } });
  const runId = "inflight";
  emitter.emit({ type: "run_start", runId, startedAt: new Date(Date.now() - 1000).toISOString() });
  const start = (turn: number): void => emitter.emit({ type: "model_call_start", runId, turn, messageCount: 1, messageCountDelta: 1, hasSystemPrompt: false, toolSchemaCount: 1 });
  start(1);
  emitter.emit({ type: "model_call_end", runId, turn: 1, durationMs: 10, stopReason: "toolCalls", toolCallCount: 1, usage: { inputTokens: 100, cacheReadTokens: 8, cacheWriteTokens: 2 } });
  emitter.emit({ type: "tool_execution_start", runId, turn: 1, step: 1, toolCallId: "p", toolName: "pending", args: {} });
  // First assert a tool-in-flight timeout, then a separate model-in-flight case below.
  await observer.end("timeout");
  await observer.end("disconnected");
  const { records } = readJsonl(logsDir);
  const end = records.find(r => r.event === "run_end")!;
  check("O12-4 未完成工具计入调用数，结束幂等且耗时真实",
    end.toolCalls === 1 && end.successfulToolCalls === 0 && end.failedToolCalls === 0 && Number(end.elapsedMs) >= 1000 && records.filter(r => r.event === "run_end").length === 1);
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-model-inflight-"));
  const e2 = new Emitter();
  const o2 = attachRunObserver(e2, { channel: "test", logsDir: modelDir, write: null });
  e2.emit({ type: "run_start", runId, startedAt: new Date().toISOString() });
  for (const turn of [1, 2]) {
    e2.emit({ type: "model_call_start", runId, turn, messageCount: 1, messageCountDelta: 1, hasSystemPrompt: false, toolSchemaCount: 0 });
    if (turn === 1) e2.emit({ type: "model_call_end", runId, turn, durationMs: 1, stopReason: "toolCalls", toolCallCount: 0, usage: { inputTokens: 100, cacheReadTokens: 8, cacheWriteTokens: 2 } });
  }
  await o2.end("timeout");
  const modelEnd = readJsonl(modelDir).records.find(r => r.event === "run_end")!;
  check("O12-5 未完成模型计入总数和 Usage 分母，缓存同样标明缺失",
    modelEnd.modelCalls === 2 && modelEnd.totalInputTokens === null && modelEnd.cacheReadTokens === null && modelEnd.cacheWriteTokens === null &&
    (modelEnd.inputCoverage as { of: number }).of === 2 && (modelEnd.cacheReadCoverage as { known: number }).known === 8);
}
{
  const oldFetch = globalThis.fetch;
  const oldModel = process.env.LLM_MODEL;
  let requested = "";
  try {
    const streamFn = createOpenAiStreamFn({ apiKey: "synthetic", baseUrl: "http://synthetic.invalid", model: "ActualModel" });
    process.env.LLM_MODEL = "DifferentEnvironmentModel";
    globalThis.fetch = async (_url, init) => {
      requested = JSON.parse(String(init?.body)).model;
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n');
    };
    const agent = new Agent({ systemPrompt: "", tools: [], toolContext: {}, streamFn });
    const cap = await runAndCapture(agent, "test", { level: "debug" });
    const records = readJsonl(cap.logsDir).records;
    check("O12-6 日志模型匹配实际请求，不受随后环境变更影响",
      requested === "ActualModel" && records[0].model === requested && records[0].provider === "openai-compatible");
    check("O12-7 真实 Adapter 原始停止原因透传",
      records.some(r => r.event === "model_call_end" && r.finishReason === "content_filter" && r.stopReason === "stop"));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = oldModel;
  }
}

// ---------------------------------------------------------------------------
// 场景 O13：每轮上下文内容可观测（model_call_start 快照）
// ---------------------------------------------------------------------------

section("O13. 每轮模型调用的上下文内容（System Prompt + 消息快照）");

{
  const dbTool = createFakeDbTool();
  const agent = makeAgent([
    { toolCalls: [{ name: "query_dcs_data", arguments: '{"sql":"SELECT CODE, NAME FROM S2_Employee WHERE CODE = \'10086\'"}' }] },
    { text: "查到了：张三。" },
  ], [dbTool]);
  const { consoleText, logsDir } = await runAndCapture(agent, "查 10086", { level: "debug" });

  // DEBUG 终端可见上下文区块与消息内容
  check("O13-1 DEBUG 终端显示本轮上下文区块",
    consoleText.includes("本轮上下文") && consoleText.includes("[system]") && consoleText.includes("查 10086"),
    consoleText.slice(0, 500));
  check("O13-2 DEBUG 终端第 2 轮可见工具结果消息（toolResult）",
    consoleText.includes("toolResult(query_dcs_data)") && consoleText.includes("10086 | 张三"),
    consoleText.slice(-1500));

  const { records } = readJsonl(logsDir);
  const starts = records.filter((r) => r.event === "model_call_start");
  check("O13-3 JSONL 记录 System Prompt 文本",
    typeof starts[0]?.systemPromptText === "string" && (starts[0].systemPromptText as string).includes("测试 systemPrompt"),
    JSON.stringify(starts[0]?.systemPromptText));
  const ctx1 = starts[0]?.contextMessages as { role: string; content: string }[];
  check("O13-4 第 1 轮上下文快照 = 1 条 user 消息（本轮 prompt）",
    Array.isArray(ctx1) && ctx1.length === 1 && ctx1[0].role === "user" && ctx1[0].content === "查 10086",
    JSON.stringify(ctx1));
  const ctx2 = starts[1]?.contextMessages as { role: string; content: string; toolName?: string }[];
  check("O13-5 第 2 轮上下文快照含 assistant + toolResult（3 条，工具结果在上下文中）",
    Array.isArray(ctx2) && ctx2.length === 3 &&
    ctx2[1].role === "assistant" && ctx2[2].role === "toolResult" &&
    ctx2[2].toolName === "query_dcs_data" && ctx2[2].content.includes("10086 | 张三"),
    JSON.stringify(ctx2?.map((m) => m.role)));
  check("O13-6 上下文快照保留员工业务数据（工号/姓名不遮蔽）",
    JSON.stringify(ctx2).includes("10086") && JSON.stringify(ctx2).includes("张三"));

  // NORMAL 终端不展示上下文详情
  const normalAgent = makeAgent([{ text: "你好。" }]);
  const normal = await runAndCapture(normalAgent, "你好");
  check("O13-7 NORMAL 终端不展示上下文内容（DEBUG 专属）",
    !normal.consoleText.includes("本轮上下文"));
  // NORMAL 下 JSONL 仍记录上下文（终端级别不影响落盘）
  const normalRecords = readJsonl(normal.logsDir).records;
  const normalStart = normalRecords.find((r) => r.event === "model_call_start");
  check("O13-8 NORMAL 下 JSONL 仍记录上下文快照",
    Array.isArray(normalStart?.contextMessages) && (normalStart.contextMessages as unknown[]).length === 1);
}

{
  // 快照隔离：发射后运行时继续 push 的消息不出现在已发射快照中
  const emitter = new Emitter();
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-ctx-snap-"));
  const observer = attachRunObserver(emitter, { channel: "test", logsDir, write: null });
  const runId = "ctx-snapshot-run";
  emitter.emit({ type: "run_start", runId, startedAt: new Date().toISOString() });
  const messages = [{ role: "user" as const, content: "第一条" }];
  emitter.emit({
    type: "model_call_start", runId, turn: 1,
    messageCount: 1, messageCountDelta: 1, hasSystemPrompt: false, toolSchemaCount: 0,
    contextMessages: messages,
  });
  messages.push({ role: "user" as const, content: "发射后追加" });
  emitter.emit({ type: "run_end", runId, status: "completed", reason: "completed", elapsedMs: 1, modelCalls: 1, toolCalls: 0 });
  await observer.end("detached");
  const rec = readJsonl(logsDir).records.find((r) => r.event === "model_call_start");
  // 注：observer 消费时同步脱敏——发射时数组已含 1 条即记录 1 条；
  // 事件里直接传入的引用在消费后追加不影响已写入记录。
  check("O13-9 快照在消费时固定（发射后追加不进入记录）",
    (rec?.contextMessages as unknown[]).length === 1,
    JSON.stringify(rec?.contextMessages));
}

{
  // 上下文中的凭据必须脱敏（日志副本），业务数据保留
  const emitter = new Emitter();
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-ctx-redact-"));
  const observer = attachRunObserver(emitter, { channel: "test", logsDir, write: null });
  const runId = "ctx-redact-run";
  emitter.emit({ type: "run_start", runId, startedAt: new Date().toISOString() });
  emitter.emit({
    type: "model_call_start", runId, turn: 1,
    messageCount: 1, messageCountDelta: 1, hasSystemPrompt: true, toolSchemaCount: 0,
    systemPromptText: "连接凭据 password=TopSecret123 不得外泄",
    contextMessages: [
      { role: "user", content: "用 token=abcdefghijklmnopqrstuvwxyz0123456789 查员工 10086" },
    ],
  });
  emitter.emit({ type: "run_end", runId, status: "completed", reason: "completed", elapsedMs: 1, modelCalls: 1, toolCalls: 0 });
  await observer.end("detached");
  const rec = readJsonl(logsDir).records.find((r) => r.event === "model_call_start");
  const raw = JSON.stringify(rec);
  check("O13-10 上下文/System Prompt 中的凭据已脱敏，业务数据保留",
    !raw.includes("TopSecret123") && !raw.includes("abcdefghijklmnopqrstuvwxyz0123456789") &&
    raw.includes("10086"),
    raw);
}

console.log(`\n========== observability 日志系统测试结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
