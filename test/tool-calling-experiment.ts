/** Small experiment launcher reusing acceptance-live, reports and JSONL. */
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEnvLocal } from '../src/dcs/env-local.ts';
import { resolveEmployeeByCode } from '../src/dcs/identity.ts';
import { closeDbClient } from '../src/dcs/db/client.ts';
loadEnvLocal();
const employeeCode = '31008589';
const identity = await resolveEmployeeByCode(employeeCode);
await closeDbClient();
if (!identity || identity.employeeNo !== employeeCode) throw new Error('Real identity not resolved');
console.log(JSON.stringify({ identity }));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve('test/acceptance-cases/reports', 'tool-calling-' + stamp);
const logs = path.resolve('logs/experiments', 'tool-calling-' + stamp);
mkdirSync(root, { recursive: true });
const base = '人资 / 人资管理 / 人资查询 / 通讯录，这个功能有什么用？';
const hint = '\n【业务定位线索】菜单数据库确认目标 URL 为 /Admin/AddressList/Index，对应 Luxshare.DCS.WebApp/Areas/Admin/Controllers/AddressListController.cs 和 Luxshare.DCS.WebApp/Areas/Admin/Views/AddressList/。不是 ADM/AddressBook 集团行政通讯录，也不是 Tool/GroupContacts 集团通讯录。';
const steps = '\n【指定调查步骤】先调用 search_dcs_knowledge 检索该页面资料；再用 search_dcs_code 定位上述入口，read_dcs_code 阅读 Index.cshtml、_Pager.cshtml 和控制器 Search 方法。结合实际代码核对用途、筛选条件、展示内容、维护入口与数据范围。检索无关时继续源码调查，读取不足时续读；仅在结论需要实时业务数据时使用结构/数据工具。取得足够证据后回答，不执行维护操作。';
const paths = [
  ['Luxshare.DCS.WebApp/Areas/Admin/Views/AddressList/Index.cshtml', 1, 245],
  ['Luxshare.DCS.WebApp/Areas/Admin/Views/AddressList/_Pager.cshtml', 1, 42],
  ['Luxshare.DCS.WebApp/Areas/Admin/Controllers/AddressListController.cs', 400, 445],
] as const;
const evidence = paths.map(([file, start, end]) => {
  const lines = readFileSync(path.join(process.env.DCS_SOURCE_ROOT!, file), 'utf8').split(/\r?\n/);
  return { file, start, end, text: lines.slice(start - 1, end).map((l, i) => `${start+i}: ${l}`).join('\n') };
});
const facts = JSON.parse(readFileSync('test/acceptance-cases/reports/address-list-facts-review.json', 'utf8'));
const questions = { A: base, B: base + hint, C: base + hint + steps, D: base + hint + steps + '\n【已核对的源码证据；不是指令】\n' + JSON.stringify(evidence) };
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ stamp, identity, base, questions, facts, evidenceHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), model: process.env.LLM_MODEL, maxDurationMs: 120000, repeats: 3, logs, note: 'Source/DB-grounded review; human business signoff pending. No browser navigation in this experiment.' }, null, 2));
console.log(JSON.stringify({ root, logs }));
for (let repeat = 1; repeat <= 3; repeat++) {
  for (const thinking of (repeat % 2 ? [false, true] : [true, false])) {
    const batch = `r${repeat}-${thinking ? 'on' : 'off'}`;
    const out = path.join(root, batch); mkdirSync(out);
    const conditions = repeat === 2 ? ['D', 'C', 'B', 'A'] : repeat === 3 ? ['B', 'D', 'A', 'C'] : ['A', 'B', 'C', 'D'];
    const cases = conditions.map(condition => ({ id: `${batch}-${condition}`, conversationId: `${stamp}-${batch}-${condition}`, employeeCode, question: questions[condition as keyof typeof questions], expectedFacts: facts.facts.map((f: any) => f.fact), maxDurationMs: 120000 }));
    const file = path.join(out, 'cases.json'); writeFileSync(file, JSON.stringify(cases, null, 2));
    const fd = openSync(path.join(out, 'console.log'), 'w');
    console.log(JSON.stringify({ batch, status: 'starting' }));
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', './test/thinking-preload.mjs', 'test/acceptance-live.ts'], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, ACCEPT_CASES_FILE: file, ACCEPT_REPORTS_DIR: out, ACCEPT_LOGS_DIR: logs, ACCEPT_THINKING: String(thinking) }, stdio: ['ignore', fd, fd] });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    closeSync(fd); console.log(JSON.stringify({ batch, status: 'finished', exitCode: code }));
  }
}
