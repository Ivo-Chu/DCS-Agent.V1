// Review-only local model responses; no external requests or real API key.
process.env.DEEPSEEK_API_KEY = 'local-review-fixture';
const mode = process.env.REVISION_PROBE;
let call = 0;
const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const text = s => frame({ content: s }, 'stop');
const tool = (name, args, finish = 'tool_calls') => frame({ tool_calls: [{ index: 0, id: `call_${call}`, function: { name, arguments: JSON.stringify(args) } }] }, finish);
const error = s => `data: ${JSON.stringify({ error: { message: s } })}\n\n`;
globalThis.fetch = async () => {
  const i = call++;
  let body;
  if (mode === 'length') {
    body = tool('check_dcs_permission', { menuName: '报餐管理' }, 'length');
  } else if (mode === 'args') {
    body = i === 0 ? tool('search_dcs_code', { keyword: 'Luxshare.DCS.WebApi/Controllers/ReviewProbe.cs' }) : text('暂时无法确认。');
  } else {
    const broken = mode === 'invalid-acceptance';
    const steps = [
      () => tool('check_dcs_permission', { menuName: '权限管理' }),
      () => broken ? error('系统管理员请联系开通') : text('你缺少系统管理员角色，请联系管理员开通。'),
      () => tool('check_dcs_permission', { menuName: broken ? '权限管理' : '报餐管理' }),
      () => tool('query_business_data', { dataType: broken ? '无效类型' : '报餐订单' }),
      () => broken ? error('驳回超出42元35元') : text('订单42元，餐标35元，超出7元被驳回。'),
      () => broken ? error('35') : text('餐标是35元/人/日。'),
    ];
    body = steps[i]?.() ?? error('fixture exhausted');
  }
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
