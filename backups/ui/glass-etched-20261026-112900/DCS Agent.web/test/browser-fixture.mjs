import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dist = fileURLToPath(new URL("../dist/", import.meta.url)).replace(/[\\/]$/, "");
let navigationStream;
const server = http.createServer(async (req, res) => {
  if (req.url === "/host") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<title>Agent iframe regression fixture</title><style>body{font:14px sans-serif;background:#ddd}section{width:420px;height:650px;background:white}header{height:42px}iframe{display:block;width:420px;height:608px;border:0}</style><p>隔离测试：假 Session / 假 SSE，无真实员工数据</p><section><header>DCS Agent · 420×650 外窗（标题42px）</header><iframe src="/?_code=fixture"></iframe></section><script>addEventListener('message',event=>{if(event.origin===location.origin&&event.data.type==='dcs_agent_navigate')event.source.postMessage({type:'dcs_agent_navigate_result',requestId:event.data.requestId,ok:true,message:'已打开测试页'},event.origin)});</script>`);
    return;
  }
  if (req.url === "/api/session/sso") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, token: "fixture", name: "测试员工", employeeNo: "TEST", department: "测试部门", authMethod: "dcs_sso" }));
    return;
  }
  if (req.url === "/api/chat") {
    let body = ""; for await (const chunk of req) body += chunk;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (body.includes("导航")) {
      send({ type: "tool_step", status: "start", name: "navigate_dcs_menu", toolCallId: "navigation-tool" });
      send({ type: "ui_action", action: "navigate_dcs_menu", requestId: "nav-fixture", toolCallId: "navigation-tool", payload: { menuName: "测试" } });
      navigationStream = { res, send }; return;
    }
    send({ type: "delta", messageId: "1", text: "我先查询授权信息。" });
    for (let i = 0; i < 24; i++) {
      send({ type: "tool_step", toolCallId: "tool-" + i, name: "查询工具" + i, status: "start" });
      send({ type: "tool_step", toolCallId: "tool-" + i, name: "查询工具" + i, status: "end", isError: i === 3 });
    }
    send({ type: "delta", messageId: "2", text: "正在整理结果…" });
    send({ type: "final", messageId: "2", text: "这是最终回答。\n" + "长文本用于验证消息区独立滚动。".repeat(100) + "\n```ts\n    const value = 1;\n```\n" + "A".repeat(200) });
    res.end(); return;
  }
  if (req.url === "/api/ui-action/result") {
    navigationStream.send({ type: "tool_step", status: "end", name: "navigate_dcs_menu", toolCallId: "navigation-tool", isError: false });
    navigationStream.send({ type: "final", text: "导航已完成。" });
    navigationStream.res.end();
    const timer = setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); }, 200);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = path.join(dist, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(dist + path.sep) && !file.startsWith(dist + "/")) { res.writeHead(403); res.end(); return; }
  try {
    const data = fs.readFileSync(file);
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(18787, "127.0.0.1", () => console.log("Fixture at http://127.0.0.1:18787/host"));
