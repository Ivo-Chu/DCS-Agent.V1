export interface SessionUser {
  /** 身份来源通道。 */
  source: "cli" | "wecom" | "web";
  /** 通道侧身份。正式企微接入后为可信的企微 userid。 */
  userId: string;
  /** DCS 工号。正式环境由企微 userid / Web SSO 服务端解析得到。 */
  employeeNo: string;
  name: string;
  department?: string;
  roles: string[];
  /** 身份验证方式。dcs_sso 仅允许 Node 服务端在 DCS CheckSSOCode 校验成功后构造。 */
  authMethod?: "dcs_sso" | "manual_test";
}

export interface DcsSession {
  user: SessionUser;
}

/** DCS 工具上下文：工具从这里获得当前员工身份，模型无法指定。 */
export interface DcsToolContext {
  session: DcsSession;
  /**
   * 当前 Run 的取消信号持有器（可变对象）——与模型 signalProvider 读取的
   * 是同一 holder（agent-factory 组装时注入）。工具在执行时读取
   * holder.controller.signal，Run 超时/用户停止后可中止自己的外部请求
   * （如知识库检索 HTTP 调用）。可选：离线测试可不传。
   */
  holder?: { controller: AbortController };
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

/**
 * 由已解析的 DCS 身份构造会话（企微 / Web 链路用）。
 * userid 来自通道侧可信身份（企微 body.from.userid / Web 通道的服务端解析），
 * 身份字段来自 Identity Resolver；source 标识来源通道（默认 wecom）。
 */
export function createSession(
  identity: { employeeNo: string; name: string; department?: string; roles?: string[] },
  userid: string,
  source: "wecom" | "web" = "wecom",
  authMethod?: "dcs_sso" | "manual_test"
): DcsSession {
  return {
    user: {
      source,
      userId: userid,
      employeeNo: identity.employeeNo,
      name: identity.name,
      department: identity.department,
      roles: identity.roles ?? [],
      authMethod,
    },
  };
}
