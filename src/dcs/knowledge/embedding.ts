/**
 * dcs/knowledge/embedding.ts — 集团 Embedding 接口客户端（OpenAI 兼容格式）。
 *
 * 请求：POST DCS_EMBEDDING_URL（完整 URL，代码不追加 /v1/embeddings）
 *   { "model": "Qwen3-Embedding-8B", "input": ["片段一", ...], "encoding_format": "float" }
 * 响应：{ "data": [{ "index": 0, "embedding": [...] }, ...], "model": ..., "usage": ... }
 *
 * 校验（方案 §四）：
 * - 按 data[].index 对应输入片段（不假设返回顺序一致）；
 * - 返回数量 === 输入数量；index 范围合法且无重复；每条维度一致；
 * - 数值必须为有限数；首条响应探测实际维度（不硬编码，初版不传 dimensions）；
 * - 文档与问题使用同一模型；文档向量只在导入时生成，提问时只向量化问题。
 *
 * 超时：fetchWithTimeout 覆盖"发起请求 + 读取响应正文"全过程（不是收到
 * 响应头就清计时器）；AbortSignal.any 与 Run 取消信号合并。
 */
import type { KnowledgeConfig } from "./config.ts";

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** 超时覆盖正文读取：响应头到达后仍由 signal 管辖 body 消费。 */
export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  runSignal?: AbortSignal
): Promise<unknown> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const anyFn = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  const signals = [timeoutController.signal, runSignal].filter(Boolean) as AbortSignal[];
  const signal = signals.length > 1 && anyFn ? anyFn.call(AbortSignal, signals) : signals[0];
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    clearTimeout(timer);
    if (runSignal?.aborted) throw new EmbeddingError("请求已取消（当前运行已中止）");
    if (signal?.aborted) throw new EmbeddingError(`接口超时（>${timeoutMs}ms）：${url}`);
    throw new EmbeddingError(`接口连接失败：${String(err).slice(0, 200)}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = "<无响应体>";
    }
    clearTimeout(timer);
    throw new EmbeddingError(`接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
  }
  try {
    // signal 在 body 读取期间仍然生效：超时/取消会中断读取
    return await response.json();
  } catch (err) {
    if (runSignal?.aborted) throw new EmbeddingError("请求已取消（当前运行已中止）");
    if (signal?.aborted) throw new EmbeddingError(`接口超时（读取响应正文中断，>${timeoutMs}ms）`);
    throw new EmbeddingError(`接口响应不是合法 JSON：${String(err).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

interface EmbeddingResponse {
  data?: { index?: unknown; embedding?: unknown }[];
  model?: unknown;
  error?: { message?: unknown };
}

export interface EmbedBatchResult {
  /** 与输入顺序一致的向量数组。 */
  vectors: number[][];
  /** 实际向量维度（从响应探测）。 */
  dimension: number;
}

/** 单条/批量向量化：返回与输入等长、按 index 对位的向量数组。 */
export async function embedBatch(
  texts: string[],
  config: Pick<KnowledgeConfig, "embeddingUrl" | "embeddingApiKey" | "embeddingModel" | "timeoutMs">,
  runSignal?: AbortSignal
): Promise<EmbedBatchResult> {
  if (texts.length === 0) return { vectors: [], dimension: 0 };
  const body = JSON.stringify({
    model: config.embeddingModel,
    input: texts,
    encoding_format: "float",
  });
  const payload = (await fetchJsonWithTimeout(
    config.embeddingUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 密钥只进请求头，不进日志与错误信息
        Authorization: `Bearer ${config.embeddingApiKey}`,
      },
      body,
    },
    config.timeoutMs,
    runSignal
  )) as EmbeddingResponse;

  if (payload.error?.message) {
    throw new EmbeddingError(`Embedding 接口业务错误：${String(payload.error.message).slice(0, 200)}`);
  }
  const data = Array.isArray(payload.data) ? payload.data : null;
  if (!data || data.length !== texts.length) {
    throw new EmbeddingError(
      `Embedding 响应数量不符：期望 ${texts.length} 条，实际 ${data ? data.length : 0} 条`
    );
  }
  const vectors: number[][] = new Array(texts.length);
  let dimension = 0;
  const seen = new Set<number>();
  for (const item of data) {
    const idx = typeof item.index === "number" ? item.index : -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= texts.length) {
      throw new EmbeddingError(`Embedding 响应 index 越界：${String(item.index)}`);
    }
    if (seen.has(idx)) {
      throw new EmbeddingError(`Embedding 响应 index 重复：${idx}`);
    }
    seen.add(idx);
    const emb = item.embedding;
    if (!Array.isArray(emb) || emb.length === 0) {
      throw new EmbeddingError(`Embedding 响应第 ${idx} 条无向量`);
    }
    if (dimension === 0) dimension = emb.length;
    if (emb.length !== dimension) {
      throw new EmbeddingError(`Embedding 维度不一致：第 ${idx} 条 ${emb.length}，前条 ${dimension}`);
    }
    for (const v of emb) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new EmbeddingError(`Embedding 向量含非法数值（第 ${idx} 条）`);
      }
    }
    vectors[idx] = emb as number[];
  }
  return { vectors, dimension };
}
