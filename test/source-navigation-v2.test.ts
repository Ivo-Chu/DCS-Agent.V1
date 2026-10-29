/** Synthetic filesystem/rg regression only; no model, database or private source map. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { searchDcsCodeTool as search } from "../src/dcs/source-tools.ts";
import { searchSourceMap, type SourceEntry } from "../src/dcs/source-map.ts";
import { createMockSession } from "../src/dcs/session.ts";

const parent = path.resolve("data/harness-v1");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "navigation-v2-"));
const saved = { ...process.env };
process.env.DCS_SOURCE_ROOT = root;
process.env.DCS_SOURCE_MAP_FILE = path.join(root, "map.json");
const holder = { controller: new AbortController() };
const ctx = { session: createMockSession(), holder };
const decode = (result: { output: string }) => JSON.parse(result.output);
const run = async (args: Parameters<typeof search.execute>[0]) => decode(await search.execute(args, ctx));
let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
const code = "class ExampleController {}\n// synthetic content\n";
const hash = createHash("sha256").update(code).digest("hex");
const entry: SourceEntry = {
  name: "人资通讯录", aliases: ["通讯录", "AddressList"], menuContext: ["人资管理"],
  page: "/Admin/AddressList/Index", controller: "ExampleController", action: "Index",
  verification: { status: "verified", basis: "Synthetic route/controller/view", checkedAt: "2026-10-28T00:00:00Z" },
  references: (["route", "controller", "view"] as const).map((role, i) => ({
    path: ["route.cs", "ExampleController.cs", "Index.cshtml"][i], role, startLine: 1, endLine: 2, sha256: hash,
  })),
};
const save = (entries = [entry]) => fs.writeFile(process.env.DCS_SOURCE_MAP_FILE!, JSON.stringify({ version: 1, entries }));
try {
  for (const reference of entry.references) await fs.writeFile(path.join(root, reference.path), code);
  await fs.mkdir(path.join(root, "Area", "Name"), { recursive: true });
  await fs.mkdir(path.join(root, "Other"));
  await fs.writeFile(path.join(root, "Area", "Name", "Index.cshtml"), "Value A\nValue B\nA|B\n宿舍床位统计\n");
  await fs.writeFile(path.join(root, "Other", "Other.cs"), "Value Other\n");
  await save();

  await test("长问题、规范化名称别名和已有菜单上下文可匹配，保留依据", async () => {
    for (const query of ["人资管理 通讯录", "谢谢，另外通讯录能查哪些人？", "ＡＤＤＲＥＳＳ　ＬＩＳＴ", "人资 管理"]) {
      const result = await searchSourceMap(query, 0, 30);
      assert.equal(result.items.length, 1, `${query}: ${JSON.stringify(result)}`);
      assert.ok(result.items[0].matchBasis.length);
      assert.equal(result.items[0].references[0].sha256, hash);
    }
    const menu = await searchSourceMap("人资管理", 0, 30);
    assert.equal(menu.items[0].matchBasis[0].field, "menuContext");
    assert.equal((await searchSourceMap("！！！", 0, 30)).items.length, 0);
  });
  await test("同名对象全部返回并保留分页，不选最高候选", async () => {
    await save([entry, { ...entry, name: "另一通讯录", page: "/Other/AddressList/Index" }]);
    const all = await searchSourceMap("通讯录为什么查不到人", 0, 30);
    assert.equal(all.items.length, 2);
    const first = await searchSourceMap("通讯录", 0, 1);
    const second = await searchSourceMap("通讯录", first.nextOffset!, 1);
    assert.equal(first.hasMore, true); assert.equal(second.items[0].name, "另一通讯录");
    await save();
  });
  await test("失效映射不成为候选，未知功能仍能普通搜索", async () => {
    await fs.writeFile(path.join(root, "route.cs"), code + "changed");
    const result = await searchSourceMap("通讯录", 0, 30);
    assert.equal(result.items.length, 0); assert.match(JSON.stringify(result), /source_changed/);
    await fs.writeFile(path.join(root, "route.cs"), code);
    assert.equal((await run({ mode: "feature", pattern: "未登记功能" })).status, "empty");
    assert.equal((await run({ mode: "files", pattern: "**/Name/Index.cshtml" })).items.length, 1);
  });
  await test("字面竖线保留原意并提示，正则只在显式开启时使用", async () => {
    const literal = await run({ mode: "text", pattern: "A|B", regex: false, directory: "Area", contextLines: 0 });
    assert.equal(literal.searchMode, "literal"); assert.equal(literal.items.length, 1);
    assert.equal(literal.items[0].text, "A|B"); assert.match(literal.hint, /regex:true/);
    const regex = await run({ mode: "text", pattern: "Value A|Value B", regex: true, directory: "Area", contextLines: 0 });
    assert.equal(regex.searchMode, "regex"); assert.equal(regex.items.length, 2);
    const file = await run({ mode: "files", pattern: "**/Name/Index.cshtml" });
    assert.equal(file.searchMode, "glob"); assert.equal(file.items.length, 1);
    const invalidRegex = await run({ mode: "text", pattern: "[", regex: true, directory: "Area" });
    assert.equal(invalidRegex.status, "search_error"); assert.equal(invalidRegex.searchMode, "regex");
  });
  const args = { mode: "text" as const, pattern: "Value", directory: "Area", contextLines: 0, limit: 1 };
  await test("同一Run相同窄范围搜索复用，返回明确内容状态", async () => {
    holder.controller = new AbortController();
    const first = await run(args), second = await run(args);
    assert.equal(first.cache.reused, false); assert.equal(first.cache.reason, "verified_narrow_scope");
    assert.equal(second.cache.reused, true); assert.match(second.cache.sourceState, /^[a-f0-9]{64}$/);
    assert.deepEqual(second.items, first.items);
  });
  await test("不同分页、范围、glob、regex和模式不错误复用", async () => {
    const page = await run({ ...args, offset: 1 });
    assert.equal(page.cache.reused, false); assert.equal(page.items[0].line, 2);
    assert.equal((await run({ ...args, offset: 1 })).cache.reused, true);
    for (const changed of [{ ...args, directory: "Other" }, { ...args, glob: "**/*.cshtml" },
      { ...args, regex: true }, { ...args, contextLines: 1 }, { ...args, limit: 2 }]) {
      assert.equal((await run(changed)).cache.reused, false);
    }
    const files = await run({ mode: "files", pattern: "*", directory: "Area" });
    assert.equal(files.cache.reused, false);
  });
  await test("同大小同mtime内容改变、成员新增及删除都使缓存失效", async () => {
    const file = path.join(root, "Area", "Name", "Index.cshtml");
    const stat = await fs.stat(file);
    await fs.writeFile(file, "Other A\nOther B\nA|B\n宿舍床位统计\n");
    await fs.utimes(file, stat.atime, stat.mtime);
    const changed = await run(args); assert.equal(changed.cache.reused, false); assert.equal(changed.items.length, 0);
    await fs.writeFile(path.join(root, "Area", "Added.cs"), "Value added\n");
    const added = await run(args); assert.equal(added.cache.reused, false); assert.equal(added.items.length, 1);
    await fs.unlink(path.join(root, "Area", "Added.cs"));
    const removed = await run(args); assert.equal(removed.cache.reused, false); assert.equal(removed.items.length, 0);
  });
  await test("源码状态超界或全库查询不做未经核验的复用", async () => {
    const full = { mode: "text" as const, pattern: "Example", contextLines: 0 };
    assert.equal((await run(full)).cache.reused, false); assert.equal((await run(full)).cache.reused, false);
    await fs.writeFile(path.join(root, "Other", "Large.cs"), "x".repeat(2 * 1024 * 1024 + 1));
    const large = await run({ ...args, directory: "Other" });
    assert.equal(large.cache.reason, "scope_state_unverified_or_changed");
    assert.equal((await run({ ...args, directory: "Other" })).cache.reused, false);
    await fs.unlink(path.join(root, "Other", "Large.cs"));
  });
  await test("连续空结果提醒检查模式与定位，成功结果提示缩小范围", async () => {
    holder.controller = new AbortController();
    const empty = { ...args, pattern: "不在合成文件" };
    const first = await run(empty), second = await run(empty);
    assert.equal(first.emptyStreak, 1); assert.equal(second.emptyStreak, 2); assert.match(second.hint, /连续.*空结果/);
    const found = await run({ ...args, directory: "Other" });
    assert.equal(found.emptyStreak, 0); assert.match(found.hint, /实际目录/);
  });
  await test("后续Run及其他会话不继承缓存，取消不返回缓存", async () => {
    holder.controller = new AbortController();
    assert.equal((await run(args)).cache.reused, false);
    assert.equal((await run(args)).cache.reused, true);
    const other = decode(await search.execute(args, { ...ctx, holder: { controller: new AbortController() } }));
    assert.equal(other.cache.reused, false);
    holder.controller.abort();
    assert.equal((await run(args)).status, "cancelled");
    holder.controller = new AbortController();
    assert.equal((await run(args)).cache.reused, false);
    const noRun = decode(await search.execute(args, { session: ctx.session }));
    assert.equal(noRun.cache.reused, false);
  });
  console.log(`Source navigation V2: ${passed} passed (synthetic offline)`);
} finally {
  process.env = saved;
  if (path.dirname(root) !== parent || !path.basename(root).startsWith("navigation-v2-")) throw new Error("Unexpected cleanup path");
  await fs.rm(root, { recursive: true, force: true });
}
