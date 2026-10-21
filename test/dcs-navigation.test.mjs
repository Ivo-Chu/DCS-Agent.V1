import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
const root = process.env.DCS_WEBAPP_ROOT ?? "D:/work/DCS code/Luxshare.DCS.WebApp";
const view = fs.readFileSync(path.join(root, "Views/Shared/_Likeniu.cshtml"), "utf8");
const tabSource = fs.readFileSync(path.join(root, "Content/layui/model/layuimini/miniTab.js"), "utf8");
// 执行 Razor 中真实导航函数/监听器；只替换服务端生成的菜单 endpoint。
const bridge = view.slice(view.indexOf("        function sendNavigationResult"), view.indexOf('        $(".niulog")'))
  .replace('@Url.Action("GetNewMenus", "Home", new { area = "" })', "/menus");
function harness({ existing = false, full = false, activate = true, moduleReady = true, create = true } = {}) {
  const tabs = new Set(existing ? ["/target"] : []);
  const results = [];
  let active = "/home", listener, loadModule, menuCallback, timeoutCallback;
  const frame = { postMessage: result => results.push(result) };
  function $(selector) {
    return {
      length: full ? 50 : tabs.size,
      each(fn) { for (const id of tabs) fn.call({ id }); },
      attr(name) { if (typeof selector === "object") return selector.id; return name === "lay-id" ? active : this; },
    };
  }
  $.trim = s => s.trim(); $.each = (xs, fn) => xs.forEach((x, i) => fn(i, x)); $.map = (xs, fn) => xs.map(fn);
  $.get = (_url, cb) => { menuCallback = cb; return { fail() { return this; }, abort() {} }; };
  const ctx = {
    $, URL, Date, setTimeout(fn) { timeoutCallback = fn; return 1; }, clearTimeout() {},
    window: { location: { href: "https://dcs.test/Home/Index", origin: "https://dcs.test", pathname: "/Home/Index", search: "" },
      addEventListener(_event, fn) { listener = fn; } },
    dcsAgentOrigin: "https://agent.test", dcsAgentFrame: frame,
    sessionStorage: { setItem() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    ui: null,
    layui: {
      $,
      layer: { load() {}, msg() {} },
      element: { tabAdd(_filter, options) { if (create) tabs.add(options.id); }, tabChange(_filter, id) { if (activate) active = id; } },
      define(_deps, fn) { fn((name, value) => { ctx.layui[name] = value; }); },
      use(_deps, fn) { if (moduleReady) fn(); else loadModule = fn; },
    },
  };
  vm.createContext(ctx); vm.runInContext(tabSource, ctx); vm.runInContext(bridge, ctx);
  return {
    results, tabs, ctx, frame, active: () => active,
    request(menuName = "查询", nodes = [{ title: "查询", href: "/target", target: "_self" }]) {
      listener({ origin: ctx.dcsAgentOrigin, source: frame, data: { type: "dcs_agent_navigate", requestId: "nav-test", menuName } });
      menuCallback({ menuInfo: nodes });
    },
    ready() { loadModule(); },
    cancel() { listener({ origin: ctx.dcsAgentOrigin, source: frame, data: { type: "dcs_agent_navigation_cancel", requestId: "nav-test" } }); },
    expire() { timeoutCallback(); },
    foreign(origin, source) { listener({ origin, source, data: { type: "dcs_agent_navigate", requestId: "foreign", menuName: "查询" } }); assert.equal(menuCallback, undefined); },
  };
}
let h = harness(); h.request(); assert.equal(h.active(), "/target"); assert.equal(h.results[0].ok, true);
h = harness({ existing: true }); h.request(); assert.equal(h.active(), "/target"); assert.equal(h.results[0].ok, true);
h = harness({ activate: false }); h.request(); assert.equal(h.results[0].ok, false);
h = harness({ full: true }); h.request(); assert.equal(h.results[0].ok, false); assert.equal(h.tabs.size, 0);
h = harness({ moduleReady: false }); h.request(); assert.equal(h.results.length, 0); h.ready(); assert.equal(h.results[0].ok, true);
h = harness({ moduleReady: false }); h.request(); h.ctx.dcsAgentFrame = {}; h.ready(); assert.equal(h.tabs.size, 0);
h = harness({ moduleReady: false }); h.request(); h.cancel(); h.ready(); assert.equal(h.tabs.size, 0); assert.equal(h.results.length, 0);
const tree = [
  { title: "人事管理", href: "", child: [{ title: "查询", href: "/target" }] },
  { title: "宿舍管理", href: "", child: [{ title: "查询", href: "/dorm" }] },
];
h = harness(); h.request("查询", tree);
assert.equal(h.results[0].ok, false); assert.match(h.results[0].message, /人事管理 \/ 查询/); assert.match(h.results[0].message, /宿舍管理 \/ 查询/);
h = harness(); h.request("人事管理/查询", tree); assert.equal(h.active(), "/target"); assert.equal(h.results[0].ok, true);
for (const menu of [
  { title: "查询", href: "/target", target: "_blank" },
  { title: "查询", href: "/target", target: "_top" },
  { title: "查询", href: "https://external.test/path" },
  { title: "查询", href: "//external.test/path" },
  { title: "查询", href: "javascript:alert(1)" },
  { title: "查询", href: "data:text/html,test" },
  { title: "查询", href: "" },
  { title: "查询", href: "#" },
  { title: "查询", href: "/directory", child: [{ title: "子菜单", href: "/child" }] },
]) {
  h = harness(); h.request("查询", [menu]); assert.equal(h.results[0].ok, false, JSON.stringify(menu)); assert.equal(h.tabs.size, 0);
}
h = harness({ create: false }); h.request(); assert.equal(h.results[0].ok, false);
h = harness({ moduleReady: false }); h.request(); h.expire(); h.ready(); assert.equal(h.results[0].ok, false); assert.equal(h.tabs.size, 0);
h = harness(); h.foreign("https://bad.test", h.frame);
h = harness(); h.foreign("https://agent.test", {});
console.log("DCS actual bridge + miniTab: 22 scenarios passed");
