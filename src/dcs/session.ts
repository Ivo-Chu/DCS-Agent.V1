/**
 * dcs/session.ts
 * SessionUser / DcsSession / DcsToolContext 定义与构造。
 *
 * 身份属于 DCS Domain Layer，不属于通用 Agent Runtime：
 * core/types.ts 中不存在任何身份概念。
 *
 * v1 身份来源：直接构造 Mock Session（张三 / 10086 / 制造一部 / 普通员工）。
 * 未来正式身份链路：企微用户 → 可信 userid → 接入层 Identity Resolver
 * → userid → DCS employeeNo → 构造 DcsSession → 传入 Agent 的 toolContext。
 * 届时只替换本文件的 Session 构造方式，不修改 Agent Runtime。
 */

export interface SessionUser {
  /** 身份来源通道。 */
  source: "cli" | "wecom" | "web";
  /** 通道侧身份。正式企微接入后为可信的企微 userid。 */
  userId: string;
  /** DCS 工号。正式环境由接入层根据企微 userid 转换得到。 */
  employeeNo: string;
  name: string;
  department?: string;
  roles: string[];
}

export interface DcsSession {
  user: SessionUser;
}

/** DCS 工具上下文：工具从这里获得当前员工身份，模型无法指定。 */
export interface DcsToolContext {
  session: DcsSession;
}

export function createMockSession(): DcsSession {
  return {
    user: {
      source: "cli",
      userId: "mock-cli-user-10086",
      employeeNo: "10086",
      name: "张三",
      department: "制造一部",
      roles: ["普通员工"],
    },
  };
}
