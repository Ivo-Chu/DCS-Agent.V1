/** Independent read-only preflight; does not change production agent configuration. */
import { loadEnvLocal } from '../src/dcs/env-local.ts';
import { getDbClient, closeDbClient } from '../src/dcs/db/client.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

loadEnvLocal();
const results: unknown[] = [];
const record = (value: unknown) => { results.push(value); console.log(JSON.stringify(value)); };
const deadline = setTimeout(() => { save(); process.exit(1); }, 150_000);
function save() {
  mkdirSync('test/acceptance-cases/reports', { recursive: true });
  writeFileSync('test/acceptance-cases/reports/tool-calling-preflight.json', JSON.stringify({ checkedAt: new Date().toISOString(), model: process.env.LLM_MODEL || 'Qwen3.5-35B', results }, null, 2));
}
try {
  try {
    const db = getDbClient();
    if (!db) throw new Error('DB_NOT_CONFIGURED');
    let schema = process.env.DCS_DB_SCHEMA;
    if (!schema) {
      const owners = await db.execute("SELECT OWNER FROM ALL_TABLES WHERE TABLE_NAME = 'S2_MENU'");
      const unique = [...new Set(owners.rows.map(r => String(r[0])))];
      if (unique.length === 1) schema = unique[0];
    }
    if (!schema || !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(schema)) throw new Error('SCHEMA_UNCONFIRMED');
    const result = await db.execute(`SELECT Code, PCode, Name, Url, LEVEL AS TREE_LEVEL FROM ${schema}.S2_Menu START WITH Name LIKE :name CONNECT BY NOCYCLE PRIOR PCode = Code`, { name: '%通讯录%' });
    record({ kind: 'database', ok: true, ...result });
  } catch (e: any) {
    record({ kind: 'database', ok: false, code: e.code || String(e.message).match(/(?:NJS|ORA)-\d+/)?.[0] || (e.message === 'SCHEMA_UNCONFIRMED' ? e.message : e.name) });
  } finally { await closeDbClient().catch(() => {}); }

  for (const thinking of [false, true]) {
    const messages: any[] = [{ role: 'user', content: '请调用 lookup 工具查询编号 17，不要猜测查询结果。' }];
    for (const phase of ['tool_selection', 'after_tool_result']) {
    const started = Date.now();
    try {
      if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) throw new Error('MODEL_NOT_CONFIGURED');
      const response = await fetch(process.env.LLM_BASE_URL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LLM_API_KEY },
        body: JSON.stringify({ model: process.env.LLM_MODEL || 'Qwen3.5-35B',
          messages,
          stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: thinking }, tool_choice: 'auto',
          tools: [{ type: 'function', function: { name: 'lookup', description: '按编号查询测试记录', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } }],
        }), signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        record({ kind: 'model', phase, thinking, status: response.status, elapsedMs: Date.now() - started });
        await response.body?.cancel(); break;
      }
      const raw = await response.text();
      let reasoningChars = 0, contentChars = 0, finish: unknown = null, usage: unknown = null, malformedFrames = 0;
      const keys = new Set<string>();
      let content = '';
      const calls: Record<string, { id: string; name: string; arguments: string }> = {};
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]' || !line.slice(5).trim()) continue;
        try {
          const j = JSON.parse(line.slice(5)), d = j.choices?.[0]?.delta || {};
          Object.keys(d).forEach(k => keys.add(k));
          reasoningChars += String(d.reasoning_content || d.reasoning || '').length;
          contentChars += String(d.content || '').length;
          content += d.content || '';
          for (const c of d.tool_calls || []) {
            const call = calls[c.index ?? 0] ??= { id: '', name: '', arguments: '' };
            if (c.id) call.id = c.id;
            call.name += c.function?.name || ''; call.arguments += c.function?.arguments || '';
          }
          finish = j.choices?.[0]?.finish_reason || finish; usage = j.usage || usage;
        } catch { malformedFrames++; }
      }
      record({ kind: 'model', phase, thinking, status: response.status, elapsedMs: Date.now() - started, deltaKeys: [...keys], reasoningChars, contentChars, calls, finish, usage, malformedFrames, ...(phase === 'after_tool_result' ? { answer: content } : {}) });
      const values = Object.values(calls);
      if (phase === 'tool_selection') {
        if (values.length !== 1 || values[0].name !== 'lookup' || !values[0].id || JSON.parse(values[0].arguments).id !== 17) break;
        // Match production serialization: no reasoning field is returned in history.
        messages.push({ role: 'assistant', content: content || null, tool_calls: values.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
        messages.push({ role: 'tool', tool_call_id: values[0].id, content: '{"id":17,"status":"verified","label":"实验记录"}' });
      }
    } catch (e: any) { record({ kind: 'model', phase, thinking, elapsedMs: Date.now() - started, error: e.name, cause: e.cause?.code || null }); break; }
    }
  }
} finally { clearTimeout(deadline); save(); }
