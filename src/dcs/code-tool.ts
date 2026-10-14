import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ToolDefinition, ToolOutput } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { maskPii } from "./hooks.ts";

export const CODE_LIMITS = { find: 50, search: 20, read: 80, readMax: 200,
  files: 15000, bytes: 2 * 1024 * 1024, chars: 24000, lineChars: 1000, timeoutMs: 10000 };
const PROJECTS = ["Luxshare.DCS.WebApi", "Luxshare.DCS.WebApp", "Common"];
const BLOCKED = new Set("bin obj node_modules dist .git .vs packages upload images content css documents template app_data ffmpeg refdll scripts fonts echarts logs log".split(" "));
const EXTENSIONS = new Set([".cs", ".cshtml", ".js", ".ts", ".config", ".json", ".xml"]);
export interface InvestigateDcsCodeArgs {
  operation: "find" | "search" | "read";
  pattern?: string; path?: string; mode?: "literal" | "regex"; offset?: number; limit?: number;
}
function allowed(rel: string, file: boolean): boolean {
  const parts = rel.split("/");
  return PROJECTS.includes(parts[0]) && !parts.some(p => BLOCKED.has(p.toLowerCase())) &&
    (!file || (EXTENSIONS.has(path.extname(rel).toLowerCase()) &&
      !/(^|\/)(secret[^/]*|\.env[^/]*|[^/]*\.(?:min\.|pfx$|key$|pem$))/i.test(rel)));
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
// 有界通配符匹配，避免把模型的 glob 编译为可能灾难性回溯的 JS 正则。
function matchesGlob(value: string, pattern: string): boolean {
  value = value.toLowerCase(); pattern = pattern.toLowerCase();
  let v = 0, p = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) { v++; p++; }
    else if (pattern[p] === "*") { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
async function checked(root: string, rel: string, file: boolean, directories = new Set<string>()): Promise<string> {
  if (!rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.includes(":" ) || rel.split("/").includes("..") || !allowed(rel, file)) throw new Error("forbidden: 路径不在源码白名单内");
  const full = path.resolve(root, rel);
  const real = await fs.realpath(full);
  if (!inside(root, real) || !allowed(path.relative(root, real).replace(/\\/g, "/"), file)) throw new Error("forbidden: 符号链接越界");
  // 不接受任何路径分量中的链接，避免白名单内的目录别名绕过过滤。
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    if (directories.has(current)) continue;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("forbidden: 不允许符号链接");
    if (stat.isDirectory()) directories.add(current);
  }
  return full;
}
function rg(args: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.env.DCS_RG_PATH || "rg", args, { cwd, timeout: Math.max(1, timeout),
      maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8", signal }, (err, stdout) => {
      if (!err || (err as { code?: unknown }).code === 1) resolve(stdout);
      else if ((err as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("unavailable: ripgrep 不可用，请安装 rg 或配置 DCS_RG_PATH。"));
      else if ((err as { code?: unknown }).code === 2) reject(new Error("invalid_args: ripgrep 无法执行搜索，请检查正则语法及文件访问权限。"));
      else reject(new Error("unavailable: 源码扫描超时、取消或输出超过缓冲区上限，请缩小 path。"));
    });
  });
}
function safeLine(line: string): string {
  // 配置凭据可能跨行：配置文件在读取时整体屏蔽；源码敏感赋值整行隐藏。
  if (/password|pwd|secret|token|api.?key|access.?key|connectionstring|private.key|bearer\s/i.test(line)) return "[敏感配置行已隐藏]";
  return maskPii(line);
}
function safeLines(source: string): string[] {
  let continuation = false;
  return source.split(/\r?\n/).map(line => {
    const sensitive = /password|pwd|secret|token|api.?key|access.?key|connectionstring|private.key|bearer\s/i.test(line);
    if (sensitive || continuation) {
      continuation = !line.includes(";");
      return "[敏感配置行已隐藏]";
    }
    return safeLine(line);
  });
}
export const investigateDcsCodeTool: ToolDefinition<InvestigateDcsCodeArgs, DcsToolContext> = {
  name: "investigate_dcs_code", label: "DCS源码调查",
  description: "定位并读取源码实现。find 使用文件名/路径 glob（如 *Dorm*.cs）；search 默认 literal 连续字面量匹配，空格不会自动拆词；regex 使用 ripgrep 正则，可用 宿舍|入住 表示或。read 用返回的相对 path 读取行号。offset：find/search 为从0开始的结果偏移，read 为从1开始的行号。配置文件内容不暴露。",
  parameters: { type: "object", additionalProperties: false, properties: {
    operation: { type: "string", enum: ["find", "search", "read"] }, pattern: { type: "string", maxLength: 500 },
    path: { type: "string" }, mode: { type: "string", enum: ["literal", "regex"], default: "literal" },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 },
  }, required: ["operation"] },
  async execute(args, ctx): Promise<ToolOutput> {
    const start = Date.now();
    try {
      const a = args;
      if (!a || !["find", "search", "read"].includes(a.operation) || Object.keys(a).some(k => !["operation", "pattern", "path", "mode", "offset", "limit"].includes(k))) throw new Error("invalid_args: operation 必须为 find/search/read");
      const read = a.operation === "read";
      const max = read ? CODE_LIMITS.readMax : CODE_LIMITS[a.operation as "find" | "search"];
      const limit = a.limit ?? (read ? CODE_LIMITS.read : max);
      const offset = a.offset ?? (read ? 1 : 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > max || !Number.isInteger(offset) || offset < (read ? 1 : 0) || offset > 100000) throw new Error("invalid_args: offset/limit 超出范围");
      if (a.path !== undefined && (typeof a.path !== "string" || !a.path.trim())) throw new Error("invalid_args: path 必须为非空相对路径");
      if (read ? (!a.path || a.pattern !== undefined || a.mode !== undefined) : (typeof a.pattern !== "string" || !a.pattern.length || a.pattern.length > 500)) throw new Error("invalid_args: read 需要 path；find/search 需要 pattern");
      if (a.pattern && /[\r\n\0]/.test(a.pattern)) throw new Error("invalid_args: pattern 不接受换行或 NUL，请分别搜索或显式使用 regex 的或表达式。");
      if (a.mode !== undefined && (a.operation !== "search" || !["literal", "regex"].includes(a.mode))) throw new Error("invalid_args: mode 仅用于 search");
      if (!process.env.DCS_SOURCE_ROOT) throw new Error("unavailable: 未配置 DCS_SOURCE_ROOT");
      const root = await fs.realpath(process.env.DCS_SOURCE_ROOT);
      const rel = a.path?.replace(/\\/g, "/");
      const scope = rel ? await checked(root, rel, (await fs.stat(path.resolve(root, rel))).isFile()) : root;
      const items: Array<Record<string, unknown>> = [];
      let hasMore = false, incomplete = false, shortened = false, scanned = 0;
      if (read) {
        const stat = await fs.stat(scope);
        if (!stat.isFile()) throw new Error("invalid_args: read 需要文件路径");
        if (stat.size > CODE_LIMITS.bytes) throw new Error("invalid_args: 文件超过读取大小上限");
        if (/\.(config|json|xml)$/i.test(rel!)) throw new Error("forbidden: 配置文件内容不向模型暴露");
        const lines = safeLines(await fs.readFile(scope, "utf8"));
        for (let n = offset; n <= lines.length && items.length < limit; n++) {
          const text = safeLine(lines[n - 1]); shortened ||= text.length > CODE_LIMITS.lineChars;
          items.push({ path: rel, line: n, text: text.slice(0, CODE_LIMITS.lineChars) });
        }
        hasMore = offset - 1 + items.length < lines.length;
      } else {
        const roots = rel ? [scope] : (await Promise.all(PROJECTS.map(async project => {
          try { return await checked(root, project, false); } catch { return undefined; }
        }))).filter((p): p is string => p !== undefined);
        if (!roots.length) throw new Error("unavailable: 源码根目录没有可访问的白名单项目。");
        const listing = await rg(["--files", "--hidden", "--no-ignore", "--sort", "path", ...[...BLOCKED].flatMap(d => ["--iglob", `!**/${d}/**`]), "--", ...roots], root, CODE_LIMITS.timeoutMs, ctx.holder?.controller.signal);
        let files = listing.split(/\r?\n/).filter(Boolean).map(f => path.relative(root, path.resolve(root, f)).replace(/\\/g, "/")).filter(f => allowed(f, true)).sort();
        const glob = a.operation === "find" ? a.pattern!.replace(/\\/g, "/") : undefined;
        if (glob) files = files.filter(file => matchesGlob(glob.includes("/") ? file : path.posix.basename(file), glob));
        incomplete = files.length > CODE_LIMITS.files;
        files = files.slice(0, CODE_LIMITS.files);
        let skip = offset;
        // glob 只用于匹配文件列表，永不成为 shell 或 rg 选项。
        const checkedDirectories = new Set<string>();
        const accept = (item: Record<string, unknown>) => {
          if (skip-- > 0) return;
          items.push(item);
          if (items.length > limit) { hasMore = true; items.pop(); }
        };
        for (let index = 0; index < files.length && !hasMore; index += 64) {
          if (Date.now() - start >= CODE_LIMITS.timeoutMs) { incomplete = true; break; }
          const batch: string[] = [];
          for (const file of files.slice(index, index + 64)) {
            if (Date.now() - start >= CODE_LIMITS.timeoutMs) { incomplete = true; break; }
            let full: string;
            try { full = await checked(root, file, true, checkedDirectories); } catch { incomplete = true; continue; }
            scanned++;
            if (glob) {
              accept({ path: file });
              if (hasMore) break;
            } else {
              if (/\.(config|json|xml)$/i.test(file)) continue;
              if ((await fs.stat(full)).size > CODE_LIMITS.bytes) { incomplete = true; continue; }
              batch.push(full);
            }
          }
          if (!batch.length) continue;
          const output = await rg(["--json", "--sort", "path", "--ignore-case", "--max-count", String(offset + limit + 1),
            ...(a.mode !== "regex" ? ["--fixed-strings"] : []), "-e", a.pattern!, "--", ...batch],
            root, CODE_LIMITS.timeoutMs - (Date.now() - start), ctx.holder?.controller.signal);
          const redacted = new Map<string, string[]>();
          for (const line of output.split("\n").filter(Boolean)) {
            const event = JSON.parse(line);
            if (event.type !== "match") continue;
            const hitFile = event.data.path.text as string;
            if (!redacted.has(hitFile)) redacted.set(hitFile, safeLines(await fs.readFile(hitFile, "utf8")));
            const text = redacted.get(hitFile)![event.data.line_number - 1] ?? "[文件已变更，请重试]";
            shortened ||= text.length > CODE_LIMITS.lineChars;
            accept({ path: path.relative(root, event.data.path.text).replace(/\\/g, "/"), line: event.data.line_number, text: text.slice(0, CODE_LIMITS.lineChars) });
            if (hasMore) break;
          }
        }
      }
      while (JSON.stringify(items).length > CODE_LIMITS.chars - 1000) { items.pop(); hasMore = true; }
      const result = { status: items.length ? "success" : "empty", operation: a.operation, items,
        count: items.length, hasMore: hasMore || incomplete, truncated: hasMore || incomplete || shortened,
        incomplete, nextOffset: hasMore && !incomplete ? offset + items.length : undefined,
        message: incomplete ? "扫描未完成，请缩小 path；不能将空结果视为不存在。" : undefined };
      return { output: JSON.stringify(result), details: { scannedFiles: scanned, hitCount: items.length, truncated: result.truncated, empty: !items.length } };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const message = err.code === "ENOENT" ? "指定文件或目录不存在。" :
        /^(invalid_args|forbidden|unavailable):/.test(err.message) ? err.message : "源码查询失败：检查路径、正则表达式、扫描超时或输出上限。";
      return { output: JSON.stringify({ status: "error", message }), isError: true };
    }
  },
};
