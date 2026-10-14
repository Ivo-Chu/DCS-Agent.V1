/**
 * observability/jsonl-writer.ts — 结构化 JSONL 日志写入器。
 *
 * - 每次 Run 一个文件：logs/YYYY-MM-DD_HH-mm-ss_<runId>.jsonl（文件名安全处理）；
 * - 每行一个合法 JSON 对象：{ timestamp, runId, event, ... }；
 * - 内存缓冲 + fire-and-forget 落盘：写入不阻塞模型/工具关键流程；
 * - 写入失败不影响 Agent 主流程（标记 failed，后续事件仅缓冲）；
 * - 任务结束时 flush() 完成最终落盘；
 * - 仅 Node.js 原生 fs/promises，不引入日志框架。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 文件名安全字符（runId 已由 core 控制为 hex，但仍做防御性过滤）。 */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "run";
}

function fileStamp(d: Date): string {
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export class JsonlWriter {
  /** 日志文件相对项目根的展示路径（如 logs/2026-10-12_09-14-44_f7b6e907.jsonl）。 */
  readonly displayPath: string;
  private readonly absPath: string;
  private lines: string[] = [];
  private failed = false;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(logsDir: string, runId: string, startedAt: Date) {
    const fileName = `${fileStamp(startedAt)}_${safeName(runId)}.jsonl`;
    this.absPath = path.join(logsDir, fileName);
    // 展示路径统一用正斜杠（跨平台一致的日志引用）
    this.displayPath = `${path.basename(logsDir)}/${fileName}`;
  }

  /** 追加一条事件（同步入缓冲，异步落盘；任何失败不抛出）。 */
  write(record: Record<string, unknown>): void {
    if (this.failed) return;
    try {
      this.lines.push(JSON.stringify(record));
    } catch {
      // 序列化失败（循环引用等）：丢弃该条，不影响后续
      return;
    }
    // 简单策略：缓冲超过 20 条即后台落盘（run 结束时 flush 全部）
    if (this.lines.length >= 20) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(async () => {
      if (this.failed || this.lines.length === 0) return;
      const chunk = this.lines;
      this.lines = [];
      try {
        await fs.promises.mkdir(path.dirname(this.absPath), { recursive: true });
        await fs.promises.appendFile(this.absPath, chunk.join("\n") + "\n", "utf8");
      } catch {
        // 写入失败：标记失败并丢弃剩余缓冲——日志系统绝不拖垮 Agent 主流程
        this.failed = true;
        this.lines = [];
      }
    });
    return this.flushChain;
  }

  /** Run 结束时调用：完成全部落盘。失败不抛出。 */
  async flush(): Promise<void> {
    await this.scheduleFlush().catch(() => undefined);
  }
}
