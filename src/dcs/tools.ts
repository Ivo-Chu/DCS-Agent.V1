/**
 * dcs/tools.ts
 * DCS 工具集（方案 v2：docs/tool-convergence-plan-v2.md）。
 *
 * 目标架构：query_dcs_data（暂缓）+ investigate_dcs_code（本轮实现）。
 *
 * 身份一律来自 ctx.session（DcsToolContext），
 * 工具参数 Schema 中不存在任何身份字段 —— 模型无法指定 employeeNo，
 * 真正查询哪个员工由可信的 DcsToolContext 决定。
 *
 * ★ Legacy 工具（本轮保留、不再扩展，待 query_dcs_data 上线后替换删除）：
 * - check_dcs_permission / query_business_data
 *
 * ★ 数据来源标记（2026-09-22 用户授权）：
 * - 菜单表 / 报餐订单 / 餐标配置 = TEST DATA（测试数据），仅用于系统集成验证，
 *   不代表真实 DCS 数据，不得伪装为真实查询结果。
 * - 正式上线前替换为真实 DCS 只读数据源；届时只替换本文件的数据访问实现，
 *   正式 Tool 接口（名称/参数/Schema/返回语义）不变。
 *
 * ★ investigate_dcs_code：真实只读实现（方案 v2 §3-§6），
 *   搜索 + 定位 + 上下文融合，取代原 search_dcs_code。
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
// Legacy 工具 1：check_dcs_permission（TEST DATA，待 query_dcs_data 替换）
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
// Legacy 工具 2：query_business_data（TEST DATA，待 query_dcs_data 替换）
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
// 工具 3：investigate_dcs_code（方案 v2：搜索 + 定位 + 上下文融合，只读）
// 取代原 search_dcs_code：模型单次调用即获得命中位置与必要上下文，
// 需要深入时再次调用同一工具（更具体 query / path 限定 / 更大 contextLines）。
// ---------------------------------------------------------------------------

export interface InvestigateDcsCodeArgs {
  query: string;
  path?: string;
  contextLines?: number;
}

/** 顶层业务项目白名单（方案 v2 §4）。 */
const TOP_LEVEL_PROJECTS = ["Luxshare.DCS.WebApi", "Luxshare.DCS.WebApp", "Common"];

/** 目录黑名单（任意层级，目录名小写比较；依赖 / 构建产物 / 资源）。 */
const DIR_BLOCKLIST = new Set([
  "bin", "obj", "node_modules", "dist", ".git", ".vs", "packages",
  "upload", "images", "content", "css", "documents", "template",
  "app_data", "ffmpeg", "refdll", "scripts", "fonts", "echarts",
  "logs", "log",
]);

/** 允许的文本源码扩展名。 */
const EXT_ALLOWLIST = new Set([".cs", ".cshtml", ".js", ".ts", ".config", ".json", ".xml"]);

const MAX_FILES = 15000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单次最多返回的候选命中数（方案 v2 §5：10~20，取 15）。 */
const MAX_HITS = 15;
/** 单文件命中上限：防止一个文件刷屏，鼓励用 path 收窄深入。 */
const MAX_HITS_PER_FILE = 3;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 50;
/** 单行渲染截断。 */
const MAX_LINE_CHARS = 240;
/** 单次 ToolResult 总输出保险上限（方案 v2 §5：不会一次返回巨量源码）。 */
const MAX_OUTPUT_CHARS = 60000;

function isAllowedFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.includes(".min.")) return false;
  // 凭据文件名黑名单：.env/.pfx/.key/.pem 与 secret 前缀文件
  if (/\.(env|pfx|key|pem)$/.test(lower) || lower.startsWith("secret")) return false;
  return EXT_ALLOWLIST.has(path.extname(lower));
}

/** target（resolve 后）必须位于 rootAbs 内：防 ../ 穿越、绝对路径与盘符/UNC 逃逸。 */
function isInsideRoot(rootAbs: string, target: string): boolean {
  try {
    const rel = path.relative(rootAbs, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * 目录 → 允许文件列表的进程内缓存（bot 为长驻进程，首次遍历约 10s+，后续秒级）。
 * 只缓存路径列表不缓存内容（每次调查仍实时读取文件）；
 * 测试期不做失效（源码在调查过程中不变，进程重启即刷新）。
 */
const listCache = new Map<string, string[]>();

/** 递归收集允许范围内的文件（同步只读，黑名单目录剪枝）。 */
function listAllowedFiles(dir: string, acc: string[] = []): string[] {
  const cached = listCache.get(dir);
  if (cached) {
    acc.push(...cached.slice(0, Math.max(0, MAX_FILES - acc.length)));
    return acc;
  }
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (DIR_BLOCKLIST.has(e.name.toLowerCase())) continue;
        walk(p);
      } else if (e.isFile() && isAllowedFile(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  listCache.set(dir, out);
  acc.push(...out.slice(0, Math.max(0, MAX_FILES - acc.length)));
  return acc;
}

/**
 * 文件内容缓存（bot 长驻进程的多轮调查场景：首次全量读取约 10s，后续毫秒级）。
 * 总量上限 256MB、单文件 ≤256KB 才缓存，超限后不再缓存新文件（防内存失控）。
 * 测试期不做失效（源码在调查过程中不变，进程重启即刷新）。
 */
const contentCache = new Map<string, string>();
const CONTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CONTENT_CACHE_MAX_FILE_BYTES = 256 * 1024;
let contentCacheBytes = 0;

/** 读取源码文件（带缓存）：超 2MB / 读取失败返回 null。 */
function readSourceFile(file: string): string | null {
  const cached = contentCache.get(file);
  if (cached !== undefined) return cached;
  let stat: fs.Stats;
  let content: string;
  try {
    stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return null;
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (stat.size <= CONTENT_CACHE_MAX_FILE_BYTES && contentCacheBytes + content.length * 2 <= CONTENT_CACHE_MAX_BYTES) {
    contentCache.set(file, content);
    contentCacheBytes += content.length * 2;
  }
  return content;
}

interface CodeHit {
  rel: string;
  lines: string[];
  start: number; // 0-based，含
  end: number; // 0-based，不含
  mark: number; // 命中行（0-based）
}

function clampContextLines(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CONTEXT_LINES;
  return Math.max(0, Math.min(MAX_CONTEXT_LINES, n));
}

export const investigateDcsCodeTool: ToolDefinition<InvestigateDcsCodeArgs, DcsToolContext> = {
  name: "investigate_dcs_code",
  label: "DCS源码调查",
  description:
    "在 DCS 系统源码中按关键词调查实现证据，返回命中位置及附近代码上下文（相对路径 + 行号）。这是通用调查能力：凡与 DCS 系统相关的问题（业务逻辑、配置、权限、显示规则等），即使没有专用业务工具，都可以用它寻找证据，并且可以多次调用逐步深入。参数：query 为关键词/方法名/字段名/业务名称；path 可选，用上次结果的相对路径限定到某文件或目录以聚焦调查；contextLines 可选，控制每个命中前后返回的上下文行数（默认 3，最大 50）。搜索范围：Luxshare.DCS.WebApi、Luxshare.DCS.WebApp、Common 下的文本源码与配置文件（依赖、构建产物、资源目录已排除）。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，例如：协调员、报餐、GetEmployee、connectionString",
      },
      path: {
        type: "string",
        description:
          "可选。限定搜索范围：DCS_SOURCE_ROOT 下的相对文件路径或目录路径（使用上次调查结果中返回的相对路径）",
      },
      contextLines: {
        type: "number",
        description: "可选。每个命中前后返回的上下文行数，默认 3，最大 50",
      },
    },
    required: ["query"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const query = String(args?.query ?? "").trim();
    if (!query) {
      return { output: "缺少搜索关键词（query）。", isError: true };
    }

    // 方案 v2 §4：DCS_SOURCE_ROOT 必须通过环境变量配置，代码不硬编码路径
    const root = process.env.DCS_SOURCE_ROOT;
    if (!root) {
      return {
        output: "源码调查能力当前不可用：未配置 DCS_SOURCE_ROOT 环境变量。",
        isError: true,
      };
    }
    const rootAbs = path.resolve(root);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
      return {
        output: "源码调查能力当前不可用：DCS_SOURCE_ROOT 指向的目录不存在。",
        isError: true,
      };
    }

    // path 参数：限定范围（文件或目录），必须位于 root 内
    let scopeAbs = rootAbs;
    let scopeIsFile = false;
    let scopeLabel = "全部允许源码";
    const rawPath = args?.path ? String(args.path).trim() : "";
    if (rawPath) {
      const resolved = path.resolve(rootAbs, rawPath);
      if (!isInsideRoot(rootAbs, resolved)) {
        return { output: "拒绝访问：path 超出 DCS_SOURCE_ROOT 范围。", isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return { output: `指定路径不存在：${rawPath}`, isError: true };
      }
      const st = fs.statSync(resolved);
      if (st.isFile()) {
        if (!isAllowedFile(path.basename(resolved))) {
          return {
            output: "拒绝访问：该文件不在允许的源码类型/名单内（凭据或非文本源码文件）。",
            isError: true,
          };
        }
        scopeIsFile = true;
      }
      scopeAbs = resolved;
      scopeLabel = rawPath;
    }

    const contextLines = clampContextLines(args?.contextLines);

    // 收集候选文件
    let files: string[];
    if (scopeIsFile) {
      files = [scopeAbs];
    } else if (
      scopeAbs === rootAbs &&
      TOP_LEVEL_PROJECTS.some((p) => fs.existsSync(path.join(rootAbs, p)))
    ) {
      // 顶层白名单：真实 DCS 源码树只搜三个业务项目；
      // 若 root 下无白名单项目（测试 fixture / 其他源码树），退化为全 root 减黑名单
      files = [];
      for (const p of TOP_LEVEL_PROJECTS) {
        const d = path.join(rootAbs, p);
        if (fs.existsSync(d)) listAllowedFiles(d, files);
      }
    } else {
      files = listAllowedFiles(scopeAbs);
    }

    // 搜索
    const needle = query.toLowerCase();
    const hits: CodeHit[] = [];
    const perFile = new Map<string, number>();
    let scanned = 0;

    outer: for (const file of files) {
      scanned++;
      const content = readSourceFile(file);
      if (content === null) continue;
      const lines = content.split(/\r?\n/);
      const rel = path.relative(rootAbs, file).replace(/\\/g, "/");
      let fileHits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + 1 + contextLines);
          hits.push({ rel, lines, start, end, mark: i });
          fileHits++;
          if (hits.length >= MAX_HITS) break outer;
          if (fileHits >= MAX_HITS_PER_FILE) break;
        }
      }
    }

    if (hits.length === 0) {
      return {
        output: `未找到相关代码（关键词：${query}；范围：${scopeLabel}；已扫描 ${scanned} 个文件）。可调整关键词、或通过 path 改变/扩大范围后重试。`,
      };
    }

    // 渲染（渐进式：命中行标记 >，上下文行缩进；总体积保险）
    const parts: string[] = [
      `调查「${query}」：命中 ${hits.length} 处（范围：${scopeLabel}；扫描 ${scanned} 个文件）`,
    ];
    let size = parts[0].length;
    let outputTruncated = false;
    for (let h = 0; h < hits.length; h++) {
      const hit = hits[h];
      const lines: string[] = [];
      lines.push(`[${h + 1}] ${hit.rel} 第 ${hit.start + 1}-${hit.end} 行（> 为命中行）：`);
      for (let i = hit.start; i < hit.end; i++) {
        const prefix = i === hit.mark ? ">" : " ";
        const text = renderLine(hit.lines[i]);
        lines.push(`${prefix}${String(i + 1).padStart(5)} | ${text}`);
      }
      const block = lines.join("\n");
      if (size + block.length > MAX_OUTPUT_CHARS) {
        outputTruncated = true;
        break;
      }
      parts.push(block);
      size += block.length;
    }

    if (hits.length >= MAX_HITS) {
      parts.push("（已达单次命中上限；可用更具体的 query 或 path 限定范围深入调查）");
    }
    if (outputTruncated) {
      parts.push("（输出体积达上限已截断；可用更具体的 query 或 path 限定范围深入调查）");
    }
    return { output: parts.join("\n\n") };
  },
};

/** 渲染前单行清理：去首尾空白 + 截断超长行。 */
function renderLine(line: string | undefined): string {
  const t = (line ?? "").trim();
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t;
}

// ---------------------------------------------------------------------------

export const dcsTools: ToolDefinition<any, DcsToolContext>[] = [
  checkDcsPermissionTool,
  queryBusinessDataTool,
  investigateDcsCodeTool,
];
