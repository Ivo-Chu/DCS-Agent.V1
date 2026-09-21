// Local model fixture for observing the existing CLI. Real DCS search is read-only.
process.env.DEEPSEEK_API_KEY = 'local-fixture';
delete process.env.DCS_SOURCE_ROOT;
let turn = 0;
globalThis.fetch = async () => {
  const choice = turn++ === 0
    ? { delta: { tool_calls: [{ index: 0, id: 'search-id', function: { name: 'search_dcs_code', arguments: '{"keyword":"Employee"}' } }] }, finish_reason: 'tool_calls' }
    : { delta: { content: '暂时无法确认，请联系 IT 服务台。' }, finish_reason: 'stop' };
  return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
};
