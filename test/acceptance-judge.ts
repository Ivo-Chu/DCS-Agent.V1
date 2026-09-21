/**
 * 三问验收的纯判定逻辑（R1 审查修复）。
 *
 * 与 acceptance-live.ts 分离的原因：判定规则必须能被离线对抗测试验证——
 * "错误字符串恰好命中关键词"“查错菜单 / 传错 dataType”这类失败必须判 FAIL，
 * 而不是只在真实 key 场景下由人工肉眼发现。
 *
 * 判定原则：
 * - 每问必须正常结束：本轮无 agent_error，末条 AssistantMessage 的 stopReason 为 stop
 *   （API 错误回复即使文字包含全部关键词也必须 FAIL）
 * - 必要工具必须真的执行成功：tool_execution_end 存在且 isError=false，
 *   并核对参数（menuName / dataType）与结果摘要中的关键事实
 * - 业务答案核对具体事实（42 / 35 / 超出 / 驳回），允许等价表述
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

function endsFor(qe: QEvents, toolName: string): QToolEnd[] {
  return qe.toolEnds.filter((e) => e.toolName === toolName);
}

function startsWithArg(qe: QEvents, toolName: string, key: string, value: string): QToolStart[] {
  return qe.toolStarts.filter(
    (s) => s.toolName === toolName && argString(s.args).includes(value)
  );
}

/** 场景 1：为什么我没有权限管理菜单。 */
export function judgeScenario1(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  const permStarts = qe.toolStarts.filter((s) => s.toolName === "check_dcs_permission");
  if (permStarts.length === 0) {
    failures.push("未调用 check_dcs_permission");
  } else {
    if (!permStarts.some((s) => argString(s.args).includes("权限管理"))) {
      failures.push(`权限查询的 menuName 不对：${permStarts.map((s) => argString(s.args)).join("、")}`);
    }
    const permEnds = endsFor(qe, "check_dcs_permission");
    if (permEnds.length === 0) {
      failures.push("check_dcs_permission 没有执行完成（缺少 tool_execution_end）");
    } else if (permEnds.some((e) => e.isError)) {
      failures.push("check_dcs_permission 执行失败（isError=true）");
    } else if (!permEnds.some((e) => e.summary.includes("缺少角色") && e.summary.includes("系统管理员"))) {
      failures.push(`权限结果未确认缺少系统管理员角色：${permEnds.map((e) => e.summary).join(" | ")}`);
    }
  }
  const otherTools = qe.toolStarts.filter((s) => s.toolName !== "check_dcs_permission");
  if (otherTools.length > 0) {
    failures.push(`场景 1 只应调用 check_dcs_permission，实际还调用了：${otherTools.map((s) => s.toolName).join("、")}`);
  }
  if (!(reply.includes("系统管理员") && (reply.includes("开通") || reply.includes("联系")))) {
    failures.push(`回复未说明缺少系统管理员角色及开通渠道：${reply.slice(0, 120)}`);
  }
  if (/Luxshare|Controllers|\.cs\b/.test(reply)) {
    failures.push("回复包含内部源码路径");
  }
  return { ok: failures.length === 0, failures };
}

/** 场景 2：我为什么报不了餐（先确认报餐管理权限 → 再查报餐订单）。 */
export function judgeScenario2(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  const permStarts = startsWithArg(qe, "check_dcs_permission", "menuName", "报餐管理");
  if (permStarts.length === 0) {
    failures.push(`未对「报餐管理」菜单查询权限：${qe.toolStarts.map((s) => `${s.toolName}${argString(s.args)}`).join("、")}`);
  } else {
    const permEnds = endsFor(qe, "check_dcs_permission");
    if (permEnds.length === 0) {
      failures.push("check_dcs_permission 没有执行完成（缺少 tool_execution_end）");
    } else if (permEnds.some((e) => e.isError)) {
      failures.push("check_dcs_permission 执行失败（isError=true）");
    } else if (!permEnds.some((e) => e.summary.includes("拥有") && e.summary.includes("报餐管理"))) {
      failures.push(`未先确认「报餐管理」有权限即查订单：${permEnds.map((e) => e.summary).join(" | ")}`);
    }
  }
  const orderStarts = startsWithArg(qe, "query_business_data", "dataType", "报餐订单");
  if (orderStarts.length === 0) {
    failures.push(`未查询报餐订单（dataType=报餐订单）：${qe.toolStarts.map((s) => `${s.toolName}${argString(s.args)}`).join("、")}`);
  } else {
    const orderEnds = endsFor(qe, "query_business_data");
    if (orderEnds.length === 0) {
      failures.push("query_business_data 没有执行完成（缺少 tool_execution_end）");
    } else if (orderEnds.some((e) => e.isError)) {
      failures.push("query_business_data 执行失败（isError=true 或 dataType 无效）");
    } else if (!orderEnds.some((e) => e.summary.includes("驳回"))) {
      failures.push(`订单结果未体现驳回：${orderEnds.map((e) => e.summary).join(" | ")}`);
    }
  }
  // 顺序：权限查询在订单查询之前
  const firstPerm = qe.toolStarts.findIndex((s) => s.toolName === "check_dcs_permission");
  const firstOrder = qe.toolStarts.findIndex((s) => s.toolName === "query_business_data");
  if (firstPerm >= 0 && firstOrder >= 0 && firstPerm > firstOrder) {
    failures.push("查订单先于查权限（违反先权限后数据的规则）");
  }
  // 事实核对：42 元实付 / 35 元餐标 / 超出 / 驳回（允许等价表述）
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

/** 场景 3：追问「那餐标是多少」（同一会话，不重复查权限）。 */
export function judgeScenario3(qe: QEvents, reply: string): JudgeResult {
  const failures = commonFailures(qe);
  if (qe.toolStarts.some((s) => s.toolName === "check_dcs_permission")) {
    failures.push("追问轮重复查权限（应复用历史上下文）");
  }
  const dataStarts = qe.toolStarts.filter((s) => s.toolName === "query_business_data");
  if (dataStarts.length > 0) {
    const valid = dataStarts.every((s) => argString(s.args).includes("餐标配置"));
    if (!valid) {
      failures.push(`追问轮查询了非餐标配置的业务数据：${dataStarts.map((s) => argString(s.args)).join("、")}`);
    }
    const dataEnds = endsFor(qe, "query_business_data");
    if (dataEnds.length === 0) {
      failures.push("query_business_data 没有执行完成（缺少 tool_execution_end）");
    } else if (dataEnds.some((e) => e.isError)) {
      failures.push("query_business_data 执行失败（isError=true）");
    }
  }
  const otherTools = qe.toolStarts.filter(
    (s) => s.toolName !== "query_business_data" && s.toolName !== "check_dcs_permission"
  );
  if (otherTools.length > 0) {
    failures.push(`追问轮不应调用其他工具：${otherTools.map((s) => s.toolName).join("、")}`);
  }
  if (!(reply.includes("35") && (reply.includes("元") || reply.includes("餐标")))) {
    failures.push(`回复未给出餐标 35 元：${reply.slice(0, 120)}`);
  }
  if (/Luxshare|Controllers|\.cs\b/.test(reply)) {
    failures.push("回复包含内部源码路径");
  }
  return { ok: failures.length === 0, failures };
}
