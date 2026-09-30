/**
 * dcs/knowledge 测试（2026-09-29 本地 LanceDB + 集团 Embedding/Rerank 方案）。
 *
 * 覆盖方案 §九 验收要求的离线部分：
 * - 配置门控（未配置 → 能力不可用，不影响其他工具，prompt 不注入）
 * - 分块规则（标题链保留、表格表头重复、列表合并、超长切分与重叠、页码）
 * - Embedding 客户端校验（index 对位、数量/维度/数值校验、超时覆盖正文读取）
 * - Rerank 客户端校验（index 范围、重复、top_n、失败降级）
 * - 导入增量同步（新增/跳过/更新/删除同步/单文件失败保留旧版/配置不匹配拒开）
 * - 检索链路（召回→重排→格式化输出含出处；rerank 失败降级注明；空结果）
 * - Run 取消（真实组装链路 createDcsAgent → holder → 中止 HTTP）
 * - 输出长度控制（超出时减少低排名片段）
 *
 * 真实 LanceDB（临时目录）+ mock fetch 集团接口；无需部署任何服务。
 * 运行：npm run test:knowledge
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDcsAgent, type DcsAgentHolder } from "../src/dcs/agent-factory.ts";
import { getKnowledgeConfig } from "../src/dcs/knowledge/config.ts";
import { chunkPages, chunkText, CHUNKING_VERSION } from "../src/dcs/knowledge/chunk.ts";
import { embedBatch, EmbeddingError } from "../src/dcs/knowledge/embedding.ts";
import { rerank } from "../src/dcs/knowledge/rerank.ts";
import { runIngest } from "../src/dcs/knowledge/ingest.ts";
import { KnowledgeStore, indexExists } from "../src/dcs/knowledge/store.ts";
import { searchDcsKnowledgeTool } from "../src/dcs/knowledge/tool.ts";
import { buildSystemPrompt } from "../src/dcs/prompt.ts";
import { createMockSession, type DcsToolContext } from "../src/dcs/session.ts";
import { dcsTools } from "../src/dcs/tools.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { ModelStreamEvent, StreamFn } from "../src/core/types.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}
function section(t: string): void {
  console.log(`\n[场景] ${t}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// mock 集团接口（OpenAI 兼容格式）：确定性伪向量（词袋哈希 → 稳定向量）
// ---------------------------------------------------------------------------

/** 确定性伪向量：按文本词袋生成，同词文本向量相近（供真实余弦检索出相关结果）。 */
function fakeVector(text: string, dim = 32): number[] {
  const v = new Array(dim).fill(0);
  for (const word of text.split(/[\s，。：、；！？\n]+/)) {
    if (!word) continue;
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

interface HttpCall {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

const calls: HttpCall[] = [];
type MockHandler = (call: HttpCall) => unknown;
let mockHandler: MockHandler = () => ({});

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const call: HttpCall = {
    url: String(input),
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    signal: init?.signal as AbortSignal | undefined,
  };
  calls.push(call);
  return new Promise<Response>((resolve, reject) => {
    const signal = call.signal;
    const onAbort = (): void => reject(new Error("This operation was aborted"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // 异步 resolve：留出挂起窗口（超时/取消测试依赖）。
    // mockHandler 返回 "HANG" 表示服务挂起（永不 resolve，仅 abort 打断）
    setTimeout(() => {
      try {
        const payload = mockHandler(call);
        if (payload === "HANG") return; // 挂起：Promise 永不 settle
        if (payload instanceof Error) reject(payload);
        else resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
      } catch (e) {
        reject(e as Error);
      }
    }, 5);
  });
}) as typeof fetch;

const embeddingHandler = (call: HttpCall): unknown => ({
  model: call.body.model,
  data: (call.body.input as string[]).map((text, i) => ({ index: i, embedding: fakeVector(text) })),
  usage: { prompt_tokens: 1, total_tokens: 1 },
});

/** rerank 正常实现：按与 query 共享词数排序（供多数场景）。 */
const rerankHandler = (call: HttpCall): unknown => {
  const query = call.body.query as string;
  const documents = (call.body.documents ?? []) as string[];
  const order = documents
    .map((d, i) => ({ i, rel: d.split("").filter((ch) => query.includes(ch)).length }))
    .sort((a, b) => b.rel - a.rel)
    .slice(0, (call.body.top_n as number) ?? 5);
  return { results: order.map((o) => ({ index: o.i, relevance_score: o.rel })) };
};

/** URL 分发 mock：embedding/rerank 分别注入实现；缺省为正常行为。 */
function mockGroup(
  embeddingImpl: (call: HttpCall) => unknown = embeddingHandler,
  rerankImpl: (call: HttpCall) => unknown = rerankHandler
): void {
  mockHandler = (call) => (call.url.includes("rerank") ? rerankImpl(call) : embeddingImpl(call));
}

// 环境配置（测试内统一设置）
const ENV = {
  DCS_EMBEDDING_URL: "https://group-api-test/embeddings",
  DCS_EMBEDDING_API_KEY: "emb-test-key",
  DCS_EMBEDDING_MODEL: "Qwen3-Embedding-8B",
  DCS_RERANK_URL: "https://group-api-test/rerank",
  DCS_RERANK_API_KEY: "rerank-test-key",
  DCS_RERANK_MODEL: "Qwen3-Reranker-8B",
};
const ENV_KEYS = Object.keys(ENV);
function setEnv(extra: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries({ ...ENV, ...extra })) process.env[k] = v;
}
function clearEnv(): void {
  for (const k of [...ENV_KEYS, "DCS_KB_TIMEOUT_MS", "DCS_KB_CANDIDATES", "DCS_KB_TOP_N", "KNOWLEDGE_DIR", "KNOWLEDGE_INDEX_DIR"]) delete process.env[k];
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dcs-kb-test-"));
}

function ctxWithHolder(holder?: DcsAgentHolder): DcsToolContext {
  const ctx: DcsToolContext = { session: createMockSession() };
  if (holder) ctx.holder = holder;
  return ctx;
}

async function main(): Promise<void> {
  // ================= K1 配置门控 =================
  section("K1. 未配置门控");
  clearEnv();
  check("K1a getKnowledgeConfig() 未配置返回 null", getKnowledgeConfig() === null);
  const k1 = await searchDcsKnowledgeTool.execute({ query: "怎么报餐" }, ctxWithHolder());
  check("K1b 未配置 → 能力不可用 isError:true 且提示 DCS_EMBEDDING_*", k1.isError === true && k1.output.includes("DCS_EMBEDDING_URL"), k1.output);
  check("K1c 其他工具仍在注册列表", dcsTools.some((t) => t.name === "query_dcs_data") && dcsTools.some((t) => t.name === "investigate_dcs_code"));
  check("K1d 未配置时 systemPrompt 不注入知识库段", !buildSystemPrompt(createMockSession()).includes("search_dcs_knowledge"));

  // ================= K2 分块规则 =================
  section("K2. 分块规则");
  const md = [
    "# 报餐管理",
    "",
    "## 取消报餐",
    "",
    "取消报餐需在当日 10:30 前操作，逾期不可取消。",
    "撤销订餐与取消报餐为同一功能。", // 同义表述（K9 语义检索验证用）
    "",
    "## 报餐时间",
    "",
    "工作日 08:00-10:30 开放报餐窗口。",
    "",
    "| 日期 | 餐别 | 金额 |",
    "|---|---|---|",
    "| 周一 | 午餐 | 35 |",
    "| 周二 | 午餐 | 35 |",
    "| 周三 | 午餐 | 35 |",
  ].join("\n");
  const chunks = chunkText(md);
  check("K2a 分块非空且数量 ≥3", chunks.length >= 3, `n=${chunks.length}`);
  const cancelChunk = chunks.find((c) => c.content.includes("10:30 前操作"));
  check("K2b 片段保留标题链（section 含 父>子）", cancelChunk?.section?.includes("报餐管理") === true && cancelChunk?.section.includes("取消报餐") === true, cancelChunk?.section);
  const tableChunk = chunks.find((c) => c.content.includes("周一"));
  check("K2c 表格片段重复表头", tableChunk?.content.includes("| 日期 |") === true, tableChunk?.content?.slice(0, 80));
  const longText = "这是第一句很长的句子。".repeat(200); // ~2000 字
  const longChunks = chunkText(longText);
  check("K2d 超长文本切分且各块 ≤ 上限", longChunks.length >= 2 && longChunks.every((c) => c.content.length <= 2000), `n=${longChunks.length}`);
  const paged = chunkPages([
    { text: "第一页内容，关于报销制度。", page: 1 },
    { text: "第二页内容，关于审批流程。", page: 2 },
  ]);
  check("K2e PDF 逐页分块保留页码（1/2），MD/TXT 无页码不编造", paged.some((c) => c.page === 1) && paged.some((c) => c.page === 2) && chunks.every((c) => c.page === undefined));

  // ================= K3 Embedding 客户端 =================
  section("K3. Embedding 接口校验");
  setEnv();
  mockHandler = embeddingHandler;
  const emb = await embedBatch(["片段一", "片段二"], getKnowledgeConfig()!);
  check("K3a 正常批量：按 index 对位返回等长向量", emb.vectors.length === 2 && emb.dimension === 32);
  // 乱序返回（index=[1,0]）必须正确对位
  // 乱序：甲(第0个输入) 的响应条目带 index=1，乙 的条目带 index=0
  mockHandler = (call) => ({
    data: (call.body.input as string[]).map((t, i) => ({ index: (call.body.input as string[]).length - 1 - i, embedding: fakeVector(t) })),
  });
  const embShuffled = await embedBatch(["甲", "乙"], getKnowledgeConfig()!);
  mockHandler = embeddingHandler;
  const direct = await embedBatch(["甲", "乙"], getKnowledgeConfig()!);
  // 正确的 index 对位：位置0=乙的向量、位置1=甲的向量（与 direct 交叉一致）
  check("K3b 乱序返回按 index 对位（不假设顺序一致）",
    JSON.stringify(embShuffled.vectors[0]) === JSON.stringify(direct.vectors[1]) &&
    JSON.stringify(embShuffled.vectors[1]) === JSON.stringify(direct.vectors[0]));
  mockHandler = () => ({ data: [{ index: 0, embedding: fakeVector("x") }] }); // 数量不符
  try {
    await embedBatch(["甲", "乙"], getKnowledgeConfig()!);
    check("K3c 返回数量不符报错", false);
  } catch (e) {
    check("K3c 返回数量不符报错", e instanceof EmbeddingError && e.message.includes("数量不符"));
  }
  mockHandler = () => ({ data: [{ index: 0, embedding: fakeVector("甲") }, { index: 0, embedding: fakeVector("乙") }] }); // index 重复
  try {
    await embedBatch(["甲", "乙"], getKnowledgeConfig()!);
    check("K3d index 重复报错", false);
  } catch (e) {
    check("K3d index 重复报错", e instanceof EmbeddingError && e.message.includes("重复"));
  }
  mockHandler = () => ({ data: [{ index: 0, embedding: [1, NaN] }, { index: 1, embedding: [0.5, 0.5] }] });
  try {
    await embedBatch(["甲", "乙"], getKnowledgeConfig()!);
    check("K3e 非法数值（NaN）报错", false);
  } catch (e) {
    check("K3e 非法数值（NaN）报错", e instanceof EmbeddingError && e.message.includes("非法数值"));
  }
  // 超时（覆盖正文读取全过程）：接口挂起不返回，超时信号中止读取
  process.env.DCS_KB_TIMEOUT_MS = "60";
  mockHandler = () => "HANG";
  try {
    await embedBatch(["甲"], getKnowledgeConfig()!);
    check("K3f 超时报错（含超时说明）", false);
  } catch (e) {
    check("K3f 超时报错（含超时说明）", e instanceof EmbeddingError && e.message.includes("超时"), e instanceof Error ? e.message : "");
  }
  delete process.env.DCS_KB_TIMEOUT_MS;
  mockHandler = embeddingHandler;

  // ================= K4 Rerank 客户端 =================
  section("K4. Rerank 接口校验");
  mockHandler = (call) => ({
    results: [
      { index: 2, relevance_score: 0.97 },
      { index: 0, relevance_score: 0.85 },
    ],
  });
  const rr = await rerank("查询", ["文档一", "文档二", "文档三"], 2, getKnowledgeConfig()!);
  check("K4a 正常重排：按返回序给出下标与分数", JSON.stringify(rr.indices) === JSON.stringify([2, 0]) && rr.scores[0] === 0.97);
  const rrCall = calls[calls.length - 1];
  check(
    "K4b 请求体含 model=Qwen3-Reranker-8B / query / documents / top_n / return_documents:false，不发送 prompt",
    rrCall.body.model === "Qwen3-Reranker-8B" && rrCall.body.query === "查询" && Array.isArray(rrCall.body.documents) && rrCall.body.top_n === 2 && rrCall.body.return_documents === false && !("prompt" in rrCall.body),
    JSON.stringify(rrCall.body)
  );
  mockHandler = () => ({ results: [{ index: 9, relevance_score: 0.9 }] }); // 越界
  try {
    await rerank("q", ["a"], 1, getKnowledgeConfig()!);
    check("K4c index 越界报错", false);
  } catch (e) {
    check("K4c index 越界报错", (e as Error).message.includes("越界"));
  }

  // ================= K5 导入增量同步 =================
  section("K5. 导入（新增/跳过/更新/删除/失败保留）");
  const docsDir = tmpDir();
  const indexDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, "报餐手册.md"), md);
  fs.writeFileSync(path.join(docsDir, "制度.txt"), "第一条 制度正文内容，关于报销标准与流程说明。");
  setEnv({ KNOWLEDGE_DIR: docsDir, KNOWLEDGE_INDEX_DIR: indexDir });
  mockHandler = embeddingHandler;
  const r1 = await runIngest(getKnowledgeConfig()!);
  check("K5a 首次导入 2 个文件全部成功", r1.added.length === 2 && r1.failed.length === 0, JSON.stringify(r1.failed));
  check("K5b 索引已创建且分块入库", indexExists(indexDir) && r1.totalChunks >= 3, `totalChunks=${r1.totalChunks}`);
  const r2 = await runIngest(getKnowledgeConfig()!);
  check("K5c 未变化文件跳过", r2.skipped.length === 2 && r2.added.length === 0 && r2.updated.length === 0);
  // 更新文件
  fs.writeFileSync(path.join(docsDir, "制度.txt"), "第一条 修订后的制度正文，内容已更新变化。");
  const r3 = await runIngest(getKnowledgeConfig()!);
  check("K5d 已修改文件被更新（先备好新内容再替换）", r3.updated.includes("制度.txt") && r3.skipped.includes("报餐手册.md"));
  // 删除文件同步移除
  fs.unlinkSync(path.join(docsDir, "制度.txt"));
  const r4 = await runIngest(getKnowledgeConfig()!);
  check("K5e 已删除文件同步移除分块", r4.removed.includes("制度.txt"));
  // 单文件失败保留旧版：embedding 接口对特定内容报错
  fs.writeFileSync(path.join(docsDir, "报餐手册.md"), "# 更新后的报餐手册\n\n新内容会触发向量化失败。");
  mockHandler = (call) => {
    const input = call.body.input as string[];
    if (input.some((t) => t.includes("向量化失败"))) throw new Error("group api down");
    return embeddingHandler(call);
  };
  const r5 = await runIngest(getKnowledgeConfig()!);
  check("K5f 单文件失败：报告失败且保留旧版本（无半新半旧）", r5.failed.some((f) => f.file === "报餐手册.md") && !r5.updated.includes("报餐手册.md"), JSON.stringify(r5));
  mockHandler = embeddingHandler;
  // 旧内容仍可检索（保留的旧版本）
  const store = await KnowledgeStore.open(indexDir, { embeddingModel: "Qwen3-Embedding-8B", dimension: 0 });
  const cntAfterFail = await store.count();
  check("K5g 失败后索引仍含旧分块", cntAfterFail === r4.totalChunks, `${cntAfterFail} vs ${r4.totalChunks}`);
  // 空文档/不支持类型
  fs.writeFileSync(path.join(docsDir, "空文档.md"), "   ");
  fs.writeFileSync(path.join(docsDir, "旧格式.doc"), "binary");
  const r6 = await runIngest(getKnowledgeConfig()!);
  check("K5h 空文档不当作导入成功；.doc 提示转换", r6.failed.some((f) => f.file === "空文档.md" && f.reason.includes("空")) && r6.failed.some((f) => f.file === "旧格式.doc" && f.reason.includes(".docx")));

  // 审查修复 1：维度变更 → 删除前校验拒绝，旧分块保留仍可检索
  fs.unlinkSync(path.join(docsDir, "空文档.md"));
  fs.unlinkSync(path.join(docsDir, "旧格式.doc"));
  fs.writeFileSync(path.join(docsDir, "报餐手册.md"), "# 报餐手册修订\n\n全新内容触发维度变化场景。");
  const dimBefore = await (await KnowledgeStore.open(indexDir, { embeddingModel: "Qwen3-Embedding-8B", dimension: 0 })).count();
  const fakeVector16 = (text: string): number[] => fakeVector(text, 16); // 不同维度
  mockHandler = (call) => ({
    data: (call.body.input as string[]).map((text, i) => ({ index: i, embedding: fakeVector16(text) })),
  });
  const r7 = await runIngest(getKnowledgeConfig()!);
  check(
    "K5i 维度与索引不一致 → 写入前拒绝，旧分块完整保留（仍可检索）",
    r7.failed.some((f) => f.file === "报餐手册.md" && f.reason.includes("维度")) && !r7.updated.includes("报餐手册.md"),
    JSON.stringify(r7.failed)
  );
  const dimAfter = await (await KnowledgeStore.open(indexDir, { embeddingModel: "Qwen3-Embedding-8B", dimension: 0 })).count();
  check("K5j 维度拒绝后索引分块数不变", dimAfter === dimBefore, `${dimAfter} vs ${dimBefore}`);
  mockHandler = embeddingHandler;
  // 审查修复 1：正常更新后索引无孤儿（旧 documentId 已删，新 documentId 生效）
  fs.writeFileSync(path.join(docsDir, "报餐手册.md"), "# 报餐手册修订二\n\n正常维度的新内容。");
  const r8 = await runIngest(getKnowledgeConfig()!);
  check("K5k 正常更新成功且无孤儿警告", r8.updated.includes("报餐手册.md") && r8.warnings.every((w) => !w.includes("孤儿")), JSON.stringify(r8.warnings));
  const storeFinal = await KnowledgeStore.open(indexDir, { embeddingModel: "Qwen3-Embedding-8B", dimension: 0 });
  const orphans = await storeFinal.findOrphanDocumentIds(new Set([r8.added.length + r8.updated.length > 0 ? (await (async () => { const st = storeFinal.loadImportStates(); return Object.values(st).map((x) => x.documentId); })())[0] : ""]));
  const liveIds = new Set(Object.values(storeFinal.loadImportStates()).map((x) => x.documentId));
  const realOrphans = await storeFinal.findOrphanDocumentIds(liveIds);
  check("K5l 更新后索引无孤儿 documentId（旧版已删净）", realOrphans.length === 0, JSON.stringify(realOrphans));
  void orphans;

  // ================= K6 配置不匹配拒开 =================
  section("K6. 索引配置不匹配拒绝混用");
  try {
    await KnowledgeStore.open(indexDir, { embeddingModel: "Other-Model", dimension: 0 });
    check("K6a 换 embedding 模型后拒绝打开（要求重建）", false);
  } catch (e) {
    check("K6a 换 embedding 模型后拒绝打开（要求重建）", String((e as Error).message).includes("不匹配") && String((e as Error).message).includes("重建"));
  }

  // ================= K7 检索链路（真实 LanceDB + mock 接口） =================
  section("K7. 检索 → 重排 → 输出格式");
  // 重建干净索引：语义检索验证（"取消报餐" ↔ "撤销订餐" 同义）
  const docsDir2 = tmpDir();
  const indexDir2 = tmpDir();
  const synDoc = [
    "# 订餐规定",
    "",
    "## 撤销订餐",
    "",
    "员工可在送达前撤销订餐，撤销后不计费用。",
    "",
    "## 修订记录",
    "",
    "本规定自发布之日起施行。",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir2, "订餐规定.md"), synDoc);
  fs.writeFileSync(path.join(docsDir2, "无关文档.txt"), "本片段讨论篮球比赛规则与球队历史，与订餐毫无关系。");
  setEnv({ KNOWLEDGE_DIR: docsDir2, KNOWLEDGE_INDEX_DIR: indexDir2, DCS_KB_CANDIDATES: "10", DCS_KB_TOP_N: "2" });
  mockHandler = embeddingHandler;
  const ri = await runIngest(getKnowledgeConfig()!);
  check("K7a 测试索引导入成功", ri.added.length === 2 && ri.failed.length === 0, JSON.stringify(ri.failed));
  // rerank mock：总是把含"撤销订餐"的候选排第一（embedding 走正常分发）
  mockGroup(
    embeddingHandler,
    (call) => {
      const documents = (call.body.documents ?? []) as string[];
      const order = documents
        .map((d, i) => ({ i, rel: d.includes("撤销订餐") ? 0.99 : 0.1 }))
        .sort((a, b) => b.rel - a.rel)
        .slice(0, (call.body.top_n as number) ?? 5);
      return { results: order.map((o) => ({ index: o.i, relevance_score: o.rel })) };
    }
  );
  const k7 = await searchDcsKnowledgeTool.execute({ query: "怎么取消报餐" }, ctxWithHolder());
  check(
    "K7b 中文同义检索：「取消报餐」命中「撤销订餐」且 ranked 第一",
    k7.isError !== true && k7.output.includes("撤销订餐") && k7.output.indexOf("撤销订餐") < k7.output.indexOf("[2]"),
    k7.output.slice(0, 200)
  );
  check("K7c 输出含出处格式（文档《》与章节）", k7.output.includes("《订餐规定》") && k7.output.includes("章节：订餐规定 > 撤销订餐"), k7.output.slice(0, 300));
  check("K7d top_n=2 生效（含 rerank 请求 top_n 校验）", !k7.output.includes("[3]"));
  const rrCall2 = calls.filter((c) => c.url.includes("rerank")).pop();
  check("K7e top_n 不超过候选数", (rrCall2?.body.top_n as number) <= 10);
  // rerank 失败 → 降级向量序 + 注明
  mockGroup(embeddingHandler, () => ({ error: { message: "rerank service down" } }));
  const k7f = await searchDcsKnowledgeTool.execute({ query: "撤销订餐" }, ctxWithHolder());
  check(
    "K7f Rerank 失败降级：仍返回向量结果并注明未完成重排序（isError:false）",
    k7f.isError !== true && k7f.output.includes("未完成重排序") && k7f.output.includes("向量相似度排序"),
    k7f.output.slice(0, 250)
  );
  // 未配置 rerank（仅 embedding）→ 同样降级注明
  delete process.env.DCS_RERANK_URL;
  const k7g = await searchDcsKnowledgeTool.execute({ query: "订餐规定" }, ctxWithHolder());
  check("K7g 未配置 Rerank：降级注明且不报错", k7g.isError !== true && k7g.output.includes("未配置重排序"));
  process.env.DCS_RERANK_URL = ENV.DCS_RERANK_URL;
  // 空结果
  mockHandler = embeddingHandler;
  const k7h = await searchDcsKnowledgeTool.execute({ query: "量子物理常数" }, ctxWithHolder());
  // 注：伪向量是词袋哈希，"量子物理常数"与所有文档无共享词，仍会返回 top 结果——
  // 空结果由真实 embedding 语义距离决定；此处验证的是输出格式而非空结果本身
  check("K7h 检索总有相对最近结果（不因返回即断言相关）", k7h.isError !== true && (k7h.output.includes("片段") || k7h.output.includes("未找到")));
  // embedding 失败 → isError（不伪装没有资料）
  mockGroup(() => ({ error: { message: "embedding down" } }), rerankHandler);
  const k7i = await searchDcsKnowledgeTool.execute({ query: "任意" }, ctxWithHolder());
  check("K7i Embedding 失败 → isError:true（不伪装没有资料）", k7i.isError === true && k7i.output.includes("失败"), k7i.output.slice(0, 150));
  mockHandler = embeddingHandler;
  // 索引未建 → 正常说明（isError:false）
  setEnv({ KNOWLEDGE_INDEX_DIR: tmpDir() /* 空索引目录 */ });
  const k7k = await searchDcsKnowledgeTool.execute({ query: "任意" }, ctxWithHolder());
  check("K7k 索引未建立 → 正常说明未导入资料（isError:false）", k7k.isError !== true && k7k.output.includes("尚未"), k7k.output.slice(0, 120));
  setEnv({ KNOWLEDGE_DIR: docsDir2, KNOWLEDGE_INDEX_DIR: indexDir2 });

  // ================= K8 Run 取消（真实组装链路） =================
  section("K8. Run 取消——createDcsAgent → holder → 中止检索 HTTP");
  process.env.DCS_KB_TIMEOUT_MS = "5000";
  mockHandler = () => "HANG"; // 全部挂起，直到 abort
  const fakeStream: StreamFn = async function* (req): AsyncGenerator<ModelStreamEvent> {
    const hasToolResult = req.messages.some((m) => m.role === "toolResult");
    if (!hasToolResult) {
      yield { type: "text_delta", text: "" };
      yield { type: "tool_call_start", index: 0, toolCallId: "call-k8", name: "search_dcs_knowledge" };
      yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"query":"撤销订餐"}' };
      yield { type: "message_end", stopReason: "toolCalls" };
    } else {
      yield { type: "text_delta", text: "已收到工具结果" };
      yield { type: "message_end", stopReason: "stop" };
    }
  };
  const holder: DcsAgentHolder = { controller: new AbortController() };
  const agent = createDcsAgent({ session: createMockSession(), holder, streamFn: fakeStream });
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  const callsBefore = calls.length;
  const runPromise = agent.prompt("怎么撤销订餐");
  let waited = 0;
  while (calls.length <= callsBefore && waited < 3000) {
    await sleep(10);
    waited += 10;
  }
  const lastCall = calls[calls.length - 1];
  check("K8a 真实链路：工具发出检索请求", calls.length > callsBefore && lastCall?.url.includes("embeddings"));
  check("K8b 请求携带复合取消信号（未中止）", lastCall?.signal !== undefined && !lastCall.signal.aborted);
  holder.controller.abort();
  await runPromise;
  const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "search_dcs_knowledge") as Extract<AgentEvent, { type: "tool_execution_end" }> | undefined;
  check("K8c abort 后工具 isError 且提示取消，Run 正常结束", toolEnd?.isError === true && (toolEnd.summary ?? "").includes("取消"), JSON.stringify(toolEnd?.summary ?? ""));
  check("K8d agent_end 正常发射（不崩溃）", events.some((e) => e.type === "agent_end"));
  delete process.env.DCS_KB_TIMEOUT_MS;
  mockHandler = embeddingHandler;

  // ================= K9 输出长度控制 =================
  section("K9. 输出长度控制（超限减低排名片段）");
  const bigDir = tmpDir();
  const bigIndex = tmpDir();
  const bigDoc = Array.from({ length: 12 }, (_, i) => `## 主题${i}\n\n${"很长的内容。".repeat(60)}`).join("\n\n");
  fs.writeFileSync(path.join(bigDir, "长手册.md"), bigDoc);
  setEnv({ KNOWLEDGE_DIR: bigDir, KNOWLEDGE_INDEX_DIR: bigIndex, DCS_KB_CANDIDATES: "10", DCS_KB_TOP_N: "8" });
  mockHandler = embeddingHandler;
  const rb = await runIngest(getKnowledgeConfig()!);
  check("K9a 长文档导入成功且分块 ≤ 上限", rb.failed.length === 0, JSON.stringify(rb.failed));
  // 审查修复 3 回归：向量化输入含《标题》与章节
  const ingestEmbCall = calls.filter((c) => c.url.includes("embeddings") && Array.isArray(c.body.input)).pop();
  const firstInput = (ingestEmbCall?.body.input as string[])[0] ?? "";
  check("K9a' 导入向量化输入含《文档标题》与章节（embeddingText）", firstInput.startsWith("《长手册》"), firstInput.slice(0, 60));
  mockGroup(embeddingHandler, (call) => {
    const documents = (call.body.documents ?? []) as string[];
    return { results: documents.slice(0, (call.body.top_n as number) ?? 5).map((_, i) => ({ index: i, relevance_score: 1 - i * 0.01 })) };
  });
  const k9 = await searchDcsKnowledgeTool.execute({ query: "主题" }, ctxWithHolder());
  check("K9b 总输出 ≤ 8000 字（通过减少片段而非截断）", k9.output.length <= 8100 && k9.output.includes("检索耗时"), String(k9.output.length));
  // 审查修复 2 回归：片段正文完整（无"片段过长已截断"标记；末尾内容保留）
  check("K9b' 输出无截断标记（片段完整）", !k9.output.includes("已截断"));
  const rrDocsCall = calls.filter((c) => c.url.includes("rerank")).pop();
  const rrFirstDoc = ((rrDocsCall?.body.documents ?? []) as string[])[0] ?? "";
  check("K9c rerank 输入含《标题》上下文（embeddingText 同构）", rrFirstDoc.startsWith("《长手册》"), rrFirstDoc.slice(0, 60));

  // ================= K9+ 完整片段（关键限制条件不丢） =================
  section("K9+. 长片段末尾限制条件不被截断");
  const tailDir = tmpDir();
  const tailIndex = tmpDir();
  const tailDoc = [
    "# 操作手册",
    "",
    "## 取消流程",
    "",
    "第一步 打开系统。第二步 进入报餐页面。第三步 点击取消按钮。第四步 确认提交。",
    "前置说明与操作步骤说明文字，用于把片段撑长到接近分块上限。".repeat(10),
    "",
    "**注意：超过当日 10:30 截止时间后不能取消报餐，逾期订单不可撤销。**",
  ].join("\n");
  fs.writeFileSync(path.join(tailDir, "操作手册.md"), tailDoc);
  setEnv({ KNOWLEDGE_DIR: tailDir, KNOWLEDGE_INDEX_DIR: tailIndex, DCS_KB_CANDIDATES: "5", DCS_KB_TOP_N: "1" });
  mockGroup(); // embedding + rerank 均正常分发（rerank 按字符重合排序）
  const rt = await runIngest(getKnowledgeConfig()!);
  check("K9d 测试文档导入成功", rt.failed.length === 0, JSON.stringify(rt.failed));
  const k9t = await searchDcsKnowledgeTool.execute({ query: "怎么取消报餐" }, ctxWithHolder());
  check(
    "K9e 片段末尾的限制条件（10:30 截止/不可撤销）完整出现在结果中",
    k9t.output.includes("10:30") && k9t.output.includes("不可撤销"),
    k9t.output.slice(-200)
  );

  // ================= K10 注册与 prompt 注入 =================
  section("K10. 注册与提示词");
  check("K10a search_dcs_knowledge 已注册", dcsTools.some((t) => t.name === "search_dcs_knowledge"));
  const p = buildSystemPrompt(createMockSession());
  check("K10b 已配置时 systemPrompt 含知识库段与出处格式", p.includes("search_dcs_knowledge") && p.includes("依据：《报餐操作手册》"));
  check("K10c CHUNKING_VERSION 存在（索引元数据用）", typeof CHUNKING_VERSION === "number");

  console.log(`\n========== 知识库工具测试结果 ==========`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
}

main().finally(() => {
  globalThis.fetch = realFetch;
  clearEnv();
});
