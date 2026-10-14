/**
 * CLI 展示层的入口级验证（R3 / R4 审查修复）。
 *
 * 通过子进程启动真实 src/index.ts，注入本地假模型（test/cli-fixture.mjs，
 * 无外部请求），从终端实际输出断言：
 * - R3：模型只发工具片段且 length 截断、无文本增量时，
 *       Runtime 后补的截断说明必须显示给用户（不能是空回答）
 * - R4：模型用内部源码路径作检索关键词时，路径允许进入【开发者终端日志】
 *       （排障所需，2026-10-13 边界澄清），但不得进入【对话输出】
 *       （助手> 后的回答文本）。
 *
 * 运行：npm run test:cli
 */
import { spawn } from "node:child_process";

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

async function runCli(mode: string, input: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath,
    ["--import", "tsx", "--import", "./test/cli-fixture.mjs", "src/index.ts"],
    { cwd: process.cwd(), env: { ...process.env, CLI_PROBE: mode, LLM_API_KEY: "cli-display-fixture" } });
  let stdout = "", stderr = "";
  let asked = false, exiting = false;
  const timer = setTimeout(() => child.kill(), 30000);
  child.stdout.on("data", chunk => {
    stdout += String(chunk);
    if (!asked && stdout.includes("你> ")) { asked = true; child.stdin.write(input.split("\n")[0] + "\n"); }
    if (!exiting && (stdout.match(/你> /g) ?? []).length >= 2) { exiting = true; child.stdin.write("exit\n"); }
  });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) throw new Error(`CLI ${mode} exit=${code}: ${stderr}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}

console.log("[场景] L. CLI 展示层（R3：后补文本显示 / R4：内部路径不露出）");

{
  // R3：length 截断且无文本增量 → 终端必须显示截断说明
  const { stdout, stderr } = await runCli("length", "查权限\nexit\n");
  check("L1 length 截断说明显示到终端（非空回答）", stdout.includes("截断"), stdout.trim().slice(0, 200));
  // F2 设计：截断的残缺工具调用被剥离、不执行——入口级确认无工具执行日志
  check("L2 截断的残缺工具未执行（无工具执行日志）", !stderr.includes("▶ 工具调用"), stdout.slice(0, 200));
}
{
  // R4：检索关键词为内部路径 → 回答不包含路径，开发日志可以包含
  const { stdout, stderr } = await runCli("args", "内部检索\nexit\n");
  // 对话输出 = 「助手> 」行的回答文本；开发者日志独立写入 stderr
  const answer = stdout.split("助手> ")[1]?.split("你> ")[0]?.trim() ?? "";
  check("L3 内部路径不进入对话输出（回答行无路径；开发者日志允许）",
    answer.includes("暂时无法确认") && !answer.includes("Luxshare"), answer.slice(0, 200));
  // 工具开始提示收敛：observer 在工具开始时输出简洁提示（不等执行完）
  check(
    "L4 工具开始时有简洁提示（▶ 工具调用 investigate_dcs_code）",
    stderr.includes("▶ 工具调用") && stderr.includes("investigate_dcs_code"),
    stdout.slice(0, 200)
  );
  check("L5 最终回复正常显示", stdout.includes("暂时无法确认"));
}

{
  const { stdout } = await runCli("unsafe-answer", "负向对照\n");
  const answer = stdout.split("助手> ")[1]?.split("你> ")[0]?.trim() ?? "";
  check("L6 负向对照确实检查到回答中的模拟路径", answer.includes("Luxshare/Controllers/Synthetic.cs"));
}
{
  const { stdout } = await runCli("slow-log", "慢日志\n");
  check("L7 日志写入挂起不阻止回答及下次输入", stdout.includes("慢日志回答") && (stdout.match(/你> /g) ?? []).length >= 2);
}

console.log(`\n========== CLI 展示层验证结果 ==========`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
