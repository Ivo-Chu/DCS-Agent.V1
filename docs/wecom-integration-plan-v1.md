# DCS Agent 企业微信智能机器人接入实施方案 v1

- 版本：v1 · 2026-09-22
- 状态：**设计方案，待确认后实施（当前阶段不改代码）**
- 依据：当前项目实际源码（core/dcs/index.ts 十文件 + 测试）、企业微信开发者中心官方文档（智能机器人长连接，document/path/101463）
- 总原则：**上线 > 业务闭环 > 稳定性 > 架构完整度**；企业微信只作 Channel/Adapter，不侵入 Agent Runtime

---

## 1. 现状确认（基于当前实际代码）

| 关注点 | 现状 | 位置 |
|---|---|---|
| Agent 调用入口 | `agent.prompt(text): Promise<string>`，契约上永不 reject | `src/core/agent.ts:55` |
| Conversation / Context 维护 | `Agent.context: AgentMessage[]`（内存数组），每次 prompt 后 newMessages 一次性写回；**一个 Agent 实例 = 一条会话** | `src/core/agent.ts:45,77` |
| 员工身份传入 | `createMockSession()` 硬编码张三/10086 → `toolContext: { session }` + `buildSystemPrompt(session)` 注入身份块 | `src/dcs/session.ts:35`、`src/index.ts:22-33` |
| Tool 获取身份 | `ctx.session.user.employeeNo`，参数 Schema 无身份字段，模型无法指定他人 | `src/dcs/tools.ts` |
| Final Answer 返回 | `prompt()` 返回 finalText；流式增量经 `message_delta` 事件 | `src/core/agent-loop.ts` |
| 身份链路预留 | 方案 §5 早已声明："接入企微时只替换 Session 构造方式，Agent Runtime 零改动" | `src/dcs/session.ts` 头注释 |

**企微 Channel 最适合的接入位置**：`src/index.ts` 目前所做的事情（构造 Session → 组装 Agent → 循环 prompt → 输出 finalText）正是 Channel 层职责。企微接入 = **新增一个与 CLI 平级的 Channel 入口**，复用 `Agent` / `dcsTools` / `createDcsToolHooks` / `buildSystemPrompt`，只替换两样东西：①Session 的构造来源（Mock → 企微 userid 解析）；②输入输出回路（readline → 长连接消息）。

---

## 2. 企业微信能力选型

### 2.1 四个候选对比（经官方文档核实，2026-09）

| 能力 | 能否收消息 | 身份可信 | 公网要求 | 结论 |
|---|---|---|---|---|
| **群机器人 Webhook** | ❌ 只能单向发送 | — | 无 | **淘汰**。正是题述要排除的"只能发不能聊"的伪入口 |
| **自建应用 + 消息回调** | ✅ HTTP 回调 | ✅ FromUserName 明文 | **需要公网 URL + 加解密 + access_token** | 备选（见 §6-B 附注），非首选 |
| **智能机器人 · Webhook 模式** | ✅ | ✅（有条件，见下） | 需要公网 URL + Token/EncodingAESKey | 备选 |
| **智能机器人 · WebSocket 长连接** | ✅ `aibot_msg_callback` | ✅ `from.userid`（有条件，见 §4.1） | **无需公网 IP、无需加解密** | ✅ **选定** |

### 2.2 选定方案：智能机器人 API 模式 · WebSocket 长连接

官方事实（document/path/101463，已逐条核实）：

- 连接地址 `wss://openws.work.weixin.qq.com`，凭 **BotID + Secret** 发送 `aibot_subscribe` 完成认证
- **无需公网 URL、无需域名、无需消息加解密**——官方定位即"无固定公网 IP 场景"
- 官方 Node SDK：`@wecom/aibot-node-sdk`（npm 官方包，避免手写协议帧）
- 消息回调 `aibot_msg_callback` 含 `msgid`（排重用）、`chattype`（single/group）、`from.userid`
- 回复用 `aibot_respond_msg`，**支持流式消息**（`finish=false` 占位/刷新 → `finish=true` 定稿），与 Agent 的 `message_delta` 天然契合
- 限制：**每个机器人同时仅一条长连接**（新连接踢旧连接）；**3 分钟内未完成回复会被截断**（流式占位消息可从收到回调起争取时间）

一句话理由：**它是唯一让员工"像跟同事聊天一样"发消息、且允许你的 Windows 工作电脑直接当开发 Runtime 的官方通道。**

---

## 3. 最小接入架构

```
员工（企微单聊）
   │  自然语言问题
   ▼
企业微信服务器 ──wss 长连接──► src/wecom/bot.ts（官方 SDK：认证/心跳/重连）
                                  │
                                  ▼
                          src/wecom/handler.ts（消息管线）
                            ① msgid 排重
                            ② 非文本消息 → 礼貌拒答
                            ③ 按 userid 串行入队
                                  │
                                  ▼
                  src/wecom/conversation.ts（会话管理器）
                    Map<userid, Agent> + 闲置回收
                                  │ 首次：identity.ts 解析身份
                                  │      → dcs/session.ts 构造 DcsSession
                                  │      → 组装 Agent（复用现有全部件）
                                  ▼
                        现有 Agent Runtime（零改动）
                        prompt() → AgentLoop → Tools → finalText
                                  │
                                  ▼
                  bot.ts：流式占位 → finalText 定稿回复
                                  │
                                  ▼
                              当前员工
```

**分层铁律不变**：`core/` 不出现企微概念；企微相关全部在 `src/wecom/`；`dcs/` 只做一处加法（Session 工厂，见 §4.2）。

---

## 4. 身份设计（重点）

### 4.1 userid 的获取与可信度

- `aibot_msg_callback.body.from.userid` 由企业微信服务器下发，**员工无法伪造**——这就是正式身份链路的"可信 userid"
- ⚠️ **P0 前置决策（重要）**：官方文档明确——**若机器人创建者是企业超级管理员，userid 为明文**；否则为企业主体下的加密 userid，需通过"自建应用与智能机器人的对接"换明文（那就要引入 CorpID/CorpSecret/access_token，复杂度升级）
- **决策：用企业超级管理员账号创建机器人，直接拿明文 userid**，v1 不引入自建应用

### 4.2 userid → employeeNo

方案 §5 早已定调：该转换属于接入层 Identity Resolver，不由 LLM 决定、不受用户输入控制。

v1 落地为**静态映射表**（真实 HR/AD 对接是 P2）：

```jsonc
// config/identity.json —— 加入 .gitignore，绝不入库（含员工敏感信息）
{
  "zhangsan": { "employeeNo": "10086", "name": "张三", "department": "制造一部", "roles": ["普通员工"] },
  "lisi":     { "employeeNo": "10087", "name": "李四", "department": "制造二部", "roles": ["部门助理"] }
}
```

- `src/wecom/identity.ts`：查表；**查不到 → 不构造 Agent**，直接回复"暂未开通 DCS 智能服务权限，请联系 IT 服务台（分机 8888）"——未登记员工零工具可用
- `src/dcs/session.ts` 唯一改动：新增 `createSession(identity): DcsSession` 工厂（保留 `createMockSession` 供 CLI/测试），把映射记录填进 `SessionUser{ source:"wecom", userId, employeeNo, ... }`

### 4.3 身份如何进入 Agent / Tool

与现状完全同构，零新机制：

```
identity.json 查表 → createSession() → DcsSession
   ├─→ buildSystemPrompt(session)  → systemPrompt 身份块（不变）
   └─→ toolContext = { session }   → Agent 构造参数（不变）
                                        └─→ Tool 内 ctx.session.user.employeeNo（不变）
```

### 4.4 防越权（模型指定他人查询）

现有设计天然免疫，无需新增：**三个工具的参数 Schema 无任何身份字段**，模型构造不出 `{"employeeNo":"10087"}`；真正查询对象由可信 `DcsToolContext` 决定。systemPrompt 第 5 条工具规则（"只能查询当前提问员工"）继续作为第二道防线。

### 4.5 多员工隔离

**一个 userid 一个 Agent 实例**，`Map<userid, Agent>` 物理隔离——员工 A 的 context 永远进不了员工 B 的 LLM 请求。详见 §5。

---

## 5. 多轮对话设计

- **延续**：复用现有机制——同一 userid 复用同一 Agent 实例，`agent.context` 自动携带历史。"为什么没有权限管理菜单" → "那我要怎么申请"直接成立
- **隔离**：按 userid 分实例（§4.5）
- **串行**：同一 userid 的消息用 **Promise 链串行化**（员工连发两条时，第二条等第一条 prompt 完成再进 Agent，防止 context 交错写坏）。不同 userid 之间天然并行
- **闲置回收**：每条会话记录 lastActive，**30 分钟**无活动的 Agent 实例惰性清除（下次提问重建，多轮记忆自然过期）。这是 MVP 需要的最小 Session 管理，不是"复杂 Memory 系统"
- **群聊**：P1 再做。届时会话键用 `chatid:userid`（群内每人独立上下文），v1 只支持单聊（chattype=single），群聊@机器人先回一句"请私聊我咨询哦"

---

## 6. 网络与部署（重点，拒绝抽象箭头）

### 6.1 消息到底怎么到达 Agent

```
员工手机/PC 企微
  → 企业微信云端
  → 【出向】wss://openws.work.weixin.qq.com（你的进程主动连过去，TLS 长连接）
  → 消息沿这条已建立的连接被推送到进程
```

**全程只有你向企微发起的出向连接，企微从不主动连你**。所以：不需要公网 IP、不需要域名、不需要 HTTPS 证书、不需要可信域名、不需要 IP 白名单（长连接模式无 API IP 白名单概念）、不需要内网穿透、不需要反向代理。唯一网络要求：**运行机器能出向访问 `openws.work.weixin.qq.com:443`**（国内站点，工作电脑直连即可；⚠️ 注意不要走你那个 7897 代理，wss 过代理容易抽风，为此进程清掉 HTTP(S)_PROXY 或配置 NO_PROXY）。

### 6.2 A. 最快跑通真实消息的开发验证方案（当天可完成）

1. 企微管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 创建（**用超管账号**，§4.1）
2. 开启 API 模式 → 选"长连接" → 复制 BotID / Secret
3. 工作电脑设置两个环境变量，`npm run dev:wecom` 启动
4. 手机企微找到机器人，发"我为什么报不了餐" → 看到真实回复

**完。** 没有第四步。

### 6.3 B. 正式上线推荐部署

工作电脑**不能**当正式 Runtime，原因：下班关机/休眠断网即服务中断、Windows 更新强制重启、公司 IT 策略可能限制长驻进程、无监控无自启、你离职电脑被收走服务就没了。

**最小服务器条件**（长连接模式的最大红利——不需要任何公网入向）：

| 项 | 要求 |
|---|---|
| 机器 | 公司任意一台稳定在线的服务器/虚拟机（Linux 或 Windows Server 均可），**2C2G 起步足够**（Node 进程 + 长连接，内存大头在 context） |
| 网络 | 仅要求**出向** 443 到企业微信；可放纯内网 |
| 运行时 | Node ≥ 22（项目 engines 已定） |
| 进程守护 | systemd / pm2（崩溃自启、开机自启） |
| 实例数 | **只能 1 个活跃实例**（官方限制：每机器人一条长连接，第二个实例会踢掉第一个）。高可用 = 主备，冷备即可，P1 再议 |
| 配置 | BotID/Secret/identity.json 走环境变量 + 本地配置文件，不进 Git |

### 6.4 附：为什么不选自建应用回调

自建应用消息回调需要：公网可访问 URL（→ 要公司分配域名/公网 IP 或穿透）、Token+EncodingAESKey 消息加解密、CorpID+CorpSecret 换 access_token、API 可信 IP 白名单。四样东西每样都是一次跨部门申请。除非未来要做"主动推送消息给任意员工/部门"（aibot_send_msg 在机器人能力内已覆盖大部分场景），否则不值得。

---

## 7. 协议层：哪些真需要，哪些不需要

| 协议要素 | 长连接模式需要？ | 说明 |
|---|---|---|
| URL 验证（GET echostr） | ❌ | 仅 Webhook 回调模式 |
| 消息签名验证（msg_signature） | ❌ | 同上 |
| 消息加解密（EncodingAESKey） | ❌ | 同上（官方对比表："无需加解密"） |
| access_token（CorpID+CorpSecret） | ❌（v1） | 仅自建应用 API 或"加密 userid 转明文"需要；§4.1 的超管决策绕开了它 |
| CorpID / CorpSecret | ❌（v1） | 同上 |
| **BotID / Secret** | ✅ **唯一需要** | 管理后台机器人详情页获取，用于 `aibot_subscribe` 认证 |

**凭据管理**：`WECOM_BOT_ID` / `WECOM_BOT_SECRET` 一律走环境变量（CLI 现有 `DEEPSEEK_API_KEY` 同款模式）；`identity.json` 与 `.env` 加入 `.gitignore`；源码与 Git 中零 Secret（现有 .gitignore 已覆盖 .env，需补 `config/identity.json`）。

---

## 8. 响应时限与 MVP 可靠性

### 8.1 时限问题

- 长连接模式**没有 Webhook 的 5 秒 ack 硬限制**，但**3 分钟未回复会被截断**
- 一次 Agent Loop（LLM→Tool→LLM）实测通常 5–30 秒，远低于上限，但模型慢/连续 Tool 调用存在长尾

**对策（流式占位，官方推荐姿势）**：

```
收到回调
  → 立即 aibot_respond_msg(stream, "正在为你查询…", finish=false)   // 占位，时钟开始
  → Agent 运行中（可选：message_delta 累积到阈值刷新一次占位）       // MVP 可省略刷新
  → 完成：aibot_respond_msg(stream, finalText, finish=true)          // 原位替换定稿
  → 兜底：150 秒未完成 → finish=true 发"这次查询超时了，请换个问法重试"
```

### 8.2 MVP 最小可靠性清单（只保留真正需要的）

| 场景 | 对策 | 不做的 |
|---|---|---|
| 消息重复投递 | `msgid` 内存排重（Map + 24h 惰性清理） | 不做持久化去重 |
| 同员工连发 | userid 级 Promise 串行队列（§5） | 不做全局队列 |
| Agent 超时 | 150 秒兜底定稿（§8.1） | 不做分级超时 |
| Tool 失败 | 现有机制：编码为 isError ToolResult，模型自行解释，无需新逻辑 | — |
| 模型失败 | 现有机制：stopReason:"error" 编码进 finalText，原样回复员工并提示重试 | — |
| 回复失败 | 记日志 + 重试 1 次；仍失败则放弃（员工会再问的） | 不做死信队列 |
| 长连接断开 | SDK/自维护：指数退避重连（≥30s 心跳） | 不做主备切换 |

---

## 9. 最小代码改造范围

| 动作 | 文件 | 说明 |
|---|---|---|
| 新增 | `src/wecom/config.ts` | 读环境变量（BotID/Secret/可选超时参数） |
| 新增 | `src/wecom/identity.ts` | userid → 员工身份查表（config/identity.json） |
| 新增 | `src/wecom/conversation.ts` | Map<userid, Agent> + 串行队列 + 30min 闲置回收 |
| 新增 | `src/wecom/handler.ts` | 消息管线：排重/拒非文本/排队/超时兜底/回复 |
| 新增 | `src/wecom/bot.ts` | 长连接生命周期：subscribe/心跳/重连/收发 |
| 新增 | `src/wecom-server.ts` | Channel 入口（与 index.ts 平级） |
| 小改 | `src/dcs/session.ts` | +`createSession(identity)` 工厂（≤20 行，Mock 保留） |
| 小改 | `package.json` | +script `dev:wecom`；+依赖 `@wecom/aibot-node-sdk`（⚠️ 项目首个运行时依赖，官方 SDK，值得） |
| 小改 | `.gitignore` | +`config/identity.json` |
| **不改** | `src/core/**`、`src/dcs/tools.ts`、`prompt.ts`、`hooks.ts`、`index.ts`、全部测试 | Runtime 零重构 |

**明确不做**：重构 Runtime、多 Agent、Intent Router、RAG、管理后台、消息持久化、复杂 Session 存储。

**既有问题分类**：R1（验收脚本判定）、R2（日志打印）、R3/R4（CLI 显示层）、R5（坏帧挂起边缘 case）——**全部不阻塞企微上线，归入 Technical Debt**（P1 清理）。新引入的 Blocker 只有两个，都在 P0 前置：①超管建机器人拿明文 userid；②identity.json 首版映射数据由谁提供。

---

## 10. 实施路线

### P0 —— 企微 MVP 上线必须完成

**P0-1 ｜ 创建机器人拿凭证（纯后台操作，无代码）**
- 做什么：企微管理后台 → 管理工具 → 智能机器人 → 创建（超管账号）→ 开 API 模式 → 长连接 → 记录 BotID/Secret
- 后台配置：即上述全部
- 测试：凭证在手
- 成功标准：拿到 BotID + Secret；确认创建者为超级管理员（userid 明文）

**P0-2 ｜ 身份映射与 Session 工厂**
- 做什么：`config/identity.json`（≥2 名测试员工）；`src/wecom/identity.ts` 查表 + 未登记拒答；`dcs/session.ts` +`createSession()`；`.gitignore` +identity.json
- 修改模块：wecom/identity.ts（新）、dcs/session.ts（小改）、.gitignore
- 后台配置：无
- 测试：单测——已登记 userid 返回正确身份；未登记返回 null；`tsc --noEmit` 过
- 成功标准：张三的 userid 能造出与 Mock 等价的 DcsSession（roles 含"普通员工"）

**P0-3 ｜ 会话管理器**
- 做什么：`conversation.ts`——`getOrCreate(userid)` 组装完整 Agent（createSession + buildSystemPrompt + dcsTools + hooks + DeepSeek StreamFn）；userid 串行队列；30min 闲置回收
- 修改模块：wecom/conversation.ts（新）
- 测试：FakeStreamFn 单测——两个 userid 的 context 互不可见；同 userid 两条消息串行执行；回收后重建不报错
- 成功标准：A 问两轮（多轮成立）期间 B 提问，B 的 context 里无任何 A 的消息

**P0-4 ｜ 长连接客户端**
- 做什么：`bot.ts`——基于 `@wecom/aibot-node-sdk`：subscribe 认证、30s 心跳、断线指数退避重连、消息/回复帧收发
- 修改模块：wecom/bot.ts（新）、package.json（+依赖）
- 后台配置：P0-1 已完成
- 测试：真凭证启动 → 日志出现 subscribe errcode=0；拔网线 30 秒恢复 → 自动重连成功
- 成功标准：进程在线期间手机企微发消息，进程日志收到 `aibot_msg_callback`

**P0-5 ｜ 消息管线**
- 做什么：`handler.ts`——msgid 排重；chattype≠single 或非文本 → 固定话术；占位流式消息；150s 超时兜底；回复失败重试 1 次
- 修改模块：wecom/handler.ts（新）
- 测试：Fake bot 注入——同一 msgid 两次只处理一次；发图片收到礼貌拒答；FakeStreamFn 沉睡 200s 收到超时回复
- 成功标准：五条边界用例全过，正常问题收到流式占位→定稿两条更新

**P0-6 ｜ 入口与脚本**
- 做什么：`wecom-server.ts` 组装 bot+handler+conversation；`package.json` +`dev:wecom`；README 补企微章节
- 测试：`npm run dev:wecom` 缺环境变量时优雅退出并提示（同 CLI 现有风格）
- 成功标准：一条命令起服务

**P0-7 ｜ 真机端到端验收**
- 做什么：两名真实员工（张三/李四已入映射表）各自手机企微完成：三问验收场景 + 交叉隔离验证 + 未登记同事 C 提问
- 后台配置：把测试员工加进机器人可见范围
- 测试/成功标准：
  1. 张三"为什么我没有权限管理菜单" → 只查权限，答"缺系统管理员角色"
  2. 张三"我为什么报不了餐" → 权限→订单，答"超餐标 7 元被驳回"
  3. 张三追问"那餐标是多少" → 不重复查权限，答 35 元
  4. 李四同时提问 → 互不可见对方上下文；李四查自己报餐 → "暂无报餐订单"（mock 只有 10086 有单）
  5. 同事 C（未登记）→ 收到"暂未开通"话术，全程无工具调用
  6. 全程日志无明文 Secret、回复无源码路径

### P1 —— 上线后短期完善

群聊@机器人（chatid:userid 会话键）；回复失败重试策略完善与结构化日志；Technical Debt 清理（R1–R5）；identity.json 热加载；欢迎语（aibot_respond_welcome_msg）；运行监控告警（断线/异常通知管理员）

### P2 —— 未来增强

真实身份链路（对接 HR/AD 或 DCS 员工表做 Identity Resolver）；会话持久化与跨重启恢复；主动消息推送（报餐截止提醒等）；多机器人/主备 HA；RAG 知识库；管理后台

---

## 附：关键官方文档

- 智能机器人长连接：https://developer.work.weixin.qq.com/document/path/101463
- Node SDK：https://www.npmjs.com/package/@wecom/aibot-node-sdk
