/**
 * dcs/knowledge/tool.ts — search_dcs_knowledge 工具（本地 LanceDB + 集团 Embedding/Rerank）。
 *
 * 2026-09-29 方案替换：对外契约不变（工具名 / query 参数 / 输出格式 /
 * 长度限制 / 取消机制），内部从 RAGFlow HTTP 检索替换为：
 *   问题 → 集团 Embedding → LanceDB 余弦召回（候选 20）→ 集团 Rerank（前 5）
 *   → 原文片段 + 出处 → Agent 组织答案并引用出处
 *
 * 结果口径：
 * - 未配置（DCS_EMBEDDING_* 缺失）→ isError:true "能力不可用"（不注入 prompt）；
 * - 索引未建/知识库为空/无结果 → isError:false 正常"未找到/无资料"说明；
 * - Embedding 失败 → isError:true（不伪装成"没有资料"）；
 * - Rerank 失败/超时 → 降级返回向量检索结果并注明"未完成重排序"（isError:false）；
 * - 用户停止/超时 → 中止进行中的 HTTP（AbortSignal 合并 Run 信号）。
 *
 * 相关性口径：向量检索总会返回"相对最近"的结果，不能断言必然相关；
 * rerank 分数是排序依据，不是答案正确率。第一版不设通用分数门槛（真实案例校准）。
 */
import type { ToolDefinition, ToolOutput } from "../../core/types.ts";
import type { DcsToolContext } from "../session.ts";
import { getKnowledgeConfig } from "./config.ts";
import { embeddingText } from "./chunk.ts";
import { embedBatch, EmbeddingError } from "./embedding.ts";
import { rerank, RerankError } from "./rerank.ts";
import { KnowledgeStore, indexExists, type StoredChunk } from "./store.ts";

export interface SearchDcsKnowledgeArgs {
  query: string;
}

/** 单次 ToolResult 总输出上限（超出时舍弃低排名完整片段，绝不截断片段正文）。 */
export const MAX_OUTPUT_CHARS = 8000;

export interface KnowledgeSearchOutcome {
  chunks: Array<StoredChunk & { rank: number; score?: number }>;
  /** 降级说明（rerank 未完成时非空）。 */
  rerankFallbackNote?: string;
}

/** 内部检索（独立导出：离线测试直接注入 store/embedding mock）。 */
export async function searchKnowledge(
  query: string,
  deps: {
    embed: (text: string, signal?: AbortSignal) => Promise<{ vector: number[]; dimension: number }>;
    store: KnowledgeStore;
    rerankFn?: (
      query: string,
      documents: string[],
      topN: number,
      signal?: AbortSignal
    ) => Promise<{ indices: number[]; scores: number[] }>;
    candidates: number;
    topN: number;
  },
  runSignal?: AbortSignal
): Promise<KnowledgeSearchOutcome> {
  // 1) 问题向量化（提问时只向量化问题，不重算文档向量）
  const { vector, dimension } = await deps.embed(query, runSignal);

  // 2) LanceDB 余弦召回
  const rows = await deps.store.search(vector, deps.candidates);
  if (rows.length === 0) return { chunks: [] };

  // 3) 集团 Rerank：从候选中选前 N；失败/未配置 → 降级向量序
  if (!deps.rerankFn) {
    return {
      chunks: rows.slice(0, deps.topN).map((r, i) => ({ ...r, rank: i + 1 })),
      rerankFallbackNote: "本次检索未配置重排序接口，结果为向量相似度排序。",
    };
  }
  try {
    // 审查修复 3：rerank 输入同 embedding（标题+章节+正文），长章节尾部片段带上下文
    const documents = rows.map((r) => embeddingText(r.documentTitle, r.section, r.content));
    const { indices, scores } = await deps.rerankFn(query, documents, deps.topN, runSignal);
    return {
      chunks: indices.map((idx, i) => ({ ...rows[idx], rank: i + 1, score: scores[i] })),
    };
  } catch (err) {
    if (runSignal?.aborted || (err instanceof RerankError && err.message.includes("取消"))) throw err;
    // Rerank 失败/超时：不阻断检索，降级向量序并如实注明
    return {
      chunks: rows.slice(0, deps.topN).map((r, i) => ({ ...r, rank: i + 1 })),
      rerankFallbackNote: `未完成重排序（${err instanceof RerankError ? err.message : String(err).slice(0, 120)}），结果为向量相似度排序。`,
    };
  }
}

/**
 * 片段渲染：[n] 文档：《标题》 / 章节 / 页码 / 原文。
 * 审查修复 2：返回完整片段正文，绝不尾部截断——制度片段末尾常是关键限制条件
 *（如"超过截止时间不能取消"）；总长度控制由调用方按 rank 舍弃低排名片段实现。
 */
function renderChunk(c: StoredChunk & { rank: number }): string {
  const lines: string[] = [`[${c.rank}] 文档：《${c.documentTitle}》`];
  if (c.section) lines.push(`章节：${c.section}`);
  if (typeof c.page === "number") lines.push(`页码：第 ${c.page} 页`);
  lines.push(`原文：${c.content}`);
  return lines.join("\n");
}

export const searchDcsKnowledgeTool: ToolDefinition<SearchDcsKnowledgeArgs, DcsToolContext> = {
  name: "search_dcs_knowledge",
  label: "DCS知识库检索",
  description:
    "检索 DCS 知识库中的文档资料（操作手册、管理制度、通知公告、常见问题 FAQ 等）。" +
    "适合回答「怎么操作」「制度规定是什么」「某功能怎么用」类文档问题；" +
    "返回相关原文片段与文档标题及章节，回答时注明简洁出处（如：依据：《报餐操作手册》—取消报餐章节）。" +
    "查实时业务数据（报餐记录、审批状态等）请改用 query_dcs_data。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "检索关键词或问题（针对手册/制度/FAQ 的措辞检索效果最好）。",
      },
    },
    required: ["query"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const startedAt = Date.now();
    const query = String(args?.query ?? "").trim();
    if (!query) {
      return { output: "缺少检索关键词（query）。", isError: true };
    }

    const config = getKnowledgeConfig();
    if (!config) {
      return {
        output:
          "知识库检索能力当前不可用：未配置 DCS_EMBEDDING_URL / DCS_EMBEDDING_API_KEY 环境变量。",
        isError: true,
      };
    }

    // 与模型 signalProvider 同一 holder（agent-factory 注入）：Run 取消后中止检索
    const runSignal = ctx.holder?.controller?.signal;

    // 索引未建立：正常说明（不算失败——资料未导入是运营状态，不是接口故障）
    if (!indexExists(config.indexDir)) {
      return {
        output:
          "知识库当前没有已导入的资料（管理员尚未执行资料导入）。如需文档类问题的答案，请说明暂时无知识库资料；实时数据可尝试 query_dcs_data。",
        isError: false,
      };
    }

    let store: KnowledgeStore;
    try {
      store = await KnowledgeStore.open(config.indexDir, {
        embeddingModel: config.embeddingModel,
        // 检索入口：维度校验交给 embed 探测后对比（open 内部校验模型与分块版本）
        dimension: 0,
      });
    } catch (err) {
      return {
        output: `知识库索引不可用：${String((err as Error).message ?? err).slice(0, 200)}`,
        isError: true,
      };
    }

    let outcome: KnowledgeSearchOutcome;
    try {
      outcome = await searchKnowledge(
        query,
        {
          embed: async (text, signal) => {
            const { vectors, dimension } = await embedBatch(
              [text],
              {
                embeddingUrl: config.embeddingUrl,
                embeddingApiKey: config.embeddingApiKey,
                embeddingModel: config.embeddingModel,
                timeoutMs: config.timeoutMs,
              },
              signal
            );
            // 索引维度一致性校验（不混用不兼容向量）
            if (dimension !== store.meta.dimension) {
              throw new EmbeddingError(
                `Embedding 返回维度 ${dimension} 与索引维度 ${store.meta.dimension} 不一致（模型或接口变更），请重建索引`
              );
            }
            return { vector: vectors[0], dimension };
          },
          store,
          rerankFn: config.rerankUrl
            ? (q, docs, topN, signal) =>
                rerank(
                  q,
                  docs,
                  topN,
                  {
                    rerankUrl: config.rerankUrl,
                    rerankApiKey: config.rerankApiKey,
                    rerankModel: config.rerankModel,
                    timeoutMs: config.timeoutMs,
                  },
                  signal
                )
            : undefined,
          candidates: config.candidates,
          topN: config.topN,
        },
        runSignal
      );
    } catch (err) {
      if (runSignal?.aborted) {
        return { output: "知识库检索已取消（当前运行已中止）。", isError: true };
      }
      if (err instanceof EmbeddingError) {
        // 向量化失败是真实失败，不伪装成"没有资料"
        return { output: `知识库检索失败（${err.message}）。可稍后重试或改用其他工具。`, isError: true };
      }
      return {
        output: `知识库检索失败：${String((err as Error).message ?? err).slice(0, 200)}`,
        isError: true,
      };
    }

    if (outcome.chunks.length === 0) {
      return {
        output: `知识库中未找到与「${query.slice(0, 80)}」相关的资料（可换个说法再检索一次）。`,
        isError: false,
      };
    }

    // 渲染（审查修复 2）：总长度约 8000 字控制——超出时按 rank 舍弃后面的
    // 低排名【完整片段】，绝不截断片段正文（末尾常是关键限制条件）。
    // 分块上限 2000 字保证单片段可完整容纳；rank 1 无论如何完整保留。
    const header = `知识库检索「${query.slice(0, 80)}」：返回 ${outcome.chunks.length} 个片段（按相关性排序）。`;
    const footer = "回答时请基于以上原文片段，并注明出处（文档标题与章节）；片段之间冲突时如实说明。";
    const pieces = outcome.chunks.map(renderChunk);
    let used = header.length + footer.length;
    const kept: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && used + pieces[i].length + 2 > MAX_OUTPUT_CHARS) {
        kept.push(`（其余 ${pieces.length - i} 个低排名片段因总长度限制省略）`);
        break;
      }
      kept.push(pieces[i]);
      used += pieces[i].length + 2;
    }
    const parts = [header, ...kept];
    if (outcome.rerankFallbackNote) parts.push(`（${outcome.rerankFallbackNote}）`);
    parts.push(footer);
    const elapsed = Date.now() - startedAt;
    return { output: parts.join("\n\n").concat(`\n\n（检索耗时 ${elapsed}ms）`) };
  },
};
