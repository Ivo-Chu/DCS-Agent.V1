// Deliberately omit tool calls to check whether the existing live test rejects it.
process.env.DEEPSEEK_API_KEY = 'local-fixture';
globalThis.fetch = async (url) => {
  if (String(url).includes('127.0.0.1:1')) throw new Error('local simulated network failure');
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'test answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
};
