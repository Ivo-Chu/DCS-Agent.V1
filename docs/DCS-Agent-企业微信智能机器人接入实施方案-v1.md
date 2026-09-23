# DCS Agent 企业微信智能机器人接入实施方案 v1

日期：2026-09-22  
状态：待用户确认，仅设计方案，尚未实施。  
项目：`<DCS-Agent 仓库本地目录>`

## 1. 目标与实施原则

当前 DCS Agent 已能通过 CLI 完成真实模型调用、Tool Calling、Tool Result → Final Answer。下一阶段优先让真实员工通过企业微信提问。

推荐接入方式：**企业微信智能机器人，API 模式，WebSocket 长连接。**

先在当前 Windows 工作电脑跑通员工单聊，再将同一服务搬到公司常驻服务器。

原则：上线 > 业务闭环 > 稳定性 > 架构完整度。

- 复用现有 Agent，不重构 Agent / AgentLoop。
- 企微是独立 Channel / Adapter，与 Agent 核心分开，但放在同一项目、第一版运行在同一进程。
- 不引入多 Agent 协作、复杂 Intent Router、RAG、管理后台或复杂 Memory。
- 每名员工一个独立的 Agent 实例用于保存会话，不属于多 Agent 协作架构。
- 所有业务工具只读；现有 mock 继续保留并明确标识。
- 本方案未授权立即实施，用户确认后才修改代码。
- 实施中的代码、依赖、配置、日志和临时文件只能在项目目录内产生。项目外操作须另行说明并取得同意。
- `<Pi 项目本地目录>` 与 `<DCS_SOURCE_ROOT>` 仅可只读访问。

## 2. 当前项目接入点

基于当前实际代码确认：

| 事项 | 当前实现 | 企微接入方式 |
|---|---|---|
| 启动入口 | `src/index.ts` 负责 CLI 和 Agent 组装 | 新增企微入口，保留 CLI |
| Agent 调用入口 | `await agent.prompt(text)` | Adapter 收到问题后直接调用 |
| 对话历史 | 每个 Agent 持有 `context: AgentMessage[]` | 每名员工持有独立 Agent |
| 历史写回 | Run 结束后一次性合并 `newMessages` | 继续复用 |
| 当前身份 | `createMockSession()` 固定张三/10086 | 使用可信 userid 映射生成 DcsSession |
| 工具身份 | `ctx.session.user` | 保留，不由模型指定 |
| Final Answer | `prompt()` 返回 `Promise<string>` | Adapter 发送给当前员工 |
| 事件 | `subscribe()` | 用于判断错误、记录运行状态，不转发工具日志 |

需要区分：

- **对话 Context**：`agent.context`，保存消息历史。
- **工具身份 Context**：`toolContext.session`，保存可信员工身份。

userid 主要进入工具身份 Context，不修改通用消息类型加入企微字段。身份说明仍由 `buildSystemPrompt(session)` 注入。

职责划分：

| 层 | 职责 |
|---|---|
| 企微 Adapter | 收发、识别发送者、选择会话、去重、重连、超时与回复 |
| DCS 业务层 | userid → 工号映射、Session、Prompt、业务工具和脱敏 |
| Agent Runtime | 调模型、执行工具、维护历史、生成答案 |

Agent 不知道 BotID、Secret、企微消息格式或连接协议。以后接网页入口仍可复用相同 Agent。

## 3. 官方能力选择

本次已核对企业微信团队官方 Node SDK、消息类型定义和腾讯官方接入说明。企业微信开发文档站部分页面未能直接读取，长连接关键字段和调用方式通过官方 SDK 源码交叉确认。企业实际是否具备创建权限，以管理员后台为准。

| 能力 | 是否满足员工主动聊天 | 选择 |
|---|---|---|
| 智能机器人 API 长连接 | 接收员工消息并回复 | 首选 |
| 智能机器人 URL 回调 | 可以，需要回调服务 | 备用，不同时实施 |
| 自建应用：接收消息＋发送消息 API | 可以，凭据与回调配置更多 | 智能机器人不可用时再考虑 |
| 传统群机器人 Webhook | 主要向群发送消息，不能凭此接收员工提问 | 不采用 |
| 消息回调/API | 属于传输或接口能力，不是另一种机器人产品 | 必须明确对应的接入产品 |

采用官方 `@wecom/aibot-node-sdk`，不自行重写认证、心跳、重连和回复协议。

官方依据：

- [企业微信官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)
- [官方智能机器人配置与部署说明](https://cloud.tencent.com/document/product/1759/121473)
- [传统群机器人官方示例](https://github.com/WecomTeam/RobotSample)
- [企业微信长连接协议文档入口](https://developer.work.weixin.qq.com/document/path/101463)

第一版范围：一个企业、一个机器人、少量试用员工、内部单聊、文字消息。群聊只提示转单聊，不查个人业务数据。图片、文件、语音和群内个人查询暂不做。

## 4. 最小架构

```text
员工企业微信单聊
    ↓
企业微信服务
    ↕ 后端主动建立的 WSS 长连接
WeCom Adapter
    ↓ 可信 userid
DCS 身份映射
    ↓ DcsSession
取得当前员工的独立 Agent
    ↓ agent.prompt(question)
现有 Agent / AgentLoop
    ↕
现有只读 Tools
    ↓ Final Answer
WeCom Adapter
    ↓ 同一条企微回复
当前员工
```

CLI 与企微分别作为入口，调用同一套 Runtime 实现。不会让企微 SDK 或认证逻辑进入 core。

## 5. 身份设计

### 5.1 可信 userid

官方长连接消息包含：

| 字段 | 用途 |
|---|---|
| `body.from.userid` | 发送员工 |
| `body.aibotid` | 机器人身份 |
| `body.msgid` | 消息唯一标识，用于去重 |
| `body.chattype` | single / group |
| `body.text.content` | 员工问题 |
| `headers.req_id` | 回复关联标识 |

这些字段只从认证后的官方连接取得。用户文字中的“我是某某”“我的工号是……”不能覆盖身份。

Adapter 校验机器人 ID、userid、允许的消息类型及试用名单。身份缺失或未匹配时，不执行个人查询。

参考：[官方消息类型定义](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/types/message.ts)。

### 5.2 userid 映射到 DCS 身份

userid 不等于 DCS employeeNo。第一版采用管理员维护的小型私有映射文件：

```text
企微 userid → employeeNo / name / department / roles → DcsSession
```

工号和角色来自管理员配置，不能由模型或聊天文本决定。私有映射文件保存在项目目录并加入 Git 忽略，仓库仅放虚构示例。

未知员工回复：“你暂未开通 DCS 助手试用，请联系管理员。”

**禁止未知员工默认使用张三/10086，禁止为便于演示将所有员工映射成 10086。**

### 5.3 传入 Agent 和 Tool

```text
session.user.source = "wecom"
session.user.userId = 官方消息中的 userid
session.user.employeeNo = 管理员映射得到的工号

Agent.toolContext = { session }
Tool.execute(args, ctx) → ctx.session.user
```

工具 Schema 不增加 userid 或 employeeNo 查询对象参数。即使模型输出额外身份字段，也不采用。

身份配置变更后清除对应旧会话，重新创建 Agent，避免继续使用旧角色。

### 5.4 mock 的边界

现有权限菜单和业务数据仍为 mock，订单仅 10086 有演示数据。因此本阶段是：

**真实员工＋真实企微消息＋真实 Agent 调用＋明确标识的演示业务数据。**

机器人名称或欢迎语注明试用版，涉及 mock 的回答由 Adapter 加上“【演示数据】”。不能宣称已查询真实权限或真实订单。

接真实只读业务数据放到下一步，不阻塞 Channel 联调。

## 6. 多轮会话与隔离

进程内 Map 保存会话，不引入数据库、Redis 或复杂 Memory。

会话键：`企业标识 + BotID + single + userid`。

企业标识可用配置的 CorpID 作为命名空间，不依赖用户输入，也不作为长连接认证字段。

会话值：Agent 实例、最近使用时间、忙碌状态、当前 runId。

- A 首问创建 A 的 Agent，A 追问复用。
- B 使用 B 的 Agent，不共享历史或可变 Session。
- 同一实例禁止并发调用 prompt。
- 支持 Adapter 直接处理“清空会话”。

建议默认值（项目策略，非企微官方限制）：

| 项目 | 规则 |
|---|---|
| 空闲会话 | 30 分钟过期 |
| 进程重启 | 历史丢失，重新开始，MVP 可接受 |
| 同人并发 | 上一问未完成时，提示稍后再问 |
| 跨员工并发 | 初始上限 3，可配置 |
| 超过上限 | 回复忙碌，不搭建排队系统 |

## 7. 网络与部署

### 7.1 企业微信如何把消息送到电脑

工作电脑主动建立：

`wss://openws.work.weixin.qq.com`，出站 443。

企微通过这条已建立的连接推送消息，不需要主动访问电脑的 IP 或 HTTP 端口。

参考：[官方连接实现](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/ws.ts)。

| 项目 | 长连接主方案 |
|---|---|
| HTTP Server | 收消息不需要，健康检查以后可选 |
| 自建 HTTPS 和证书 | 不需要，使用官方 WSS |
| 公网入站 IP | 不需要 |
| 自有域名 | 不需要 |
| 网页授权可信域名 | 不做网页授权，不需要 |
| 自建应用 API 可信 IP | 本版不调用应用接口，不作为前置条件 |
| 公司出口放行 | 必须允许企微 WSS 和 DeepSeek API |
| 内网穿透 | 不需要 |
| Nginx / 反向代理 | 不需要 |
| 公司服务器 | 开发验证不需要，长期运行需要常驻机器 |
| 后台配置 | API 模式、长连接、BotID/Secret、可使用成员 |

不要求应用 API 可信 IP，不代表绕过公司防火墙、代理和安全策略。

### 7.2 A：最快开发验证

1. 管理员创建智能机器人，选择 API 模式、使用长连接。
2. 获取 BotID / Secret，范围仅开放你和另一名测试员工。
3. 在本项目配置凭据与身份映射。
4. Windows 启动企微入口，确认认证成功。
5. 两名员工分别单聊，完成真实收发与 Agent 联调。

官方说明提供“安全与管理 → 管理工具 → 智能机器人”的管理后台入口，实际以企业界面及权限为准。

电脑验证期间不休眠、不关机，进程持续运行；公司代理必须允许 WebSocket。

### 7.3 B：公司内部常驻部署

使用同一套长连接进程，部署到公司 VM / 服务器，单实例运行。

建议起步配置：2 vCPU、4 GB 内存、已验证的 Node 版本、企微和模型 API 出站网络、服务自启动与异常重启、基础日志、非管理员服务账号。不需要 GPU。该配置是小规模试用建议，不是容量承诺。

个人工作电脑不适合长期服务：休眠、更新重启、下班关机和网络切换都会让员工无法使用。

Windows Server 可减少迁移；Linux 使用现有 `DCS_SOURCE_ROOT` 指向经授权的只读源码副本。服务器目录和部署操作另行确认，不能擅自写入项目外路径。

同一机器人不要同时连接开发电脑和服务器；迁移先停旧进程，或使用独立开发机器人。官方说明每个机器人同一时间只有一个有效长连接。

参考：[官方部署和连接限制](https://cloud.tencent.com/document/product/1759/121473)。

## 8. 协议与密钥

| 项目 | 本版是否需要 | 用途 |
|---|---|---|
| BotID | 必需 | 机器人标识 |
| 机器人 Secret | 必需 | 长连接认证 |
| CorpID | 可选配置 | 企业命名空间，不用于本版长连接认证 |
| CorpSecret | 不需要 | 自建应用换取 access_token 时涉及 |
| AgentID | 不需要 | 自建应用编号，区别于 Agent 类与 BotID |
| access_token | 不需要 | 文本收发走长连接 |
| 回调 Token | 不需要 | URL 回调签名验证 |
| EncodingAESKey | 不需要 | URL 回调消息加解密 |
| URL 验证 | 不需要 | 仅配置回调 URL 时涉及 |
| HTTP 消息签名验证 | 不需要 | 主方案依靠官方 WSS 和机器人认证 |
| DeepSeek API key | 必需 | 模型调用 |

官方协议命令：认证 `aibot_subscribe`，收消息 `aibot_msg_callback`，回复 `aibot_respond_msg`。回复透传原 `req_id`，同一流式回复保持 `stream.id` 一致。

参考：[官方协议类型](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/types/api.ts)。

凭据从环境变量或部署系统注入，不进源码、Git、日志、Prompt。`.env.example` 仅放占位符。不要完整打印认证帧或回调帧。

### HTTP 备用方案，仅在长连接不可用时启用

增加公司认可的公网 HTTPS 回调地址，实施 URL 验证、签名校验、echostr 解密、POST 消息验签解密和接收方标识校验。快速确认接收，再异步运行 Agent，不等待 LLM 完成才返回 HTTP 响应。

智能机器人 URL 回调与自建应用的格式、回复方式不同，不能混用；不能将所有消息解密的接收方标识都固定写成 CorpID。

如果选择自建应用，另需 CorpID、应用 Secret、AgentID，获取并缓存 access_token，通过应用消息 API 回复原 userid，按接口要求配置可信 IP。

备用路径本轮不实施。若企业没有长连接入口，再核实对应官方回调文档的精确响应时限、域名要求和协议，不同时建设两种通道。

## 9. 异步回复与超时

流程：

```text
收消息 → 校验 / 去重 / 身份 / 忙碌检查
      → 先回复“正在查询，请稍候”
      → 异步 await agent.prompt(text)
      → 获得 Final Answer
      → 更新同一条回复并结束
```

使用官方 SDK 的 replyStream：首次 `finish=false`，最终 `finish=true`。第一版只发处理中和最终答案，不逐 token 转发，不发送思考过程、工具参数、ToolResult 或内部错误。

参考：[官方回复实现](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/client.ts)。

建议项目预算：首次反馈约 1 秒；Agent 总处理 90 秒；为回复重试预留时间。超时回复“这次查询超时，请稍后重试”。发送处理中提示不意味着可无限延长窗口。

腾讯官方接入说明给出三分钟回复窗口，本项目采用更短预算，实际企微联调再确认当前模式表现。欢迎语等事件的 5 秒要求不能直接当作普通问答完整时限。

### 超时实现边界

不能仅 Promise.race 返回超时而让底层继续运行。

- 现有 DeepSeek 适配器小改，支持可选 AbortSignal。
- Channel 创建每次运行的超时控制，通过 StreamFn 外层包装传递 signal。
- 不修改 Agent / AgentLoop 接口。
- 超时取消网络读取，包装层阻止继续发起后续模型请求。
- 使用 runId 忽略过期结果，不发送迟到答案。
- 旧运行结束前不复用该 Agent；必要时弃用会话实例。
- 当前工具只读，不增加通用工具取消框架；未来接真实 API/数据库时设置工具自身超时。

## 10. 最小可靠性

| 情况 | MVP 处理 |
|---|---|
| 重复消息 | 企业标识＋BotID＋msgid 去重 |
| 处理中重复投递 | 不重复运行 Agent |
| 已完成消息重复投递 | 复用缓存结果，不重复执行 Tool |
| 同人并发 | 提示上一问未完成 |
| 多人并发 | 独立会话、小并发上限 |
| Tool 失败 | 沿用 ToolResult 错误，不能解释为查询成功 |
| 模型失败 | 识别 agent_error / 最终状态，发送统一友好提示 |
| Agent 超时 | 取消模型请求，阻止迟到回复 |
| 回复失败 | 缓存最终答案，在有效窗口内有限重试，不重跑 Agent |
| 连接断开 | SDK 重连并记录状态 |
| 进程重启 | 丢失内存历史及去重记录，员工重新开始 |

去重记录建议保存 30 分钟并设容量上限。回复网络失败最多重试两次；凭据、权限错误不盲目重试。必须检查发送回执。

ACK 丢失可能导致送达状态不确定；本版尽量去重，不承诺严格只送达一次。重试沿用原关联消息和 streamId。

持久去重、重启任务恢复放 P1，不引入消息中间件。

## 11. 最小改造范围

```text
src/
├── index.ts                    原 CLI，保留
├── wecom.ts                    新增：企微入口和组装
├── channels/wecom/
│   ├── adapter.ts              新增：收发、去重、回复、超时
│   └── conversations.ts        新增：员工会话、忙碌状态、过期清理
├── dcs/
│   ├── identity.ts             新增：可信 userid → DcsSession
│   └── ……                     现有业务模块复用
└── core/model/deepseek.ts       小改：可选取消信号
```

其他调整：

- package.json：官方 SDK 和 `dev:wecom` 脚本。
- .gitignore：私有身份文件、密钥文件和日志。
- .env.example：仅配置占位。
- 必要测试：身份隔离、去重、超时、回复失败与企微真实联调。
- README：配置、启动和部署步骤。

不建立通用 Channel 框架，不拆微服务。Agent、AgentLoop、消息类型、现有工具接口保持不变。

## 12. Blocker 与 Technical Debt

| 分类 | 内容 |
|---|---|
| Blocker | 无可用机器人权限或凭据 |
| Blocker | 公司网络不能建立长连接 |
| Blocker | 所有人使用张三身份或共享 Agent |
| Blocker | 重复执行、同会话并发导致上下文混乱 |
| Blocker | 不能及时回复，超时后仍发送迟到答案 |
| Blocker | 将 mock 当作真实员工数据 |
| Technical Debt | 原 CLI 显示细节，不影响新 Adapter |
| Technical Debt | 历史不持久化、重启丢失上下文 |
| Technical Debt | 没有管理后台、复杂监控、自动角色同步 |
| Technical Debt | 非阻塞性 Runtime 整理和结构优化 |

源码搜索会把命中内容提交给模型。沿用已经批准的使用范围，服务器仅挂载授权源码。若范围未确认，可暂不向企微 Agent 注册搜索工具，先跑权限/报餐 mock 闭环，不修改工具本体。

## 13. 实施路线

### P0：企微 MVP 必须完成

| 步骤 | 实现 / 模块 | 企微配置 | 测试与成功标准 |
|---|---|---|---|
| P0-1 确认入口 | 确认创建权限和网络 | API 长连接机器人、两名试用成员、凭据 | 员工可找到机器人，电脑可访问 WSS |
| P0-2 回声收发 | wecom.ts、adapter.ts、官方 SDK | 注入 BotID/Secret | 员工发你好，收到固定回复；后端获得可信 userid |
| P0-3 身份 | dcs/identity.ts、私有映射 | 核对试用成员 userid | A/B 身份不同，未知员工拒绝，文字自称他人无效 |
| P0-4 Agent 闭环 | 组装现有 Agent / Prompt / Tools / Hooks | 无新增 | 真实企微提问触发 Tool，返回 Final Answer，mock 明确标识 |
| P0-5 多轮隔离 | conversations.ts | 无新增 | A 追问有上下文，B 完全独立，同人不并发 |
| P0-6 最小可靠性 | 去重、异步回复、回执、超时；模型适配器取消支持 | 无新增 | 同 msgid 不重复执行，失败有提示，无迟到答案 |
| P0-7 两人验收 | 必要测试与说明 | 小范围可见 | 下方真实企微验收清单通过 |
| P0-8 常驻部署 | 公司服务器、自启动、重启、私有配置、日志 | 正式机器人或停止旧连接 | 工作电脑关机后仍可提问，服务重启可恢复连接 |

P0-2 是第一里程碑：先完成真实消息收发，不等全部模块完成再联调。

P0-7 验收清单：

1. A：“为什么我没有权限管理菜单？”
2. A：“那我要怎么申请？”——延续上下文，不编造未经确认的流程。
3. A：“我为什么报不了餐？”
4. A：“那餐标是多少？”
5. B 独立提问，身份和历史不与 A 混用。
6. A 自称 B 并要求查 B 订单，实际查询身份不能改变。
7. 重复投递同一消息，只运行一次 Agent。
8. 模型失败、Tool 失败、超时和发送失败有受控结果。
9. 群聊、非文字消息不执行个人查询。
10. 员工看不到源码、工具参数、ToolResult 或内部错误。

### P1：上线后短期完善

- 选择一个有价值的场景，将 mock 替换为真实只读 DCS 数据。
- 扩大身份映射，必要时接可信身份查询接口。
- 根据真实使用情况增加简单持久化、运行统计、断线告警和日志轮转。
- 观察失败率，调整会话时长及并发上限。

### P2：未来增强

- 通讯录和角色自动同步。
- 群聊与群内隐私策略。
- 图片、文件、语音。
- 多实例、持久任务恢复、复杂知识检索。

上述 P1/P2 不提前纳入当前 P0。

## 14. 实施前确认项

1. 管理员能创建 API 长连接智能机器人。
2. 能提供首批员工的可信 userid 与 DCS 身份对应关系。
3. 公司网络允许企微 WSS 和模型 API 出站连接。
4. 接受当前业务 Tool 仍为明确标识的 mock；真实数据接入另行推进。

执行顺序：**创建机器人 → 电脑回声收发 → 可信身份 → 现有 Agent → 员工会话隔离 → 最小异常处理 → 两人试用 → 公司服务器常驻。**

用户确认本方案以后再实施。
