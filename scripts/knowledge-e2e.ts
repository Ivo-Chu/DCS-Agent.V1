/**
 * scripts/knowledge-e2e.ts — 真实接口 + 真实文档端到端验收（2026-09-29）。
 *
 * 前置：.env.local 已配置 DCS_EMBEDDING_*（+可选 DCS_RERANK_*），
 * 且 knowledge/documents/ 已放入业务文档并执行过 npm run knowledge:ingest。
 *
 * 验证内容（不修改用户正式资料；更新/删除用独立副本目录）：
 *   E1  Embedding 真实接口：单条+批量、数量/维度/顺序映射
 *   E2  Rerank 真实接口：候选索引与分数映射（未降级才算通过）
 *   E3  Agent 完整链路：提问 → 检索 → 重排 → 回答 → 出处（真实 DeepSeek + 真实索引）
 *   E4  同义问法 / 限制条件 / 资料不足（文档外问题应说明不足）
 *   E5  更新副本 → 重新导入 → 检索到新内容（独立目录）
 *   E6  删除副本 → 重新导入 → 不再检索到旧内容（独立目录）
 *
 * 运行：npm run knowledge:e2e（未配置时报缺什么并退出码 1，不发任何请求）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEnvLocal } from "../src/dcs/env-local.ts";

loadEnvLocal();

import { embedBatch, EmbeddingError } from "../src/dcs/knowledge/embedding.ts";
import { rerank, RerankError } from "../src/dcs/knowledge/rerank.ts";
import { getKnowledgeConfig } from "../src/dcs/knowledge/config.ts";
import { runIngest } from "../src/dcs/knowledge/ingest.ts";
import { KnowledgeStore, indexExists } from "../src/dcs/knowledge/store.ts";
import { searchDcsKnowledgeTool } from "../src/dcs/knowledge/tool.ts";
import { createDcsAgent, type DcsAgentHolder } from "../src/dcs/agent-factory.ts";
import { createMockSession } from "../src/dcs/session.ts";

let passed = 0;
let failed = 0;
const notes: string[] = [];
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
  console.log(`\n[阶段] ${t}`);
}
const mask = (s: string): string => s.slice(0, 120);

async function main(): Promise<void> {
  console.log("========== 知识库真实接口端到端验收 ==========");

  const config = getKnowledgeConfig();
  if (!config) {
    console.log("\n[跳过] 未配置 DCS_EMBEDDING_URL / DCS_EMBEDDING_API_KEY（检查 .env.local 或系统环境变量）——未发起任何请求。");
    process.exit(1);
  }
  console.log(`Embedding 模型：${config.embeddingModel}`);
  console.log(`Rerank：${config.rerankUrl ? `已配置（${config.rerankModel}）` : "未配置（检索将降级为向量排序，E2 无法验证）"}`);

  // ---------------- E1 Embedding 真实接口 ----------------
  section("E1. Embedding 真实接口（单条 + 批量）");
  let dim = 0;
  try {
    const t0 = Date.now();
    const single = await embedBatch(["DCS 智能服务助手功能测试"], config);
    dim = single.dimension;
    console.log(`    单条：维度=${dim}，耗时 ${Date.now() - t0}ms`);
    check("E1a 单条向量化成功且数值有效", single.vectors.length === 1 && single.vectors[0].length === dim);
    const t1 = Date.now();
    const batch = await embedBatch(["报餐管理操作手册", "权限配置说明", "系统登录常见问题"], config);
    console.log(`    批量(3)：维度=${batch.dimension}，耗时 ${Date.now() - t1}ms`);
    check("E1b 批量返回数量与输入一致", batch.vectors.length === 3);
    check("E1c 批量维度与单条一致（同模型）", batch.dimension === dim);
    check("E1d 不同文本向量不同（非恒等映射）", JSON.stringify(batch.vectors[0]) !== JSON.stringify(batch.vectors[1]));
  } catch (err) {
    check("E1 Embedding 接口调用", false, mask(err instanceof EmbeddingError ? err.message : String(err)));
    console.log("\nEmbedding 失败，后续验证中止。");
    process.exit(1);
  }

  // ---------------- E2 Rerank 真实接口 ----------------
  section("E2. Rerank 真实接口");
  let rerankVerified = false;
  if (!config.rerankUrl) {
    notes.push("Rerank 未配置：E2 跳过，后续检索为降级（向量排序）");
    console.log("    [跳过] 未配置 DCS_RERANK_URL");
  } else {
    try {
      const t0 = Date.now();
      const rr = await rerank(
        "如何取消报餐",
        ["报餐取消需要在截止时间前操作", "篮球比赛规则说明", "报餐时间窗口为工作日上午"],
        2,
        config
      );
      console.log(`    结果：indices=${JSON.stringify(rr.indices)} scores=${rr.scores.map((s) => s.toFixed(3)).join(",")}，耗时 ${Date.now() - t0}ms`);
      check("E2a Rerank 返回索引与分数且数量正确", rr.indices.length === 2 && rr.scores.length === 2);
      check("E2b 报餐相关候选排在篮球前面（语义排序有效）", rr.indices[0] !== 1, JSON.stringify(rr.indices));
      check("E2c 索引范围合法（0-2）", rr.indices.every((i) => i >= 0 && i < 3));
      rerankVerified = true;
    } catch (err) {
      check("E2 Rerank 接口调用", false, mask(err instanceof RerankError ? err.message : String(err)));
      notes.push(`Rerank 真实调用失败：${mask(err instanceof Error ? err.message : String(err))}（后续检索将降级——降级结果不算 Rerank 验证通过）`);
    }
  }

  // ---------------- E3 正式索引检索链路 ----------------
  section("E3. 正式索引检索（真实文档，只读不改动）");
  if (!indexExists(config.indexDir)) {
    console.log("    [跳过] 正式索引未建立——请先执行 npm run knowledge:ingest");
    notes.push("E3-E4 未验证：正式索引未建立");
  } else {
    const t0 = Date.now();
    const probe = await searchDcsKnowledgeTool.execute(
      { query: "报餐" },
      { session: createMockSession() }
    );
    console.log(`    探针检索耗时 ${Date.now() - t0}ms，输出长度 ${probe.output.length}`);
    check("E3a 检索返回内容（非不可用错误）", !probe.output.includes("不可用"), mask(probe.output));
    if (probe.output.includes("尚未")) {
      console.log("    [提示] 索引为空——请确认已执行导入并放入文档");
      notes.push("E3 检索提示无已导入资料");
    } else if (probe.output.includes("未完成重排序") || probe.output.includes("未配置重排序")) {
      notes.push("E3 检索发生降级（见输出注明）");
    }
    console.log("    —— 探针输出（前 500 字）——\n" + probe.output.slice(0, 500));
    if (!rerankVerified) notes.push("E3 检索走的是降级路径（Rerank 未验证通过或未配置）");

    // ---------------- E4 Agent 完整链路（真实 DeepSeek） ----------------
    section("E4. Agent 端到端：提问 → 检索 → 回答 → 出处（真实 DeepSeek）");
    if (!process.env.DEEPSEEK_API_KEY) {
      console.log("    [跳过] 未配置 DEEPSEEK_API_KEY——Agent 回答链路无法验证（检索链路已由 E3 验证）");
      notes.push("E4 未验证：缺 DEEPSEEK_API_KEY");
    } else {
      const questions = [
        "我在DCS里怎么操作报餐？请给出步骤",
        "如果错过了报餐时间还能补报吗？有什么限制条件？",
        "公司年会奖品有什么？", // 文档外问题：应说明资料不足
      ];
      const holder: DcsAgentHolder = { controller: new AbortController() };
      const agent = createDcsAgent({ session: createMockSession(), holder });
      for (const q of questions) {
        const t = Date.now();
        console.log(`\n    问：${q}`);
        try {
          const answer = await agent.prompt(q);
          const ms = Date.now() - t;
          console.log(`    答（${ms}ms）：${answer}`);
          check(`E4 回答生成成功（${ms}ms）`, answer.trim().length > 0);
        } catch (err) {
          check(`E4 回答生成`, false, mask(String(err)));
        }
      }
      notes.push("E4 答案的业务正确性需人工核对（含出处是否与文档一致、限制条件是否完整）");
    }
  }

  // ---------------- E5/E6 更新与删除（独立副本，不动正式资料） ----------------
  section("E5/E6. 更新与删除同步（独立副本目录，不动正式资料与正式索引）");
  if (dim === 0) {
    console.log("    [跳过] Embedding 未验证，无法进行");
  } else {
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-kb-e2e-"));
    const copyIndex = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-kb-e2e-idx-"));
    const copyConfig = { ...config, knowledgeDir: copyDir, indexDir: copyIndex };
    const docName = "验收副本-测试制度.md";
    const mkDoc = (body: string): void => fs.writeFileSync(path.join(copyDir, docName), body);

    // E5：导入 v1 → 更新 v2 → 检索到新内容
    mkDoc("# 测试制度\n\n## 费用标准\n\n测试条款甲：原型版本费用标准说明文字。");
    const i1 = await runIngest(copyConfig);
    check("E5a 副本导入 v1 成功", i1.added.length === 1 && i1.failed.length === 0, JSON.stringify(i1.failed));
    mkDoc("# 测试制度\n\n## 费用标准\n\n测试条款乙：修订版本费用标准说明文字，XYZAROLA 关键字。");
    const i2 = await runIngest(copyConfig);
    check("E5b 副本更新 v2 成功", i2.updated.length === 1 && i2.failed.length === 0, JSON.stringify(i2.failed));
    const q1 = await searchDcsKnowledgeTool.execute({ query: "修订版本费用标准 XYZAROLA" }, { session: createMockSession() });
    check("E5c 更新后检索到新内容（XYZAROLA 命中）", q1.output.includes("XYZAROLA"), mask(q1.output.slice(0, 200)));
    check("E5d 更新后旧内容不再返回（原型版本已替换）", !q1.output.includes("原型版本"), "");

    // E6：删除 → 重新导入 → 不再检索到
    fs.unlinkSync(path.join(copyDir, docName));
    const i3 = await runIngest(copyConfig);
    check("E6a 删除同步移除成功", i3.removed.length === 1, JSON.stringify(i3.removed));
    const q2 = await searchDcsKnowledgeTool.execute({ query: "修订版本费用标准 XYZAROLA" }, { session: createMockSession() });
    check("E6b 删除后不再检索到旧内容", q2.output.includes("未找到") || !q2.output.includes("XYZAROLA"), mask(q2.output.slice(0, 200)));

    // 清理副本
    fs.rmSync(copyDir, { recursive: true, force: true });
    fs.rmSync(copyIndex, { recursive: true, force: true });
  }

  // ---------------- 汇总 ----------------
  console.log("\n========== 验收汇总 ==========");
  console.log(`程序断言：通过 ${passed} 项，失败 ${failed} 项`);
  if (notes.length > 0) {
    console.log("注意 / 待人工核对：");
    for (const n of notes) console.log(`  - ${n}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
