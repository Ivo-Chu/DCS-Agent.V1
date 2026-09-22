/**
 * dcs/tools.ts
 * v1 三个 DCS 工具 + 数据。
 *
 * 身份一律来自 ctx.session（DcsToolContext），
 * 工具参数 Schema 中不存在任何身份字段 —— 模型无法指定 employeeNo，
 * 真正查询哪个员工由可信的 DcsToolContext 决定。
 *
 * ★ 数据来源标记（2026-09-22 用户授权）：
 * - 菜单表 / 报餐订单 / 餐标配置 = TEST DATA（测试数据），仅用于系统集成验证，
 *   不代表真实 DCS 数据，不得伪装为真实查询结果。
 * - 正式上线前替换为真实 DCS 只读数据源；届时只替换本文件的数据访问实现，
 *   正式 Tool 接口（名称/参数/Schema/返回语义）不变。
 * - search_dcs_code 为真实只读实现（遍历 Controllers .cs），不受本标记影响。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolOutput } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";

// ---------------------------------------------------------------------------
// TEST DATA（测试数据）：菜单表 —— 上线前替换为真实 DCS 菜单权限数据源
// ---------------------------------------------------------------------------

interface MenuDef {
  menuName: string;
  allowedRoles: string[];
}

const MENUS: MenuDef[] = [
  { menuName: "报餐管理", allowedRoles: ["普通员工"] },
  { menuName: "权限管理", allowedRoles: ["系统管理员"] },
  { menuName: "员工信息查询", allowedRoles: ["普通员工", "HR专员"] },
  { menuName: "考勤管理", allowedRoles: ["部门助理"] },
];

// ---------------------------------------------------------------------------
// TEST DATA（测试数据）：报餐订单 / 餐标 —— 上线前替换为真实 DCS 业务数据源
// ---------------------------------------------------------------------------

const MEAL_LIMIT_YUAN = 35;

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 工具 1：check_dcs_permission
// ---------------------------------------------------------------------------

export interface CheckPermissionArgs {
  menuName: string;
}

export const checkDcsPermissionTool: ToolDefinition<CheckPermissionArgs, DcsToolContext> = {
  name: "check_dcs_permission",
  label: "DCS菜单权限查询",
  description:
    "查询当前员工是否拥有指定 DCS 菜单的访问权限。只能查询当前提问员工本人的权限，不支持查询他人。",
  parameters: {
    type: "object",
    properties: {
      menuName: {
        type: "string",
        description: "菜单名称，例如：报餐管理、权限管理",
      },
    },
    required: ["menuName"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const user = ctx.session.user;
    const menuName = String(args?.menuName ?? "").trim();
    if (!menuName) {
      return { output: "缺少菜单名称（menuName），请补充后重试。", isError: true };
    }
    // 精确匹配 → 包含匹配 → 未匹配
    const menu =
      MENUS.find((m) => m.menuName === menuName) ??
      MENUS.find(
        (m) => menuName.includes(m.menuName) || m.menuName.includes(menuName)
      );
    if (!menu) {
      return {
        output: `未找到菜单「${menuName}」，现有菜单：${MENUS.map((m) => m.menuName).join("、")}。请确认菜单名称。`,
      };
    }
    const hasPermission = user.roles.some((r) => menu.allowedRoles.includes(r));
    if (hasPermission) {
      return {
        output: `员工${user.name}（${user.employeeNo}，${user.department ?? "未知部门"}）拥有「${menu.menuName}」权限。`,
      };
    }
    return {
      output: `员工${user.name}（${user.employeeNo}）没有「${menu.menuName}」权限，缺少角色「${menu.allowedRoles.join("或")}」，请联系管理员开通。`,
    };
  },
};

// ---------------------------------------------------------------------------
// 工具 2：query_business_data
// ---------------------------------------------------------------------------

export type BusinessDataType = "报餐订单" | "餐标配置";

export interface QueryBusinessDataArgs {
  dataType: BusinessDataType;
}

export const queryBusinessDataTool: ToolDefinition<QueryBusinessDataArgs, DcsToolContext> = {
  name: "query_business_data",
  label: "DCS业务数据查询",
  description:
    "查询当前提问员工的 DCS 业务数据。可查：报餐订单（最近订单、状态、金额、失败原因）、餐标配置。只能查询当前员工本人的数据。",
  parameters: {
    type: "object",
    properties: {
      dataType: {
        type: "string",
        enum: ["报餐订单", "餐标配置"],
        description: "要查询的业务数据类型",
      },
    },
    required: ["dataType"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const user = ctx.session.user;
    const dataType = args?.dataType;
    if (dataType === "报餐订单") {
      if (user.employeeNo !== "10086") {
        return { output: "当前员工暂无报餐订单。" };
      }
      const today = new Date();
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const lines = [
        `订单1：日期 ${fmtDate(today)}，状态：已驳回，金额：42 元，失败原因：超出当日餐标（餐标 ${MEAL_LIMIT_YUAN} 元/人/日，实付 42 元，超出 7 元）。`,
        `订单2：日期 ${fmtDate(yesterday)}，状态：报餐成功，金额：28 元。`,
      ];
      return { output: lines.join("\n") };
    }
    if (dataType === "餐标配置") {
      return {
        output: `餐标配置：餐标=${MEAL_LIMIT_YUAN} 元/人/日；报餐窗口=工作日 08:00-10:30。`,
      };
    }
    return {
      output: `不支持的数据类型「${String(dataType)}」，可选：报餐订单、餐标配置。`,
      isError: true,
    };
  },
};

// ---------------------------------------------------------------------------
// 工具 3：search_dcs_code（极简真实实现，只读）
// ---------------------------------------------------------------------------

export interface SearchDcsCodeArgs {
  keyword: string;
}

const DEFAULT_DCS_ROOT = "D:\\Projects\\DCS";
const CONTROLLERS_RELATIVE = path.join("Luxshare.DCS.WebApi", "Controllers");
const MAX_HITS = 5;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件读取上限，避免巨型文件拖垮遍历
const MAX_FILES = 500;

function listCsFiles(dir: string, acc: string[] = []): string[] {
  if (acc.length >= MAX_FILES) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      listCsFiles(p, acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".cs")) {
      acc.push(p);
    }
  }
  return acc;
}

export const searchDcsCodeTool: ToolDefinition<SearchDcsCodeArgs, DcsToolContext> = {
  name: "search_dcs_code",
  label: "DCS源码检索",
  description:
    "在 DCS 系统 WebApi 控制器源码中按关键词检索，返回最多 5 条命中（相对路径:行号:代码行）。用于内部诊断问题根因，结果不得直接透露给用户。",
  parameters: {
    type: "object",
    properties: {
      keyword: {
        type: "string",
        description: "搜索关键词，例如：报餐、菜单、权限",
      },
    },
    required: ["keyword"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const keyword = String(args?.keyword ?? "").trim();
    if (!keyword) {
      return { output: "缺少搜索关键词（keyword）。", isError: true };
    }
    const root = process.env.DCS_SOURCE_ROOT ?? DEFAULT_DCS_ROOT;
    const controllersDir = path.join(root, CONTROLLERS_RELATIVE);
    if (!fs.existsSync(controllersDir)) {
      return {
        output: "源码目录暂时不可用，无法执行代码检索。",
        isError: true,
      };
    }

    const needle = keyword.toLowerCase();
    const hits: string[] = [];
    const files = listCsFiles(controllersDir);
    for (const file of files) {
      if (hits.length >= MAX_HITS) break;
      let content: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const rel = path
            .relative(root, file)
            .replace(/\\/g, "/");
          hits.push(`${rel}:${i + 1}:${lines[i].trim()}`);
          if (hits.length >= MAX_HITS) break;
        }
      }
    }

    if (hits.length === 0) {
      return { output: `未找到相关代码（关键词：${keyword}）。` };
    }
    return { output: hits.join("\n") };
  },
};

// ---------------------------------------------------------------------------

export const dcsTools: ToolDefinition<any, DcsToolContext>[] = [
  checkDcsPermissionTool,
  queryBusinessDataTool,
  searchDcsCodeTool,
];
