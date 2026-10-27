import type { ChatEvent } from './api';
export interface Tool {
  key: string;
  name: string;
  messageId?: string;
  status: 'running' | 'success' | 'error' | 'selection';
  candidates?: { title: string; path: string }[];
}
const labels: Record<string, string> = {
  investigate_dcs_code: 'DCS业务逻辑查询',
  query_dcs_data: 'DCS实时数据查询',
  inspect_dcs_schema: 'DCS数据结构查询',
  navigate_dcs_menu: 'DCS菜单查找',
  search_dcs_knowledge: '知识资料检索',
};
export function toolLabel(tool: Tool): string {
  return (labels[tool.name] ?? '业务处理') + ({ running: '中', success: '完成', error: '未完成', selection: '：等待选择' }[tool.status]);
}
export function applyToolEvent(tools: Tool[], prefix: string, e: Extract<ChatEvent, {type: 'tool_step'}>): Tool[] {
  const key = prefix + ':' + (e.toolCallId ?? e.name);
  const tool: Tool = { key, name: e.name, messageId: prefix + ':' + (e.messageId ?? 'process'),
    status: e.status === 'start' ? 'running' : e.navigationStatus === 'needs_selection' ? 'selection' : e.isError ? 'error' : 'success',
    candidates: e.candidates };
  return tools.some(t => t.key === key) ? tools.map(t => t.key === key ? tool : t) : [...tools, tool];
}
