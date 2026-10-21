/**
 * dcs/navigation-tool.ts
 * Web 专用菜单导航工具。
 *
 * 生命周期：工具真实 execute 时才创建导航请求；SSE 下发、requestId 配对、
 * 浏览器结果等待全部由 Web Channel 注入的 navigation bridge 完成。
 * AgentLoop / core 不感知 UI 指令。
 */
import type { ToolDefinition } from "../core/types.ts";
import type { DcsToolContext } from "./session.ts";
import { requireTrustedEmployee } from "./db/authorization.ts";

export interface NavigateDcsMenuArgs {
  menuName?: string;
}

export interface NavigationResult { ok: boolean; message: string }
export type RequestNavigation = (employeeNo: string, menuName: string) => Promise<NavigationResult>;

const MENU_NAME_MAX = 400;

function normalizeMenuName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MENU_NAME_MAX + 1) : "";
}

export function createNavigateDcsMenuTool(requestNavigation: RequestNavigation): ToolDefinition<NavigateDcsMenuArgs, DcsToolContext> {
  return {
    name: "navigate_dcs_menu",
    label: "DCS菜单导航",
    description: "根据员工自然语言提供的菜单名称，打开或切换当前员工有权限访问的DCS菜单页签。不支持外部URL、表单填写或业务提交；最终页面和权限由DCS父页面校验。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        menuName: { type: "string", description: "员工想打开的DCS菜单名称，例如：上岗证查询。同名时根据返回候选再次使用完整路径，如：人事管理 / 查询。" },
      },
      required: ["menuName"],
    },
    async execute(args, ctx) {
      const menuName = normalizeMenuName(args?.menuName);
      if (!menuName || menuName.length > MENU_NAME_MAX) {
        return { output: "unavailable: 菜单名称无效。", isError: true };
      }
      let employeeNo: string;
      try {
        employeeNo = requireTrustedEmployee(ctx);
      } catch {
        return { output: "unavailable: 当前Web会话未通过DCS SSO验证，无法执行菜单导航。", isError: true };
      }
      try {
        const result = await requestNavigation(employeeNo, menuName);
        return { output: result.message, isError: !result.ok };
      } catch (error) {
        return { output: `unavailable: 菜单导航暂时无法执行（${error instanceof Error ? error.message : String(error)}）。`, isError: true };
      }
    },
  };
}
