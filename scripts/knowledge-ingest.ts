/**
 * scripts/knowledge-ingest.ts — 知识库导入/更新入口。
 *
 * 运行：npm run knowledge:ingest
 * 行为：扫描 KNOWLEDGE_DIR（默认 knowledge/documents）下 Markdown/TXT/DOCX/PDF，
 * 增量同步到本地 LanceDB（新增/跳过未变/替换已改/移除已删），单文件失败保留旧版本。
 *
 * 未配置 DCS_EMBEDDING_URL / DCS_EMBEDDING_API_KEY 时报告并退出码 1（不发起任何请求）。
 */
import { loadEnvLocal } from "../src/dcs/env-local.ts";
import { ingestFromEnv } from "../src/dcs/knowledge/ingest.ts";

loadEnvLocal();

async function main(): Promise<void> {
  console.log("========== DCS 知识库导入 ==========");
  console.log("资料目录：KNOWLEDGE_DIR（默认 ./knowledge/documents）");
  console.log("索引目录：KNOWLEDGE_INDEX_DIR（默认 ./data/knowledge）");
  const report = await ingestFromEnv();

  if (report.added.length > 0) {
    console.log(`\n[新增] ${report.added.length} 个文件：`);
    for (const f of report.added) console.log(`  + ${f}`);
  }
  if (report.updated.length > 0) {
    console.log(`\n[更新] ${report.updated.length} 个文件：`);
    for (const f of report.updated) console.log(`  ~ ${f}`);
  }
  if (report.skipped.length > 0) {
    console.log(`\n[未变化跳过] ${report.skipped.length} 个文件：${report.skipped.join("、")}`);
  }
  if (report.removed.length > 0) {
    console.log(`\n[已删除同步移除] ${report.removed.length} 个文件：`);
    for (const f of report.removed) console.log(`  - ${f}`);
  }
  if (report.failed.length > 0) {
    console.log(`\n[失败] ${report.failed.length} 项（该文件保留此前可用版本）：`);
    for (const f of report.failed) console.log(`  ✗ ${f.file}：${f.reason}`);
  }
  console.log(`\n索引分块总数：${report.totalChunks}`);
  if (report.failed.length > 0) {
    console.log("\n导入完成（有失败项，退出码 1）");
    process.exit(1);
  }
  console.log("\n导入完成（全部成功）");
  process.exit(0);
}

void main();
