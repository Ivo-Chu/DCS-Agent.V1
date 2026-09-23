// test/cli-fixture.mjs — CLI 展示层验证用的本地假模型（无外部请求）。
// 模式由环境变量 CLI_PROBE 决定：
// - length：模型只发工具调用片段且 finish_reason=length（R3：截断说明必须显示到终端）
// - args：模型用内部路径作检索关键词（R4：参数与摘要不得明文显示路径）
process.env.DEEPSEEK_API_KEY = "cli-display-fixture";
const mode = process.env.CLI_PROBE;
let call = 0;
const frame = (delta, finish_reason) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const text = (s) => frame({ content: s }, "stop");
const tool = (name, args, finish = "tool_calls") =>
  frame(
    { tool_calls: [{ index: 0, id: `call_${call}`, function: { name, arguments: JSON.stringify(args) } }] },
    finish
  );
globalThis.fetch = async () => {
  const i = call++;
  let body;
  if (mode === "length") {
    body = tool("check_dcs_permission", { menuName: "报餐管理" }, "length");
  } else {
    // args 模式
    body =
      i === 0
        ? tool("investigate_dcs_code", { query: "Luxshare.DCS.WebApi/Controllers/ReviewProbe.cs" })
        : text("暂时无法确认，请联系管理员。");
  }
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
};
