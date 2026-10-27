import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { failure } from "./db/result.ts";
import { integer, resolveReadPath, sourceRoot, validKeys } from "./read-path.ts";

interface SearchArgs { mode: "files" | "text"; pattern: string; directory?: string; glob?: string; regex?: boolean; contextLines?: number; offset?: number; limit?: number }
interface ReadRange { path: string; startLine?: number; lineCount?: number; startColumn?: number }
interface ReadArgs { files: ReadRange[] }

export const searchDcsCodeTool: ToolDefinition<SearchArgs, DcsToolContext> = {
  name: "search_dcs_code", label: "源码搜索",
  description: "只读搜索DCS源码。files按文件路径glob查找（如*AddressList*）；text按文本或正则搜索，可限定directory/glob。返回路径、行号及上下文；offset从0开始，nextOffset继续读取。无匹配不是错误。",
  parameters: { type: "object", additionalProperties: false, properties: {
    mode: { type: "string", enum: ["files", "text"] }, pattern: { type: "string", minLength: 1 },
    directory: { type: "string" }, glob: { type: "string" }, regex: { type: "boolean" },
    contextLines: { type: "integer", minimum: 0, maximum: 5 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
  }, required: ["mode", "pattern"] },
  async execute(a, ctx) {
    if (!validKeys(a, ["mode", "pattern", "directory", "glob", "regex", "contextLines", "offset", "limit"]) ||
      !["files", "text"].includes(a.mode) || typeof a.pattern !== "string" || !a.pattern ||
      (a.directory !== undefined && typeof a.directory !== "string") || (a.glob !== undefined && typeof a.glob !== "string") ||
      (a.regex !== undefined && typeof a.regex !== "boolean") || !integer(a.contextLines ?? 2, 0, 5) ||
      !integer(a.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) || !integer(a.limit ?? 30, 1, 100) ||
      (a.mode === "files" && (a.regex !== undefined || a.contextLines !== undefined))) return failure("invalid_args", "检查搜索模式、关键词及分页参数。");
    const signal = ctx.holder?.controller.signal;
    const started = Date.now(), offset = a.offset ?? 0, limit = a.limit ?? 30;
    try {
      signal?.throwIfAborted();
      const root = await fs.realpath(sourceRoot()), directory = await resolveReadPath(root, a.directory ?? ".");
      if (!(await fs.stat(directory)).isDirectory()) return failure("invalid_args", "directory必须为目录。");
      // 不跟随目录内链接；禁用用户rg配置，模型只能提供固定选项的值。
      const args = ["--no-config", "--sort", "path", "--color", "never"];
      if (a.mode === "files") args.push("--files", "--glob", a.pattern);
      else args.push("--json", "--ignore-case", "--context", String(a.contextLines ?? 2), ...(a.regex ? [] : ["--fixed-strings"]));
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
          if (a.mode === "files") item = { path: path.relative(root, path.resolve(directory, line)) };
          else {
            const event = JSON.parse(line);
            if (!["match", "context"].includes(event.type)) continue;
            const d = event.data;
            if (!d.path?.text || d.lines?.text === undefined) continue;
            const content = d.lines.text.replace(/\r?\n$/, "");
            item = { path: path.relative(root, path.resolve(directory, d.path.text)), line: d.line_number,
              match: event.type === "match", text: content.slice(0, 1000), textTruncated: content.length > 1000 };
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
        nextOffset: stopped ? offset + items.length : null, durationMs: Date.now() - started }), details: { empty: items.length === 0 } };
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
    if (!validKeys(a, ["files"]) || !Array.isArray(a.files) || !a.files.length || a.files.length > 5 || a.files.some(f =>
      !validKeys(f, ["path", "startLine", "lineCount", "startColumn"]) || typeof f.path !== "string" || !f.path ||
      !integer(f.startLine ?? 1, 1, Number.MAX_SAFE_INTEGER) || !integer(f.lineCount ?? 80, 1, 200) || !integer(f.startColumn ?? 0, 0, Number.MAX_SAFE_INTEGER))) return failure("invalid_args", "需要1–5个文件及有效行范围。");
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
