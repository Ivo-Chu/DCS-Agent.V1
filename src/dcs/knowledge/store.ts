/**
 * dcs/knowledge/store.ts — LanceDB 本地向量存储与检索。
 *
 * 目录结构（KNOWLEDGE_INDEX_DIR，默认 data/knowledge）：
 *   knowledge.lance/     LanceDB 表（分块原文 + 向量 + 出处）
 *   index-meta.json      索引配置（embedding 模型 / 实际维度 / 分块规则版本）
 *   import-state.json    导入清单（relativePath → 文件哈希 / documentId / 分块数）
 *
 * 检索：初版余弦相似度——写入与查询向量统一归一化，归一化向量的 L2 排序
 * 与余弦排序等价；小规模知识库直接精确检索，不做近似索引调优。
 *
 * 配置不匹配（换模型/维度/分块规则）→ 打开时抛 StoreError 要求重建，
 * 绝不混用不兼容向量。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { connect, makeArrowTable, type Connection, type Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import { CHUNKING_VERSION } from "./chunk.ts";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** 索引内分块记录（写入 LanceDB 的行结构）。 */
export interface StoredChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  relativePath: string;
  section: string | null;
  page: number | null;
  chunkIndex: number;
  content: string;
  contentHash: string;
  /** 已归一化的向量。 */
  vector: number[];
}

/** 索引配置（持久化，打开时校验）。 */
export interface IndexMeta {
  embeddingModel: string;
  dimension: number;
  chunkingVersion: number;
  updatedAt: string;
}

/** 单文件导入状态。 */
export interface ImportState {
  fileHash: string;
  documentId: string;
  documentTitle: string;
  chunkCount: number;
  importedAt: string;
}

export type ImportStates = Record<string, ImportState>;

const TABLE_NAME = "knowledge_chunks";
const META_FILE = "index-meta.json";
const STATE_FILE = "import-state.json";

/** L2 归一化（归一化后 L2 排序 ≡ 余弦排序）。 */
export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) throw new StoreError("向量范数非法（全零或含非法值）");
  return vec.map((v) => v / norm);
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 显式 Arrow schema（null 字段无法类型推断，必须显式声明）：
 * section/page 可空；vector 为 FixedSizeList<float32>(dim)。
 */
function chunkSchema(dimension: number): Schema {
  return new Schema([
    new Field("chunkId", new Utf8(), true),
    new Field("documentId", new Utf8(), true),
    new Field("documentTitle", new Utf8(), true),
    new Field("relativePath", new Utf8(), true),
    new Field("section", new Utf8(), true),
    new Field("page", new Int32(), true),
    new Field("chunkIndex", new Int32(), true),
    new Field("content", new Utf8(), true),
    new Field("contentHash", new Utf8(), true),
    new Field("vector", new FixedSizeList(dimension, new Field("item", new Float32())), false),
  ]);
}

function toArrowTable(chunks: StoredChunk[], dimension: number) {
  return makeArrowTable(
    chunks.map((c) => ({ ...c })) as unknown as Array<Record<string, unknown>>,
    { schema: chunkSchema(dimension) }
  );
}

export class KnowledgeStore {
  private constructor(
    readonly indexDir: string,
    private readonly db: Connection,
    private readonly table: Table,
    readonly meta: IndexMeta
  ) {}

  /**
   * 打开（或校验现有）索引。
   * expectMeta.dimension <= 0 表示"维度未知，不校验"（导入入口只锁定模型与分块版本）；
   * 检索入口必须传入实际期望维度（来自配置或探测）以严格校验。
   */
  static async open(indexDir: string, expectMeta: { embeddingModel: string; dimension: number }): Promise<KnowledgeStore> {
    fs.mkdirSync(indexDir, { recursive: true });
    const metaPath = path.join(indexDir, META_FILE);
    const db = await connect(indexDir);
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) {
      // 已有索引：校验配置兼容性，不混用不兼容向量
      let existing: IndexMeta | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(metaPath, "utf8")) as IndexMeta;
      } catch {
        existing = null;
      }
      const dimMismatch =
        expectMeta.dimension > 0 && existing !== null && existing.dimension !== expectMeta.dimension;
      if (
        !existing ||
        existing.embeddingModel !== expectMeta.embeddingModel ||
        dimMismatch ||
        existing.chunkingVersion !== CHUNKING_VERSION
      ) {
        throw new StoreError(
          `索引配置不匹配：现有 ${existing ? `${existing.embeddingModel}/dim=${existing.dimension}/chunkV${existing.chunkingVersion}` : "（元数据缺失）"}` +
            `，期望 ${expectMeta.embeddingModel}/dim=${expectMeta.dimension}/chunkV${CHUNKING_VERSION}。` +
            `请删除索引目录（${indexDir}）后重新执行导入以重建。`
        );
      }
      const table = await db.openTable(TABLE_NAME);
      return new KnowledgeStore(indexDir, db, table, existing);
    }
    throw new StoreError(
      `索引不存在或为空（${indexDir}）。请先执行导入：npm run knowledge:ingest`
    );
  }

  /** 创建新索引（首次导入有分块时调用）。 */
  static async create(
    indexDir: string,
    meta: { embeddingModel: string; dimension: number },
    initialChunks: StoredChunk[]
  ): Promise<KnowledgeStore> {
    fs.mkdirSync(indexDir, { recursive: true });
    if (initialChunks.length === 0) {
      throw new StoreError("初始分块为空，不创建索引");
    }
    const db = await connect(indexDir);
    const table = await db.createTable(TABLE_NAME, toArrowTable(initialChunks, meta.dimension), {
      mode: "overwrite",
    });
    const full: IndexMeta = {
      embeddingModel: meta.embeddingModel,
      dimension: meta.dimension,
      chunkingVersion: CHUNKING_VERSION,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(indexDir, META_FILE), JSON.stringify(full, null, 2), "utf8");
    return new KnowledgeStore(indexDir, db, table, full);
  }

  /** 追加分块（导入更新用；沿用索引 schema，null 字段类型显式）。 */
  async addChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length > 0) await this.table.add(toArrowTable(chunks, this.meta.dimension));
  }

  /** 删除某文档全部分块。 */
  async deleteDocument(documentId: string): Promise<void> {
    await this.table.delete(`documentId = '${documentId.replace(/'/g, "''")}'`);
  }

  /**
   * 清单外的孤儿 documentId（审查修复 1：此前"删除旧版失败"的残留）。
   * 读取全表 documentId 去重——小规模知识库（万级分块）足够。
   */
  async findOrphanDocumentIds(liveDocumentIds: Set<string>): Promise<string[]> {
    const rows = (await this.table
      .query()
      .select(["documentId"])
      .limit(1_000_000)
      .toArray()) as unknown as Array<{ documentId: string }>;
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.documentId && !liveDocumentIds.has(r.documentId)) seen.add(r.documentId);
    }
    return [...seen];
  }

  /** 余弦检索（归一化向量 + cosine 距离，双保险等价）：返回最相关候选。 */
  async search(queryVector: number[], limit: number): Promise<Array<StoredChunk & { _distance: number }>> {
    const qv = normalize(queryVector);
    const rows = (await this.table
      .query()
      .nearestTo(qv)
      .distanceType("cosine")
      .limit(limit)
      .toArray()) as unknown as Array<StoredChunk & { _distance: number }>;
    return rows;
  }

  /** 当前索引内全部分块数（诊断用）。 */
  async count(): Promise<number> {
    return this.table.countRows();
  }

  // ---- 导入清单（import-state.json） ----

  loadImportStates(): ImportStates {
    const p = path.join(this.indexDir, STATE_FILE);
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as ImportStates;
    } catch {
      return {};
    }
  }

  saveImportStates(states: ImportStates): void {
    fs.writeFileSync(path.join(this.indexDir, STATE_FILE), JSON.stringify(states, null, 2), "utf8");
  }
}

/** 判断索引是否存在（工具运行时的门控：无索引 → 正常空结果说明）。 */
export function indexExists(indexDir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(indexDir, META_FILE)) &&
      fs.existsSync(path.join(indexDir, `${TABLE_NAME}.lance`))
    );
  } catch {
    return false;
  }
}
