/**
 * wecom/dedup.ts — Step 7：msgid 内存去重 + TTL 清理。
 *
 * 最小方案（方案 §九）：进程内 Map<msgid, timestamp>，
 * 同一 msgid 重复到达 → 直接忽略（不重复执行任何业务逻辑）。
 * 过期条目在每次写入时惰性清扫，防无限增长。
 * 不使用 Redis / 数据库 / 持久化幂等；进程重启丢失可接受。
 */
export class MsgIdDedup {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 10 * 60 * 1000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * 记录并判断是否重复。
   * @returns true 表示该 msgid 已处理过（应忽略）；false 表示首次出现。
   */
  seenBefore(msgid: string): boolean {
    if (!msgid) return false;
    this.sweep();
    if (this.seen.has(msgid)) return true;
    this.seen.set(msgid, this.now());
    return false;
  }

  /** 惰性清扫过期条目。 */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
