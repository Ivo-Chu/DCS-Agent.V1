// Test-process-only transport override; both modes use the same production adapter.
import { loadEnvLocal } from '../src/dcs/env-local.ts';
loadEnvLocal();
const originalFetch = globalThis.fetch;
const endpoint = process.env.LLM_BASE_URL?.replace(/\/+$/, '') + '/chat/completions';
globalThis.fetch = (input, init) => {
  if (String(input) === endpoint && typeof init?.body === 'string') {
    const body = JSON.parse(init.body);
    body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: process.env.ACCEPT_THINKING === 'true' };
    init = { ...init, body: JSON.stringify(body) };
  }
  return originalFetch(input, init);
};
