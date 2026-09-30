/**
 * dcs/tools.ts
 * DCS 工具集（方案 v2 + query-dcs-data-plan-v1）。
 *
 * 目标架构已达成：query_dcs_data（真实只读数据库）+ investigate_dcs_code（源码调查）。
 *
 * 身份一律来自 ctx.session（DcsToolContext），
 * 工具参数 Schema 中不存在任何身份字段 —— 模型无法指定 employeeNo，
 * 真正查询哪个员工由可信的 DcsToolContext 决定。
 *
 * ★ Legacy Mock 工具（check_dcs_permission / query_business_data）已于
 *   2026-09-24 移除（用户授权"直接删掉 mock 部分，用真实数据回复"）：
 *   真实库验证通过（live:db 4/4）后，所有业务数据查询统一走 query_dcs_data。
 *
 * ★ investigate_dcs_code：真实只读实现（方案 v2 §3-§6），搜索 + 定位 + 上下文融合。
 * ★ query_dcs_data：真实只读数据库查询（query-dcs-data-plan-v1），
 *   模型自主编写 SELECT；护栏仅防卡死，权限全开放为测试期知情决策（方案 §10）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolOutput } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { getDbClient } from "./db/client.ts";
import { guardSql } from "./db/guard.ts";
import { formatQueryResult } from "./db/format.ts";
import { getDiscoveredSchema } from "./identity.ts";
import { searchDcsKnowledgeTool } from "./knowledge/tool.ts";

// ---------------------------------------------------------------------------
// 工具 1：investigate_dcs_code（方案 v2：搜索 + 定位 + 上下文融合，只读）
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
// 工具 2：query_dcs_data（真实只读数据库查询，query-dcs-data-plan-v1）
// 模型自主编写 SELECT；护栏仅防卡死（guard），错误透传供模型自修正。
// 测试期权限全开放为用户知情决策（方案 §10）："只查本人"由 prompt 边界 4
// 软约束，工具层不强制——上线前按方案 §9 恢复 named query catalog。
//
// 2026-09-24 方案A+B（真人测试"我有什么权限" turns=25 toolCalls=52 驱动）：
// - A：schema 提示动态化——原静态常量在 DCS_DB_SCHEMA 未设时回退登录用户名
//   （只读账号非表所有者），教模型查的数据字典返回 0 行、示例前缀必报
//   ORA-00942，等于把模型引向死路（52 次调用大部分花在绕出这条路）。
//   现改为 getter，复用 identity 链路的自动发现结果。
// - B：内置常用表数据字典（表名/字段全部来自 DCS 源码实体验证，不虚构），
//   模型不再需要 ALL_TABLES 试错探索即可直接写 JOIN。
//   2026-09-24 真机修正：DCS 有两套并行权限表——无 ADM 前缀的
//   S2_UserRole/S2_Role/S2_RolePermission/S2_Permission 才是员工主权限
//   （首轮按 ADM 组查询返回 0 行即此原因）；ADM 组为管理模块独立权限。
// ---------------------------------------------------------------------------

export interface QueryDcsDataArgs {
  sql: string;
}

/** ORA 错误信息截断上限（防超长错误堆栈撑爆 ToolResult）。 */
const MAX_ERROR_CHARS = 500;

/**
 * 数据字典提示中的表所属 schema（方案A）。
 * 优先级：DCS_DB_SCHEMA 显式配置 > identity 自动发现结果 > DCS_DB_USER 兜底
 * （CLI 等未触发身份发现的场景）。description 为 getter，每次构造请求时重算，
 * 身份链路发现 schema 后提示自动修正。
 */
function dbDictOwner(): string {
  const configured = process.env.DCS_DB_SCHEMA?.trim();
  if (configured) return configured;
  const discovered = getDiscoveredSchema();
  if (discovered) return discovered;
  return process.env.DCS_DB_USER || "<DCS表所属schema>";
}

/** query_dcs_data 描述（方案B：常用表数据字典，字段名来自源码实体验证）。 */
function buildQueryDcsDataDescription(): string {
  const owner = dbDictOwner();
  return [
    "在 DCS 系统数据库（Oracle）中执行只读 SELECT 查询，获取系统真实运行数据（权限、报餐、流程状态等）。你可以自主编写 SQL。",
    "",
    `【schema 前缀】业务表属于 schema「${owner}」，查询必须带前缀（如 ${owner}.S2_Employee），裸表名会报 ORA-00942。不确定某表的 schema 时可反查：SELECT OWNER FROM ALL_TABLES WHERE TABLE_NAME = '表名'。`,
    "",
    "【常用表速查】（字段为数据库列名）",
    "- 员工：S2_Employee —— Code 工号、Name 姓名、DeptName 部门、UserId 企微userid、IdCard 身份证、Telephone 电话（含敏感字段，仅限查本人）",
    "- 权限/菜单（回答我有什么权限/角色类问题，员工权限主要在这组表）：",
    "  S2_UserRole：EmpCode(工号)、RoleCode(角色Code)",
    "  S2_Role：Code、Name(角色名)、RoleType(所属系统分类)",
    "  S2_RolePermission：RoleCode、PermissionId(功能Id)",
    "  S2_Permission：Id、PId(上级)、Name(功能名)、Url",
    `  查某工号权限示例：SELECT r.Name AS 角色, p.Name AS 功能 FROM ${owner}.S2_UserRole ur JOIN ${owner}.S2_Role r ON r.Code = ur.RoleCode LEFT JOIN ${owner}.S2_RolePermission rp ON rp.RoleCode = ur.RoleCode LEFT JOIN ${owner}.S2_Permission p ON p.Id = rp.PermissionId WHERE ur.EmpCode = '工号'`,
    "  权限较多时（数百角色×功能）建议先聚合统计（如按角色 GROUP BY 计数）或加 WHERE 过滤，避免 JOIN 结果被行数上限截断。",
    "  另有一组 S2_ADMUserRole / S2_ADMRole / S2_ADMRolePermission / S2_ADMPermission / S2_ADMMenu 是 ADM 管理模块的独立权限，普通员工通常无记录——查个人权限优先用上面无 ADM 前缀的表。",
    "",
    `【找其他表】查表名：SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${owner}' AND TABLE_NAME LIKE '%关键字%'；查列名：SELECT TABLE_NAME, COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE OWNER = '${owner}' AND TABLE_NAME LIKE '%关键字%'（数据字典视图 ALL_TABLES / ALL_TAB_COLUMNS 本身不要加 schema 前缀，加了会报 ORA-00942）；也可以先用 investigate_dcs_code 从源码找表名和字段。`,
    "",
    "【规则】仅允许单条 SELECT/WITH 语句；查询出错时错误信息会返回给你，可据此修正 SQL 后重试。",
  ].join("\n");
}

export const queryDcsDataTool: ToolDefinition<QueryDcsDataArgs, DcsToolContext> = {
  name: "query_dcs_data",
  label: "DCS数据库查询",
  // 方案A：getter 每次读取时重算——身份链路发现 schema 后提示自动修正
  get description() {
    return buildQueryDcsDataDescription();
  },
  parameters: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description:
          "要执行的只读 SQL（单条 SELECT 或 WITH 语句）。查询他人个人数据属于越权，不要执行。",
      },
    },
    required: ["sql"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const sql = String(args?.sql ?? "").trim();
    if (!sql) {
      return { output: "缺少 SQL（sql）。", isError: true };
    }

    // 护栏：仅防卡死与误写（单条只读语句）
    const guard = guardSql(sql);
    if (!guard.ok) {
      // 2026-09-28：guard 拒绝是真实的执行失败，必须如实标记 isError:true
      //（事件流与 ToolResult 一致）；错误内容保留修正提示，模型可改写后重试。
      return { output: `SQL 被拒绝：${guard.reason}。请改写为单条只读 SELECT/WITH 语句后重试。`, isError: true };
    }

    // 环境变量门控：与 DCS_SOURCE_ROOT 同一模式
    const client = getDbClient();
    if (!client) {
      return {
        output: "数据库查询能力当前不可用：未配置 DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING 环境变量。",
        isError: true,
      };
    }

    try {
      const { columns, rows } = await client.execute(sql);
      const { output } = formatQueryResult(columns, rows);
      return { output };
    } catch (err) {
      // ORA 错误截断后原样返回模型（供自我修正 SQL 重试）；永不抛异常。
      // 2026-09-28：执行异常是真实的工具失败，标记 isError:true（事件流与
      // ToolResult 一致）；AgentLoop 语义不变——工具失败仍生成 ToolResult
      // 交给下一轮模型修正，不会终止整个 Run。
      const msg = String(err instanceof Error ? err.message : err).slice(0, MAX_ERROR_CHARS);
      return { output: `查询出错（可修正 SQL 后重试）：${msg}`, isError: true };
    }
  },
};

// ---------------------------------------------------------------------------

export const dcsTools: ToolDefinition<any, DcsToolContext>[] = [
  searchDcsKnowledgeTool,
  investigateDcsCodeTool,
  queryDcsDataTool,
];
