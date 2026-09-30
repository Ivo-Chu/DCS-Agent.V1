/**
 * dcs/knowledge/ingest.ts — 资料导入与增量同步。
 *
 * 流程（方案 §五，可重复执行）：
 *   扫描 KNOWLEDGE_DIR 下支持类型文件（不递归子目录、不扫工作区）
 *   → 新文件：提取正文 → 分块 → 批量集团 Embedding → 入库
 *   → 未变化（文件哈希一致）：跳过
 *   → 已修改：新内容全部向量化成功后，替换旧分块（先全量准备、后删除旧+写入新）
 *   → 已删除：同步移除对应分块
 *   → 单文件失败：保留此前可用版本，报告失败（不出现半新半旧）
 *
 * 索引配置（模型/维度/分块规则）在首次创建时固化；打开已有索引时校验，
 * 不匹配即报错要求重建。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getKnowledgeConfig, type KnowledgeConfig } from "./config.ts";
import { extractText, isSupportedFile, toPages, ExtractError } from "./extract.ts";
import { chunkPages, embeddingText, type RawChunk } from "./chunk.ts";
import { embedBatch, EmbeddingError } from "./embedding.ts";
import { KnowledgeStore, sha256, normalize, type StoredChunk, type ImportStates } from "./store.ts";

export interface IngestReport {
  added: string[];
  updated: string[];
  skipped: string[];
  removed: string[];
  failed: Array<{ file: string; reason: string }>;
  /** 非致命提示：旧版删除失败的孤儿清理、删除重试等（不影响导入正确性）。 */
  warnings: string[];
  totalChunks: number;
}

function fileHash(absPath: string): string {
  return sha256(fs.readFileSync(absPath));
}

function documentIdFor(relativePath: string, fileHashValue: string): string {
  return `${relativePath}::${fileHashValue.slice(0, 12)}`;
}

/** 文档标题：文件名去扩展名。 */
function titleFor(relativePath: string): string {
  return path.basename(relativePath, path.extname(relativePath));
}

/** 批量向量化（按 embedBatchSize 分批），返回归一化向量与探测维度。 */
async function embedAll(
  texts: string[],
  config: KnowledgeConfig
): Promise<{ vectors: number[][]; dimension: number }> {
  const all: number[][] = [];
  let dimension = 0;
  for (let i = 0; i < texts.length; i += config.embedBatchSize) {
    const batch = texts.slice(i, i + config.embedBatchSize);
    const { vectors, dimension: dim } = await embedBatch(batch, config);
    if (dimension === 0) dimension = dim;
    if (dim !== dimension) {
      throw new EmbeddingError(`Embedding 批次维度不一致：${dim} vs ${dimension}`);
    }
    all.push(...vectors);
  }
  return { vectors: all.map(normalize), dimension };
}

export async function runIngest(config: KnowledgeConfig): Promise<IngestReport> {
  const report: IngestReport = { added: [], updated: [], skipped: [], removed: [], failed: [], warnings: [], totalChunks: 0 };
  const dirAbs = path.resolve(config.knowledgeDir);
  if (!fs.existsSync(dirAbs)) {
    fs.mkdirSync(dirAbs, { recursive: true });
    report.failed.push({ file: config.knowledgeDir, reason: "资料目录不存在（已创建空目录，请放入文档后重新导入）" });
    return report;
  }

  // 扫描支持类型（不递归）
  const files = fs
    .readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => e.isFile() && isSupportedFile(e.name))
    .map((e) => e.name)
    .sort();

  // 不支持的扩展名单列（提示但不计入失败——用户可见性优先）
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".doc")) {
      report.failed.push({ file: entry.name, reason: "暂不支持旧版 .doc，请转存为 .docx 后再导入" });
    }
  }

  // 打开已有索引（可能不存在）；导入状态独立于索引存在
  let store: KnowledgeStore | null = null;
  let states: ImportStates = {};
  const indexDirAbs = path.resolve(config.indexDir);
  try {
    store = await KnowledgeStore.open(indexDirAbs, {
      embeddingModel: config.embeddingModel,
      dimension: 0, // 维度由已有元数据校验（open 时不比较 0）
    });
    states = store.loadImportStates();
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg.includes("索引配置不匹配")) {
      // 配置不兼容：直接终止，不混用向量（方案 §五硬性要求）
      throw err;
    }
    store = null; // 索引不存在：首次导入路径
  }

  const nextStates: ImportStates = { ...states };

  // 1) 已删除文件：移除分块与状态
  for (const [rel, st] of Object.entries(states)) {
    if (!files.includes(rel)) {
      if (store) {
        await store.deleteDocument(st.documentId);
      }
      delete nextStates[rel];
      report.removed.push(rel);
    }
  }

  // 2) 逐文件处理（新增/更新/跳过）
  for (const name of files) {
    const abs = path.join(dirAbs, name);
    const rel = name;
    let hash: string;
    try {
      hash = fileHash(abs);
    } catch (err) {
      report.failed.push({ file: rel, reason: `读取失败：${String(err).slice(0, 150)}` });
      continue;
    }
    const prev = states[rel];
    if (prev && prev.fileHash === hash) {
      report.skipped.push(rel);
      continue;
    }

    // 提取 → 分块 → 向量化 → 原子替换（失败保留旧版本，见下）
    try {
      const extracted = await extractText(abs);
      const rawChunks: RawChunk[] = chunkPages(toPages(extracted));
      if (rawChunks.length === 0) {
        report.failed.push({ file: rel, reason: "分块后无有效内容（文档过短或全为空白）" });
        continue;
      }
      const title = titleFor(rel);
      // 审查修复 3：向量化输入 = 《标题》+ 章节 + 正文（展示仍用原文）
      const { vectors, dimension } = await embedAll(
        rawChunks.map((c) => embeddingText(title, c.section, c.content)),
        config
      );

      const documentId = documentIdFor(rel, hash);
      const chunks: StoredChunk[] = rawChunks.map((c, i) => ({
        chunkId: `${documentId}#${c.chunkIndex}`,
        documentId,
        documentTitle: title,
        relativePath: rel,
        section: c.section ?? null,
        page: c.page ?? null,
        chunkIndex: c.chunkIndex,
        content: c.content,
        contentHash: sha256(c.content),
        vector: vectors[i],
      }));

      if (!store) {
        // 首个文件且索引不存在 → 创建索引（固化模型与维度）
        store = await KnowledgeStore.create(
          indexDirAbs,
          { embeddingModel: config.embeddingModel, dimension },
          chunks
        );
      } else {
        // 审查修复 1：删除前显式校验维度——新旧向量必须同维，绝不混用
        if (dimension !== store.meta.dimension) {
          throw new EmbeddingError(
            `Embedding 返回维度 ${dimension} 与索引维度 ${store.meta.dimension} 不一致（模型或接口变更）。` +
              `请删除索引目录（${config.indexDir}）重建，本次跳过该文件`
          );
        }
        // 审查修复 1（原子替换）：先写新分块（新 documentId），成功后再删旧分块。
        // 写入失败 → 旧分块原封未动，仍可检索；不再出现"先删后写失败=旧资料丢失"。
        await store.addChunks(chunks);
        if (prev) {
          try {
            await store.deleteDocument(prev.documentId);
          } catch (delErr) {
            // 删除失败：新版本已生效（清单将指向新 documentId），旧分块暂成孤儿——
            // 不阻断本次导入；孤儿由循环后的 sweepOrphans 在下次导入时清理
            report.warnings.push(`${rel}：新版本已写入，但旧版本分块删除失败（${String((delErr as Error).message ?? delErr).slice(0, 120)}），将在下次导入时清理`);
          }
        }
      }
      nextStates[rel] = {
        fileHash: hash,
        documentId,
        documentTitle: title,
        chunkCount: chunks.length,
        importedAt: new Date().toISOString(),
      };
      report[prev ? "updated" : "added"].push(rel);
    } catch (err) {
      const reason =
        err instanceof ExtractError
          ? err.message
          : err instanceof EmbeddingError
            ? `向量化失败：${err.message}`
            : String((err as Error).message ?? err).slice(0, 200);
      report.failed.push({ file: rel, reason });
      // 保留旧版本：nextStates 不动（prev 仍在）；旧分块未被删除（原子替换顺序保证）
      if (prev) nextStates[rel] = prev;
    }
  }

  // 审查修复 1（清单与存储一致性）：清理孤儿分块——
  // 索引中存在但不在导入清单里的 documentId（此前"删除旧版失败"的残留）。
  if (store) {
    try {
      const orphans = await store.findOrphanDocumentIds(new Set(Object.values(nextStates).map((s) => s.documentId)));
      for (const docId of orphans) {
        await store.deleteDocument(docId);
        report.warnings.push(`已清理孤儿分块（documentId=${docId}，来自此前失败的旧版删除）`);
      }
    } catch (err) {
      report.warnings.push(`孤儿分块清理失败（不影响本次导入结果）：${String((err as Error).message ?? err).slice(0, 120)}`);
    }
  }

  if (store) {
    store.saveImportStates(nextStates);
    report.totalChunks = await store.count();
  } else if (report.failed.length === 0 && files.length === 0) {
    report.failed.push({ file: dirAbs, reason: "资料目录为空：请先放入 Markdown/TXT/DOCX/PDF 文档" });
  }
  return report;
}

/** 独立入口（scripts/knowledge-ingest.ts）使用。 */
export async function ingestFromEnv(): Promise<IngestReport> {
  const config = getKnowledgeConfig();
  if (!config) {
    const report: IngestReport = {
      added: [], updated: [], skipped: [], removed: [], warnings: [],
      failed: [{ file: "(配置)", reason: "未配置 DCS_EMBEDDING_URL / DCS_EMBEDDING_API_KEY，无法导入（密钥只进环境变量，不进仓库）" }],
      totalChunks: 0,
    };
    return report;
  }
  return runIngest(config);
}

// crypto 仅为类型清晰引入（sha256 在 store.ts 实现）
void crypto;
