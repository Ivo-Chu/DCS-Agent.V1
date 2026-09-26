/**
 * 三问验收的纯判定逻辑（R1 审查修复；2026-09-24 随 Mock 工具移除改为
 * query_dcs_data 语义——核对"真实查询了相关数据 + 证据 + 回复事实"）。
 *
 * 与 acceptance-live.ts 分离的原因：判定规则必须能被离线对抗测试验证——
 * "错误字符串恰好命中关键词""查错数据（考勤≠报餐）"这类失败必须判 FAIL，
 * 而不是只在真实 key 场景下由人工肉眼发现。
 *
 * 判定原则：
 * - 每问必须正常结束：本轮无 agent_error，末条 AssistantMessage 的 stopReason 为 stop
 *   （API 错误回复即使文字包含全部关键词也必须 FAIL）
 * - 必要工具必须真的执行成功：query_dcs_data 的 tool_execution_end 存在且
 *   isError=false，并核对结果摘要中的关键证据（权限/角色、报餐/订单、餐标）
 * - 业务答案核对具体事实（42 / 35 / 超出 / 驳回——离线剧本数据），
 *   允许等价表述
 * - investigate_dcs_code 为允许的辅助调查工具，不作硬性要求
 *
 * 【live 注意】acceptance-live.ts 共用本判定器：场景 2/3 的事实核对
 * （42/35/驳回）基于离线剧本数据；真实库 + 真实身份前，live 场景可能
 * 因事实不匹配而 FAIL——这是诚实的失败，不以放宽判定掩盖。
 */

export interface QToolStart {
  toolName: string;
  args: unknown;
}

export interface QToolEnd {
  toolName: string;
  isError: boolean;
  summary: string;
}

/** 单个问题的判定输入（由事件流收集）。 */
export interface QEvents {
  toolStarts: QToolStart[];
  toolEnds: QToolEnd[];
  agentErrors: string[];
  /** 本轮最后一条 assistant_message 的 stopReason（无则为 null）。 */
  lastAssistantStop: string | null;
}

export interface JudgeResult {
  ok: boolean;
  failures: string[];
}

function argString(args: unknown): string {
  return JSON.stringify(args ?? {});
}

/** 通用门槛：正常结束 + 无错误 + 末轮 assistant 为自然 stop。 */
function commonFailures(qe: QEvents): string[] {
  const out: string[] = [];
  if (qe.agentErrors.length > 0) {
    out.push(`本轮出现 agent_error（${qe.agentErrors.length} 次），不能算通过`);
  }
  if (qe.lastAssistantStop !== "stop") {
    out.push(`末条 AssistantMessage stopReason=${String(qe.lastAssistantStop)}（要求正常 stop 结束）`);
  }
  return out;
}

/** 允许的工具：数据库查询（必需）与源码调查（辅助）。 */
const ALLOWED_TOOLS = new Set(["query_dcs_data", "investigate_dcs_code"]);

function disallowedTools(qe: QEvents): string[] {
  return qe.toolStarts
    .filter((s) => !ALLOWED_TOOLS.has(s.toolName))
    .map((s) => s.toolName);
}

/** query_dcs_data 的成功执行（end 存在、isError=false）。 */
function okQueryEnds(qe: QEvents): QToolEnd[] {
  return qe.toolEnds.filter((e) => e.toolName === "query_dcs_data" && !e.isError);
}

/** 场景 1：为什么我没有权限管理菜单。 */
export function judgeScenario1(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  const queryStarts = qe.toolStarts.filter((s) => s.toolName === "query_dcs_data");
  if (queryStarts.length === 0) {
    failures.push("未调用 query_dcs_data 查询权限数据");
  } else {
    const ends = qe.toolEnds.filter((e) => e.toolName === "query_dcs_data");
    if (ends.length === 0) {
      failures.push("query_dcs_data 没有执行完成（缺少 tool_execution_end）");
    } else if (ends.some((e) => e.isError)) {
      failures.push("query_dcs_data 执行失败（isError=true）");
    } else if (!okQueryEnds(qe).some((e) => e.summary.includes("权限") || e.summary.includes("角色") || e.summary.includes("MENU") || e.summary.includes("ROLE"))) {
      failures.push(`查询结果未体现权限/角色数据（查错目标）：${ends.map((e) => e.summary).join(" | ")}`);
    }
  }
  const others = disallowedTools(qe);
  if (others.length > 0) {
    failures.push(`场景 1 出现不允许的工具：${others.join("、")}`);
  }
  if (!((reply.includes("权限") || reply.includes("角色")) && (reply.includes("管理员") || reply.includes("角色") || reply.includes("开通") || reply.includes("联系")))) {
    failures.push(`回复未说明权限缺失原因及处理渠道：${reply.slice(0, 120)}`);
  }
  if (/Luxshare|Controllers|\.cs\b/.test(reply)) {
    failures.push("回复包含内部源码路径");
  }
  return { ok: failures.length === 0, failures };
}

/** 场景 2：我为什么报不了餐（查询报餐相关数据并给出有依据的原因）。 */
export function judgeScenario2(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  const queryStarts = qe.toolStarts.filter((s) => s.toolName === "query_dcs_data");
  if (queryStarts.length === 0) {
    failures.push(`未查询报餐相关数据：${qe.toolStarts.map((s) => `${s.toolName}${argString(s.args)}`).join("、")}`);
  } else {
    const ends = qe.toolEnds.filter((e) => e.toolName === "query_dcs_data");
    if (ends.length === 0) {
      failures.push("query_dcs_data 没有执行完成（缺少 tool_execution_end）");
    } else if (ends.some((e) => e.isError)) {
      failures.push("query_dcs_data 执行失败（isError=true）");
    } else if (!okQueryEnds(qe).some((e) => e.summary.includes("报餐") || e.summary.includes("订单") || e.summary.includes("餐") || e.summary.includes("MEAL"))) {
      failures.push(`查询结果未体现报餐/订单数据（查错目标）：${ends.map((e) => e.summary).join(" | ")}`);
    }
  }
  const others = disallowedTools(qe);
  if (others.length > 0) {
    failures.push(`场景 2 出现不允许的工具：${others.join("、")}`);
  }
  // 事实核对（离线剧本数据）：42 元实付 / 35 元餐标 / 超出 / 驳回（允许等价表述）
  const facts = ["42", "35", "驳回"].filter((k) => reply.includes(k));
  if (facts.length < 3) {
    failures.push(`回复缺少金额事实（42/35/驳回）：${reply.slice(0, 120)}`);
  }
  if (!(reply.includes("超出") || reply.includes("超") || reply.includes("超过"))) {
    failures.push(`回复未说明超出餐标：${reply.slice(0, 120)}`);
  }
  if (/Luxshare|Controllers|\.cs\b/.test(reply)) {
    failures.push("回复包含内部源码路径");
  }
  return { ok: failures.length === 0, failures };
}

/** 场景 3：追问「那餐标是多少」（同一会话，复用历史，查询目标为餐标配置）。 */
export function judgeScenario3(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  const queryStarts = qe.toolStarts.filter((s) => s.toolName === "query_dcs_data");
  if (queryStarts.length > 0) {
    // 追问轮若再次查库，目标必须是餐标配置（而非重复查订单/权限）
    const wrongTarget = queryStarts.filter(
      (s) => !(argString(s.args).includes("餐标") || argString(s.args).includes("MEAL_CONFIG") || argString(s.args).includes("CONFIG"))
    );
    if (wrongTarget.length > 0) {
      failures.push(`追问轮查询了非餐标数据：${wrongTarget.map((s) => argString(s.args)).join("、")}`);
    }
    const ends = qe.toolEnds.filter((e) => e.toolName === "query_dcs_data");
    if (ends.length === 0) {
      failures.push("query_dcs_data 没有执行完成（缺少 tool_execution_end）");
    } else if (ends.some((e) => e.isError)) {
      failures.push("query_dcs_data 执行失败（isError=true）");
    }
  }
  const others = disallowedTools(qe);
  if (others.length > 0) {
    failures.push(`追问轮出现不允许的工具：${others.join("、")}`);
  }
  if (!(reply.includes("35") && (reply.includes("元") || reply.includes("餐标")))) {
    failures.push(`回复未给出餐标 35 元：${reply.slice(0, 120)}`);
  }
  if (/Luxshare|Controllers|\.cs\b/.test(reply)) {
    failures.push("回复包含内部源码路径");
  }
  return { ok: failures.length === 0, failures };
}
