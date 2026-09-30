/**
 * dcs/knowledge/rerank.ts — 集团 Rerank 接口客户端。
 *
 * 请求：POST DCS_RERANK_URL（完整 URL，不追加路径）
 *   { "model": "Qwen3-Reranker-8B", "query": "...", "documents": ["候选一", ...],
 *     "top_n": 5, "return_documents": false }
 * 响应：{ "results": [{ "index": 0, "relevance_score": 0.97 }, ...], ... }
 *
 * 校验（方案 §四）：按 results[].index 找回本地候选；index 范围合法、无重复；
 * top_n 不超过候选数量；分数为有限数。接口文档"必填 prompt"与请求示例冲突，
 * 按完整请求示例实施（不额外发送 prompt），以真实响应为准。
 *
 * 失败语义：Rerank 失败/超时由调用方降级为向量检索结果（不伪装、不阻断）。
 */
import { fetchJsonWithTimeout, EmbeddingError as HttpError } from "./embedding.ts";
import type { KnowledgeConfig } from "./config.ts";

export class RerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankError";
  }
}

export interface RerankResult {
  /** 候选数组中选中的下标，按相关性降序。 */
  indices: number[];
  /** 对应 relevance_score。 */
  scores: number[];
}

export async function rerank(
  query: string,
  documents: string[],
  topN: number,
  config: Pick<KnowledgeConfig, "rerankUrl" | "rerankApiKey" | "rerankModel" | "timeoutMs">,
  runSignal?: AbortSignal
): Promise<RerankResult> {
  if (documents.length === 0) return { indices: [], scores: [] };
  const effectiveTopN = Math.min(Math.max(1, topN), documents.length);
  let payload: unknown;
  try {
    payload = await fetchJsonWithTimeout(
      config.rerankUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.rerankApiKey}`,
        },
        body: JSON.stringify({
          model: config.rerankModel,
          query,
          documents,
          top_n: effectiveTopN,
          return_documents: false,
        }),
      },
      config.timeoutMs,
      runSignal
    );
  } catch (err) {
    if (err instanceof HttpError) throw new RerankError(err.message);
    throw err;
  }
  const body = payload as { results?: { index?: unknown; relevance_score?: unknown }[]; error?: { message?: unknown } };
  if (body.error?.message) {
    throw new RerankError(`Rerank 接口业务错误：${String(body.error.message).slice(0, 200)}`);
  }
  const results = Array.isArray(body.results) ? body.results : null;
  if (!results || results.length === 0) {
    throw new RerankError("Rerank 响应无结果");
  }
  const seen = new Set<number>();
  const indices: number[] = [];
  const scores: number[] = [];
  for (const r of results) {
    const idx = typeof r.index === "number" ? r.index : -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= documents.length) {
      throw new RerankError(`Rerank 响应 index 越界：${String(r.index)}`);
    }
    if (seen.has(idx)) {
      throw new RerankError(`Rerank 响应 index 重复：${idx}`);
    }
    const score = r.relevance_score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new RerankError(`Rerank 分数非法（index=${idx}）`);
    }
    seen.add(idx);
    indices.push(idx);
    scores.push(score);
  }
  return { indices, scores };
}
