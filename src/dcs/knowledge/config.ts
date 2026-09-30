/**
 * dcs/knowledge/config.ts — 知识库配置（本地 LanceDB + 集团 Embedding/Rerank）。
 *
 * 环境变量（2026-09-29 方案替换 RAGFlow）：
 *   KNOWLEDGE_DIR          资料目录（默认 ./knowledge/documents）
 *   KNOWLEDGE_INDEX_DIR    本地索引目录（默认 ./data/knowledge）
 *   DCS_EMBEDDING_URL      集团 Embedding 完整请求 URL（代码不追加路径）
 *   DCS_EMBEDDING_API_KEY  凭据
 *   DCS_EMBEDDING_MODEL    默认 Qwen3-Embedding-8B
 *   DCS_RERANK_URL         集团 Rerank 完整请求 URL
 *   DCS_RERANK_API_KEY     凭据（缺省复用 Embedding 凭据）
 *   DCS_RERANK_MODEL       默认 Qwen3-Reranker-8B
 *   DCS_KB_TIMEOUT_MS      单次 HTTP 超时（默认 20000，覆盖响应正文读取全过程）
 *   DCS_KB_CANDIDATES      向量召回候选数（默认 20）
 *   DCS_KB_TOP_N           rerank 返回数（默认 5）
 *   DCS_KB_EMBED_BATCH     embedding 批量大小（默认 16，接口验证后可调）
 *
 * 启用条件：DCS_EMBEDDING_URL + DCS_EMBEDDING_API_KEY 齐备。
 * 缺失 → 工具返回能力不可用（isError:true），systemPrompt 不注入知识库段。
 */
export interface KnowledgeConfig {
  knowledgeDir: string;
  indexDir: string;
  embeddingUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  rerankUrl: string;
  rerankApiKey: string;
  rerankModel: string;
  timeoutMs: number;
  candidates: number;
  topN: number;
  embedBatchSize: number;
}

export function getKnowledgeConfig(): KnowledgeConfig | null {
  const embeddingUrl = (process.env.DCS_EMBEDDING_URL ?? "").trim();
  const embeddingApiKey = (process.env.DCS_EMBEDDING_API_KEY ?? "").trim();
  // 启用门槛：Embedding 接口两项齐备（提问链路最小必需）；
  // Rerank 缺失时检索降级为纯向量召回（见 tool.ts），不因此禁用知识库。
  if (!embeddingUrl || !embeddingApiKey) return null;
  const intEnv = (key: string, fallback: number): number => {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    knowledgeDir: process.env.KNOWLEDGE_DIR ?? "knowledge/documents",
    indexDir: process.env.KNOWLEDGE_INDEX_DIR ?? "data/knowledge",
    embeddingUrl,
    embeddingApiKey,
    embeddingModel: process.env.DCS_EMBEDDING_MODEL ?? "Qwen3-Embedding-8B",
    rerankUrl: (process.env.DCS_RERANK_URL ?? "").trim(),
    rerankApiKey: (process.env.DCS_RERANK_API_KEY ?? embeddingApiKey).trim(),
    rerankModel: process.env.DCS_RERANK_MODEL ?? "Qwen3-Reranker-8B",
    timeoutMs: intEnv("DCS_KB_TIMEOUT_MS", 20_000),
    candidates: intEnv("DCS_KB_CANDIDATES", 20),
    topN: intEnv("DCS_KB_TOP_N", 5),
    embedBatchSize: intEnv("DCS_KB_EMBED_BATCH", 16),
  };
}
