/**
 * CLI 展示层的入口级验证（R3 / R4 审查修复）。
 *
 * 通过子进程启动真实 src/index.ts，注入本地假模型（test/cli-fixture.mjs，
 * 无外部请求），从终端实际输出断言：
 * - R3：模型只发工具片段且 length 截断、无文本增量时，
 *       Runtime 后补的截断说明必须显示给用户（不能是空回答）
 * - R4：模型用内部源码路径作检索关键词时，
 *       终端不得出现该路径（工具参数与结果摘要均不显示原始内容）
 *
 * 运行：npm run test:cli
 */
import { spawnSync } from "node:child_process";

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

function runCli(mode: string, input: string): { stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./test/cli-fixture.mjs", "src/index.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CLI_PROBE: mode, DEEPSEEK_API_KEY: "cli-display-fixture" },
      input,
      encoding: "utf8",
      timeout: 30000,
    }
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

console.log("[场景] L. CLI 展示层（R3：后补文本显示 / R4：内部路径不露出）");

{
  // R3：length 截断且无文本增量 → 终端必须显示截断说明
  const { stdout } = runCli("length", "查权限\nexit\n");
  check("L1 length 截断说明显示到终端（非空回答）", stdout.includes("截断"), stdout.trim().slice(0, 200));
  // F2 设计：截断的残缺工具调用被剥离、不执行——入口级确认无工具执行日志
  check("L2 截断的残缺工具未执行（无工具执行日志）", !stdout.includes("[工具结果]"), stdout.slice(0, 200));
}
{
  // R4：检索关键词为内部路径 → 终端不得出现路径
  const { stdout } = runCli("args", "内部检索\nexit\n");
  check("L3 工具参数不明文显示（内部路径不露出）", !stdout.includes("Luxshare"), stdout.slice(0, 200));
  check(
    "L4 源码检索结果摘要泛化显示（无论成败）",
    stdout.includes("内部检索已完成") || stdout.includes("内部检索失败"),
    stdout.slice(0, 200)
  );
  check("L5 最终回复正常显示", stdout.includes("暂时无法确认"));
}

console.log(`\n========== CLI 展示层验证结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
