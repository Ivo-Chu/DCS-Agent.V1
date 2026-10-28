import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { failure } from "./db/result.ts";
import { integer, resolveReadPath, sourceRoot, validKeys } from "./read-path.ts";
import { searchSourceMap } from "./source-map.ts";

interface SearchArgs { mode: "files" | "text" | "feature"; pattern: string; directory?: string; glob?: string; regex?: boolean; contextLines?: number; offset?: number; limit?: number }
interface ReadRange { path: string; startLine?: number; lineCount?: number; startColumn?: number }
interface ReadArgs { files: ReadRange[] }

function invalid(field: string, actual: unknown, allowed: string, example: object) {
  return { ...failure("invalid_args", `${field}: ${allowed}`),
    output: JSON.stringify({ status: "invalid_args", field, actual: actual ?? null, allowed, example, isError: true }) };
}
function fileKind(file: string) {
  if (/(?:App_GlobalResources|[\\/]Resources[\\/]|\.resx$|\.Designer\.cs$|\.min\.(js|css)$)/i.test(file)) return "resource";
  return /\.(cs|cshtml|ts|tsx|js|jsx|sql|vb)$/i.test(file) ? "source" : "other";
}

export const searchDcsCodeTool: ToolDefinition<SearchArgs, DcsToolContext> = {
  name: "search_dcs_code", label: "源码搜索",
  description: "只读搜索DCS源码。feature按业务名称查已验证入口（仅mode/pattern/offset/limit），无匹配可用files/text。files按路径glob查找，跨目录用**/Name/Index.cshtml；text按文本或正则搜索，可限定directory/glob。contextLines为0–5。返回路径、行号、source/resource/other类型；资源文本不证明页面业务逻辑。offset从0开始，nextOffset续读。",
  parameters: { type: "object", additionalProperties: false, properties: {
    mode: { type: "string", enum: ["files", "text", "feature"] }, pattern: { type: "string", minLength: 1 },
    directory: { type: "string" }, glob: { type: "string" }, regex: { type: "boolean" },
    contextLines: { type: "integer", minimum: 0, maximum: 5 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
  }, required: ["mode", "pattern"] },
  async execute(a, ctx) {
    const example = { mode: "text", pattern: "业务名称", contextLines: 2, limit: 30 };
    const keys = ["mode", "pattern", "directory", "glob", "regex", "contextLines", "offset", "limit"];
    if (!validKeys(a, keys)) return invalid("arguments", a, `对象，仅允许${keys.join(",")}`, example);
    if (!["files", "text", "feature"].includes(a.mode)) return invalid("mode", a.mode, "files | text | feature", example);
    if (typeof a.pattern !== "string" || !a.pattern.trim()) return invalid("pattern", a.pattern, "非空字符串", example);
    for (const field of ["directory", "glob"] as const) {
      if (a[field] !== undefined && typeof a[field] !== "string") return invalid(field, a[field], "字符串", example);
    }
    if (a.regex !== undefined && typeof a.regex !== "boolean") return invalid("regex", a.regex, "布尔值", example);
    if (a.mode !== "text") {
      for (const field of (a.mode === "feature" ? ["directory", "glob", "regex", "contextLines"] : ["regex", "contextLines"]) as (keyof SearchArgs)[]) {
        if (a[field] !== undefined) return invalid(field, a[field], `${a.mode}模式不接受此字段`, { mode: a.mode, pattern: "业务名称" });
      }
    }
    if (!integer(a.contextLines ?? 2, 0, Number.MAX_SAFE_INTEGER)) return invalid("contextLines", a.contextLines, "0–5的整数；非负整数超限自动取5", example);
    if (!integer(a.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)) return invalid("offset", a.offset, "非负安全整数", example);
    if (!integer(a.limit ?? 30, 1, 100)) return invalid("limit", a.limit, "1–100的整数", example);
    const contextLines = Math.min(a.contextLines ?? 2, 5);
    const corrections = (a.contextLines ?? 2) > 5 ? [{ field: "contextLines", from: a.contextLines, to: 5 }] : [];
    const signal = ctx.holder?.controller.signal;
    const started = Date.now(), offset = a.offset ?? 0, limit = a.limit ?? 30;
    try {
      signal?.throwIfAborted();
      if (a.mode === "feature") {
        const result = await searchSourceMap(a.pattern, offset, limit);
        signal?.throwIfAborted();
        return { output: JSON.stringify(result), details: { empty: result.items.length === 0 } };
      }
      const root = await fs.realpath(sourceRoot()), directory = await resolveReadPath(root, a.directory ?? ".");
      if (!(await fs.stat(directory)).isDirectory()) return invalid("directory", a.directory, "源码根目录内的目录", example);
      // 不跟随目录内链接；禁用用户rg配置，模型只能提供固定选项的值。
      const args = ["--no-config", "--sort", "path", "--color", "never"];
      if (a.mode === "files") args.push("--files", "--glob", a.pattern);
      else args.push("--json", "--ignore-case", "--context", String(contextLines), ...(a.regex ? [] : ["--fixed-strings"]));
      if (a.glob) args.push("--glob", a.glob);
      args.push("--", ...(a.mode === "text" ? [a.pattern] : []), ".");
      const child = spawn(process.env.DCS_RG_PATH || "rg", args, { cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", timedOut = false, stopped = false, seen = 0;
      let processError: Error | undefined;
      const items: unknown[] = [];
      const done = new Promise<number | null>(resolve => {
        child.on("error", e => { processError = e; });
        child.on("close", resolve);
      });
      child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(0, 4000); });
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        if (signal?.aborted) child.kill();
        for await (const line of lines) {
          let item: unknown;
          if (a.mode === "files") item = { path: path.relative(root, path.resolve(directory, line)), kind: fileKind(line) };
          else {
            const event = JSON.parse(line);
            if (!["match", "context"].includes(event.type)) continue;
            const d = event.data;
            if (!d.path?.text || d.lines?.text === undefined) continue;
            const content = d.lines.text.replace(/\r?\n$/, "");
            item = { path: path.relative(root, path.resolve(directory, d.path.text)), line: d.line_number,
              kind: fileKind(d.path.text), match: event.type === "match", text: content.slice(0, 1000), textTruncated: content.length > 1000 };
          }
          if (seen++ < offset) continue;
          if (items.length === limit) { stopped = true; child.kill(); break; }
          items.push(item);
        }
      } catch (e) { child.kill(); await done; throw e; }
      finally { lines.close(); clearTimeout(timer); signal?.removeEventListener("abort", abort); }
      const code = await done;
      if (signal?.aborted) return failure("cancelled", "源码搜索已取消。");
      if (timedOut) return failure("timeout", "源码搜索超时，请限定目录或文件类型。");
      if (processError) throw processError;
      if (!stopped && code !== 0 && code !== 1) return failure("search_error", stderr || `rg退出码：${code}`);
      return { output: JSON.stringify({ status: items.length ? "success" : "empty", items, hasMore: stopped,
        nextOffset: stopped ? offset + items.length : null, corrections, offset, limit,
        paginationUnit: a.mode === "files" ? "files" : "match_and_context_lines",
        hint: stopped ? "结果仅为当前页，使用nextOffset续读；textTruncated行可用read_dcs_code读取。" :
          !items.length ? "当前范围/页无匹配；检查pattern、directory、glob，跨目录文件glob使用**/。" : "resource仅为资源文字，需读取目标页面及实现核实业务。",
        durationMs: Date.now() - started }), details: { empty: items.length === 0 } };
    } catch (e) { return failure(signal?.aborted ? "cancelled" : "read_error", String(e)); }
  },
};

export const readDcsCodeTool: ToolDefinition<ReadArgs, DcsToolContext> = {
  name: "read_dcs_code", label: "源码读取",
  description: "只读源码片段，可一次读取1–5个已知文件。startLine从1开始，lineCount默认80；长行可用startColumn从0续读。返回带行号内容及next位置，不执行文件。",
  parameters: { type: "object", additionalProperties: false, properties: {
    files: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", additionalProperties: false, properties: {
      path: { type: "string", minLength: 1 }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 200 }, startColumn: { type: "integer", minimum: 0 },
    }, required: ["path"] } },
  }, required: ["files"] },
  async execute(a, ctx) {
    const example = { files: [{ path: "Controllers/Example.cs", startLine: 1, lineCount: 80 }] };
    if (!validKeys(a, ["files"])) return invalid("arguments", a, "仅含files的对象", example);
    if (!Array.isArray(a.files) || !a.files.length || a.files.length > 5) return invalid("files", a.files, "1–5个文件", example);
    for (const [i, f] of a.files.entries()) {
      if (!validKeys(f, ["path", "startLine", "lineCount", "startColumn"])) return invalid(`files[${i}]`, f, "仅接受path/startLine/lineCount/startColumn", example);
      if (typeof f.path !== "string" || !f.path.trim()) return invalid(`files[${i}].path`, f.path, "非空文件路径", example);
      for (const [field, min, max, fallback] of [["startLine", 1, Number.MAX_SAFE_INTEGER, 1], ["lineCount", 1, 200, 80], ["startColumn", 0, Number.MAX_SAFE_INTEGER, 0]] as const) {
        if (!integer(f[field] ?? fallback, min, max)) return invalid(`files[${i}].${field}`, f[field], `${min}–${max}的整数`, example);
      }
    }
    const signal = ctx.holder?.controller.signal;
    const files = [];
    for (const f of a.files) {
      if (signal?.aborted) return failure("cancelled", "源码读取已取消。");
      try {
        const filename = await resolveReadPath(sourceRoot(), f.path);
        if (!(await fs.stat(filename)).isFile()) throw new Error("只能读取文件。");
        const input = createReadStream(filename, { encoding: "utf8", signal });
        const reader = createInterface({ input, crlfDelay: Infinity });
        const lines = []; let lineNo = 0, chars = 0;
        let next: { startLine: number; startColumn: number } | null = null;
        try {
          for await (const line of reader) {
            lineNo++;
            if (line.includes("\0")) throw new Error("不支持二进制文件。");
            if (lineNo < (f.startLine ?? 1)) continue;
            const column = lineNo === (f.startLine ?? 1) ? f.startColumn ?? 0 : 0;
            if (lines.length >= (f.lineCount ?? 80) || chars >= 12000) { next = { startLine: lineNo, startColumn: column }; break; }
            const text = line.slice(column, column + 12000 - chars);
            lines.push({ line: lineNo, column, text }); chars += text.length;
            if (column + text.length < line.length) { next = { startLine: lineNo, startColumn: column + text.length }; break; }
          }
        } finally { reader.close(); input.destroy(); }
        files.push({ path: f.path, status: "success", lines, hasMore: next !== null, next });
      } catch (e) { files.push({ path: f.path, status: "read_error", message: String(e) }); }
    }
    if (signal?.aborted) return failure("cancelled", "源码读取已取消。");
    return { output: JSON.stringify({ files }), isError: files.every(f => f.status !== "success") };
  },
};
