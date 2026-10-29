import { execFile, spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { failure } from "./db/result.ts";
import { integer, resolveReadPath, sourceRoot, validKeys } from "./read-path.ts";
import { searchSourceMap } from "./source-map.ts";

interface SearchArgs { mode: "files" | "text" | "feature"; pattern: string; directory?: string; glob?: string; regex?: boolean; contextLines?: number; offset?: number; limit?: number }
interface ReadRange { path: string; startLine?: number; lineCount?: number; startColumn?: number }
interface ReadArgs { files: ReadRange[] }

const execFileAsync = promisify(execFile);
// Run 的 controller 每次替换；不把缓存或连续空结果带入下一次请求。
const searchRuns = new WeakMap<AbortSignal, { emptyStreak: number; cache: Map<string, { state: string; output: string }> }>();

/** 只核验小范围搜索，不为了复用结果扫描/哈希全库。成员枚举遵守与搜索相同的 rg ignore/glob 规则。 */
async function narrowSourceState(root: string, directory: string, glob: string | undefined, signal: AbortSignal) {
  try {
    signal.throwIfAborted();
    const args = ["--no-config", "--sort", "path", "--files", "--null", ...(glob ? ["--glob", glob] : []), "--", "."];
    const { stdout } = await execFileAsync(process.env.DCS_RG_PATH || "rg", args,
      { cwd: directory, windowsHide: true, encoding: "buffer", maxBuffer: 256 * 1024, timeout: 3000, signal });
    const members = stdout.toString("utf8").split("\0").filter(Boolean);
    if (members.length > 64) return undefined;
    const hash = createHash("sha256");
    let bytes = 0;
    for (const member of members) {
      signal.throwIfAborted();
      const file = await resolveReadPath(root, path.resolve(directory, member));
      const stat = await fs.stat(file);
      if (!stat.isFile() || bytes + stat.size > 2 * 1024 * 1024) return undefined;
      const content = await fs.readFile(file, { signal });
      bytes += content.length;
      if (bytes > 2 * 1024 * 1024) return undefined;
      hash.update(JSON.stringify([member, content.length]));
      hash.update(content);
    }
    return hash.digest("hex");
  } catch { return undefined; } // 无法完整核验时继续真实搜索，不使用缓存。
}

function invalid(field: string, actual: unknown, allowed: string, example: object) {
  return { ...failure("invalid_args", `${field}: ${allowed}`),
    output: JSON.stringify({ status: "invalid_args", field, actual: actual ?? null, allowed, example, isError: true }) };
}
export function fileKind(file: string) {
  if (/(?:App_GlobalResources|(?:^|[\\/])Resources[\\/]|\.resx$|\.Designer\.cs$|\.min\.(js|css)$)/i.test(file)) return "resource";
  return /\.(cs|cshtml|ts|tsx|js|jsx|sql|vb)$/i.test(file) ? "source" : "other";
}

export const searchDcsCodeTool: ToolDefinition<SearchArgs, DcsToolContext> = {
  name: "search_dcs_code", label: "源码搜索",
  description: `只读搜索DCS源码。feature按业务名称查已验证入口（仅mode/pattern/offset/limit），无匹配可用files/text。files按路径glob查找，跨目录示例{"mode":"files","pattern":"**/Name/Index.cshtml"}。text默认字面搜索，例如{"mode":"text","pattern":"宿舍床位统计","regex":false}；正则例如{"mode":"text","pattern":"宿舍床位统计|床位统计","regex":true}。找到目标后按返回的真实目录/文件设置directory/glob，不猜目录名称。contextLines为0–5；返回路径、行号、source/resource/other类型。资源文字不是业务实现，nextOffset续页。`,
  parameters: { type: "object", additionalProperties: false, properties: {
    mode: { type: "string", enum: ["files", "text", "feature"] }, pattern: { type: "string", minLength: 1 },
    directory: { type: "string", description: "已定位的源码相对目录；优先缩小范围，不能猜测中文目录。" },
    glob: { type: "string", description: "相对directory的文件glob；跨目录示例**/Name/Index.cshtml。" },
    regex: { type: "boolean", description: "默认false按原文字面搜索；使用|、.*等正则语法时显式传true。工具不会自动切换。" },
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
    let run = signal ? searchRuns.get(signal) : undefined;
    if (signal && !run) { run = { emptyStreak: 0, cache: new Map() }; searchRuns.set(signal, run); }
    const searchMode = a.mode === "text" ? a.regex ? "regex" : "literal" : a.mode === "files" ? "glob" : "feature";
    const literalHint = a.mode === "text" && !a.regex && /\||\.\*|\.\+|\\[dwsb]|\[.+\]|\(\?:/i.test(a.pattern)
      ? "本次按字面文字搜索；pattern含可能的正则写法。若需要正则请显式传regex:true；若确实查找这些符号可保持false。" : "";
    const searchFailure = (status: string, message: string) => {
      const result = failure(status, message);
      return { ...result, output: JSON.stringify({ ...JSON.parse(result.output), searchMode }) };
    };
    const finishSearch = (result: Record<string, any>) => {
      const empty = result.items.length === 0;
      if (run) run.emptyStreak = empty ? run.emptyStreak + 1 : 0;
      const hint = [result.hint, literalHint,
        run && run.emptyStreak >= 2 ? "已连续得到空结果，请检查字面/正则模式、业务入口及实际directory/glob，不要只重复更换关键词。" : "",
        !empty ? "已获得定位线索后，优先读取目标文件或在其实际目录内搜索；不要继续无范围全库扫描。" : ""].filter(Boolean).join(" ");
      return { output: JSON.stringify({ ...result, searchMode, hint, emptyStreak: run?.emptyStreak ?? null,
        durationMs: Date.now() - started }), details: { empty } };
    };
    try {
      signal?.throwIfAborted();
      if (a.mode === "feature") {
        const result = await searchSourceMap(a.pattern, offset, limit);
        signal?.throwIfAborted();
        return finishSearch(result);
      }
      const root = await fs.realpath(sourceRoot()), directory = await resolveReadPath(root, a.directory ?? ".");
      if (!(await fs.stat(directory)).isDirectory()) return invalid("directory", a.directory, "源码根目录内的目录", example);
      const cacheEligible = !!signal && !!a.directory && directory !== root && a.mode === "text";
      const key = JSON.stringify([root, directory, process.env.DCS_RG_PATH || "rg", a.mode, a.pattern, a.glob ?? null, !!a.regex, contextLines, offset, limit, corrections]);
      const beforeState = cacheEligible ? await narrowSourceState(root, directory, a.glob, signal!) : undefined;
      signal?.throwIfAborted();
      const cached = run?.cache.get(key);
      if (beforeState && cached?.state === beforeState) {
        return finishSearch({ ...JSON.parse(cached.output), cache: { reused: true, sourceState: beforeState, reason: "same_run_same_search_verified_content" } });
      }
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
      if (signal?.aborted) return searchFailure("cancelled", "源码搜索已取消。");
      if (timedOut) return searchFailure("timeout", "源码搜索超时，请限定目录或文件类型。");
      if (processError) throw processError;
      if (!stopped && code !== 0 && code !== 1) return searchFailure("search_error", stderr || `rg退出码：${code}`);
      const afterState = beforeState ? await narrowSourceState(root, directory, a.glob, signal!) : undefined;
      signal?.throwIfAborted();
      const reusable = !!beforeState && beforeState === afterState;
      const result = { status: items.length ? "success" : "empty", items, hasMore: stopped,
        nextOffset: stopped ? offset + items.length : null, corrections, offset, limit,
        scope: { directory: path.relative(root, directory) || ".", glob: a.glob ?? null },
        cache: { reused: false, sourceState: reusable ? beforeState : undefined,
          reason: reusable ? "verified_narrow_scope" : cacheEligible ? "scope_state_unverified_or_changed" : "reuse_requires_run_and_narrow_directory" },
        paginationUnit: a.mode === "files" ? "files" : "match_and_context_lines",
        hint: stopped ? "结果仅为当前页，使用nextOffset续读；textTruncated行可用read_dcs_code读取。" :
          !items.length ? "当前范围/页无匹配；检查pattern、directory、glob，跨目录文件glob使用**/。" : "resource仅为资源文字，需读取目标页面及实现核实业务。",
        durationMs: Date.now() - started };
      if (run && reusable) {
        if (run.cache.size >= 16) run.cache.delete(run.cache.keys().next().value!);
        run.cache.set(key, { state: beforeState!, output: JSON.stringify(result) });
      }
      return finishSearch(result);
    } catch (e) { return searchFailure(signal?.aborted ? "cancelled" : "read_error", String(e)); }
  },
};

export const readDcsCodeTool: ToolDefinition<ReadArgs, DcsToolContext> = {
  name: "read_dcs_code", label: "源码读取",
  description: "只读源码片段，可一次读取1–5个已知文件。startLine从1开始，lineCount默认80、最多200；长行可用startColumn从0续读。返回请求/实际范围、截断原因和next续读位置。hasMore只代表此文件分页，不能证明业务逻辑读全。查询条件需读完整表单及关联页面；查询范围需追踪实际过滤实现。不执行文件。",
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
        let endReason: "eof" | "line_limit" | "character_limit" = "eof";
        try {
          for await (const line of reader) {
            lineNo++;
            if (line.includes("\0")) throw new Error("不支持二进制文件。");
            if (lineNo < (f.startLine ?? 1)) continue;
            const column = lineNo === (f.startLine ?? 1) ? f.startColumn ?? 0 : 0;
            if (lines.length >= (f.lineCount ?? 80) || chars >= 12000) {
              endReason = lines.length >= (f.lineCount ?? 80) ? "line_limit" : "character_limit";
              next = { startLine: lineNo, startColumn: column }; break;
            }
            const text = line.slice(column, column + 12000 - chars);
            lines.push({ line: lineNo, column, text }); chars += text.length;
            if (column + text.length < line.length) { endReason = "character_limit"; next = { startLine: lineNo, startColumn: column + text.length }; break; }
          }
        } finally { reader.close(); input.destroy(); }
        const last = lines.at(-1);
        files.push({ path: f.path, status: "success", lines, hasMore: next !== null, next,
          requestedRange: { startLine: f.startLine ?? 1, lineCount: f.lineCount ?? 80, startColumn: f.startColumn ?? 0 },
          returnedRange: lines.length ? { startLine: lines[0].line, endLine: last!.line,
            startColumn: lines[0].column, endColumn: last!.column + last!.text.length } : null,
          endReason, coverage: "not_assessed",
          hint: "范围仅描述本次返回的文件内容；hasMore=false不是业务逻辑已读全。按问题继续读取表单、查询过滤或真实依赖，未覆盖要点应明确说明。" });
      } catch (e) { files.push({ path: f.path, status: "read_error", message: String(e) }); }
    }
    if (signal?.aborted) return failure("cancelled", "源码读取已取消。");
    return { output: JSON.stringify({ files }), isError: files.every(f => f.status !== "success") };
  },
};
