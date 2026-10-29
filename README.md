# DCS Agent v1 — 功能与技术说明文档

> 状态：**现行（项目唯一现状文档）**；docs/ 为决策历史、audit/ 为修复档案、docs/archive/ 为已废弃方案，冲突时以代码为准（详见 AGENTS.md）
> DCS 员工智能助手：自研轻量 Agent Runtime + 企业微信机器人 / 网页端两个接入通道 + 真实 Oracle 数据查询、本地知识库（LanceDB + 集团 Embedding/Rerank）、数据库元数据与只读源码调查工具
> 版本：v1.x · TypeScript / Node 22.13+ / ESM（运行时依赖：@wecom/aibot-node-sdk、oracledb）

---

## 自然语言取证 V2（2026-10-28，候选实现）

现有 DCS Web 聊天直接输入普通中文问题即可，例如“通讯录怎么查不到其他厂区的人？”。实质性请求默认进入取证；整条问候/感谢/结束语、已有回答的明确简化或格式改写才保留 auto 流式回答。混合问候、新业务追问及不确定输入仍取证。这是保守产品策略，不是完美自然语言分类。CLI/企微保持原入口默认策略；`/查源码` 保留为源码专用兼容入口，空指令不请求模型。

首轮 required 提供当前已配置且在服务端执行范围内的工具，模型选择文档、源码、授权数据或导航；后续 auto 仍受同一工具边界限制。源码需配置真实 DCS_SOURCE_ROOT，知识库需配置和已有索引，数据库需已有连接配置；不进行额外健康探测或提升权限。`request_clarification` 仅允许缺失信息类型，输出固定问题并结束为 awaiting_input，不计为证据或任务完成。仅剩澄清工具时直接说明调查能力不可用。

复用 evidence 模块分别记录实际回填模型的文档原文及出处、源码路径/行号、执行查询及完整性、导航状态。文件路径、地图、表结构、资源文字、错误和模型自述不算依据；空查询仅支持本次已返回范围内无记录。opened/switched 后可继续调查复合问题，无其他依据时最终仅允许固定导航确认；needs_selection 等待用户选择。没有依据时仍最多补救一次，不延长预算。

业务地图匹配名称、别名、可选菜单上下文和页面路径，规范化后支持问题包含业务名称，保留全部候选和 matchBasis。取证前轻量本地匹配不算工具证据；已验证目标存在时，无关文件不能满足目标源码门槛。sourceContentObtained 仍只表示取得过源码，sourceRelations 单独记录与引用范围的关系；未登记目标、同名歧义及未经核实的跨模块关系仍未确认，不禁止继续读取。当前前端未主动提供页面上下文；API 可选 pageContext `{title,path}` 仅作本次定位线索，已做合成 HTTP 验证，不能声称已接通真实页面上下文。

源码搜索结果注明 literal/regex/glob/feature。疑似正则但未启用 regex 只提示、不改语义；连续空结果提示检查模式和目录。显式窄目录 text 搜索在同 Run、条件/分页相同且文件成员与内容哈希一致时可复用，最多 64 文件/2 MiB/16 项；全库或无法核验的范围继续真实搜索。源码读取输出 requestedRange、returnedRange、endReason、next；coverage=not_assessed，hasMore=false 不代表业务已查全。阅读与回答提示要求完整表单/过滤实现、多要点覆盖、输入类型及具体边界值；这些提示不能保证答案正确。

调查模式的所有候选文字均先缓冲，工具进度照常显示；中间/被拦截草稿不进入正式消息或后续上下文，保留 ToolCall/ToolResult 配对。JSONL 记录每轮 toolChoice、实际工具 Schema、policyState（状态与来源）、draftDisposition 和最终 completionReason；原始草稿只在诊断日志中保留。模型错误、取消、超时和轮数耗尽仍按失败退出。

`npm run check` 包含策略、Loop、真实 Web HTTP 入口、地图/缓存和阅读范围的合成离线回归。`node --import tsx test/evidence-live.ts --v2` 复用 Web 工厂和 JSONL，对三道普通中文问题做集团模型烟测，只允许源码工具和固定澄清；不查询生产数据库或实际导航。可用 `--case=contacts|jobs|dorm` 针对性复测。V2 原始 Trace 位于忽略目录 `data/harness-v1/v2/runs/`；不带 --v2 的旧入口保留。这是流程/缺陷烟测，不是业务成功率评测。Qwen 序列化仅移除不兼容的模型侧 uniqueItems，原 Schema 和执行端校验保留。

三个批次分别为入口与按来源取证、地图与搜索、阅读与回答质量。本机 `data/harness-v1/v2/stage-0..3` 保存批次前后文件及哈希，保留实施前所有未提交修改。按 3→2→1 顺序运行 `node data/harness-v1/v2/rollback.mjs N` 可单批回退；脚本发现快照后改动会拒绝覆盖，回退后需重跑 check。此目录被 Git 忽略，不随仓库分发。本轮没有自动重启或部署；使用当前候选需重启 Agent Node Web 后端（`npm run web`），不是仅刷新网页；本轮未修改前端构建。

当前验证状态：三个批次及最终完整 `npm run check` 均通过，V2 新增 59 项合成场景（策略30、Web11、搜索地图10、阅读8）；真实本地地图四种自然中文查询匹配并通过引用校验。集团模型烟测尚未执行：自动审批拒绝向具体端点发送内部源码片段，正在等待明确出站授权；不能声称工具选择、业务正确率或耗时已有改善。详细状态见本机 `data/harness-v1/v2/verification-status.json`，最终离线日志为 `batch3-final-check.log`。

## Harness V1 候选原型（2026-10-28，尚未生产验收）

- 保留现有单 Agent / AgentLoop、Qwen Provider、工具注册与 JSONL 观测链路。Harness V1 对比时按需 Prompt 仅用于 C 配置；后续 V2 已移除生产 Prompt 的固定工具组合要求，并补充阅读边界提示，见上节。
- `search_dcs_code` 增加 `mode: "feature"`，仅接受 `pattern/offset/limit`；业务入口未找到或失效时可继续使用原有 `files/text`。结果仅提供线索，需 `read_dcs_code` 核实业务实现。
- 本地地图默认 `data/harness-v1/source-map.json`，可由 `DCS_SOURCE_MAP_FILE` 指定。整个 `data/harness-v1/` 已忽略，不提交公司映射、标准事实及报告。字段结构为 `version: 1, entries: [{ name, aliases, page, controller, action, verification: { status, basis, checkedAt }, references: [{ path, startLine, endLine, sha256, role }] }]`。`role` 为 route/controller/view/implementation；必须具备前三种依据，所有引用复用既有路径边界检查，验证行号和文件全文 SHA-256。不自动生成“已验证”状态；登记前须核实路由、控制器和视图关系，哈希检查不能替代语义核实。
- 第一版本地地图覆盖通讯录、重点/一般岗位、宿舍床位统计（宿舍管理的一个子功能）。仅确认当前静态源码的页面关系，未确认线上部署、菜单或员工权限。地图不含标准答案；评测事实另存 `cases.json`，只供评测端使用。
- 参数错误返回 `status/field/actual/allowed/example`。仅文本搜索的非负整数 `contextLines > 5` 自动取 5，在结果 `corrections` 中记录原值和新值；其他字段不自动改写。结果新增 `kind: source/resource/other`、分页单位及解释，仍保留所有真实搜索结果、匹配行、上下文与续读位置。资源类型标注不是相关性排序。
- 离线验证：`npm run test:harness:v1`（合成数据、真实 rg/文件系统）已纳入 `npm run check`。当时完整 check 已通过，并修正了既有知识库测试依赖过期 Prompt 示例的断言。
- 真实模型对比入口：`npm run test:harness:v1:live`。需先准备本地 `baseline/source-tools.ts`（固定原始工具）、`baseline/prompt.txt`、`source-map.json` 和 `cases.json`（至少三个领域，含 question/expectedFacts/evidence）。本机准备及固定记录保存在忽略目录；入口复用 `acceptance-harness.ts` 的结果分类/报告及现有 JSONL observer。A=原始工具/Prompt，B=参数与结果改进（不暴露 feature），C=B+feature+按需调查 Prompt。每题独立三次，轮换配置次序；固定模型、轮数与 120 秒预算，记录源码引用全文、地图、用例、工具和 Prompt 校验信息。
- 实验为**源码隔离评测**：使用模拟身份，非源码工具统一返回不可用，不解析真实员工身份、不查询生产库。它不是完整线上 Agent 业务验收。标准答案不进入模型消息，业务正确率、定位准确率、错误恢复和无依据事实数留给逐 Trace 审核；不能用正常完成或工具命中代替成功。2026-10-28 经用户授权已完成 27 次真实 Qwen3.5 隔离运行（3领域 × A/B/C × 3次），源码引用校验保持一致；逐源码/Trace初评三组业务通过均为0/9，人工标准事实及业务签字仍待确认。目前不建议合并生产或扩大模块覆盖。
- 当前可复查结果：本地 `data/harness-v1/offline-results.json`、`check.log`、`baseline/manifest.json`。直接重放三次 `contextLines:20` 输入，原始工具均报参数错误，候选均成功；四个业务入口均通过文件、行号及哈希校验。这是工具层验证，不能折算成模型业务成功率。原有 24 次通讯录运行仅作故障材料，不计为 24 道题。
- 真实实验结果（本机报告 `data/harness-v1/runs/2026-10-28T01-24-23-947Z/source-review.json`，27份Trace同目录）：A/B/C正常结束分别3/9、3/9、9/9；超时6、6、0；模型调用15、15、9；工具调用10、19、0；平均耗时110.0、111.5、91.0秒。三组均未调用read_dcs_code；C从未使用feature。A有1次返回全部目标文件路径，B有部分定位但无完整命中；路径命中不代表业务证据充分。参数错误及contextLines自动修正均未触发，不能声称错误率或恢复改善。首轮模型响应耗时中位90.4秒，120秒预算显著限制多轮调查；本实验不能单独归因于工具或Prompt。无依据业务主张按去重主张组初评标注11/13/37组，虚构调查过程3/6/7项，逐项内容可在报告复核。A/B各6次调用缺失usage，仅报告已知小计，不估算完整Token。
- 实践参考：[Harness engineering](https://openai.com/index/harness-engineering/) 的渐进式上下文与可读环境，以及 [Agent improvement loop](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop) 的固定用例、Trace、评估闭环；未引入其 SDK 或多 Agent 运行时。

## 本机日志查看页（2026-10-23）

- Agent Web 根地址直接打开显示日志页；DCS iframe 内仍显示原聊天界面，不更改 DCS 接入地址。
- 使用现有 Web 服务，前端在 DCS Agent.web 执行 npm run build 后，重启 npm run web，本机访问 http://localhost:8787（以 WEB_PORT 为准）。
- 左侧选择 Run，右侧按 Loop 展开 System Prompt、工具定义、Context、模型输出和工具执行；支持复制和手动刷新。
- GET /api/logs 返回摘要列表，GET /api/log?file=... 返回指定日志；接口只接受本机连接，读取现有 logs 及 Web 子目录，不创建或续期聊天登录。
- 新 JSONL 保存每轮工具 Schema、模型输出及完整上下文/工具结果（继续凭据脱敏，不再按 8000 字符截断）；终端保留既有摘要和展示上限。工具自身裁剪的数据不能由日志恢复。
- 旧日志缺少的字段显示未记录，旧截断标志保留；不完整行显示数量。页面仅展示已落盘记录，没有 run_end 时显示尚无结束记录，不推断仍在运行。
- Web 日志继续随会话过期清理。无新数据库、实时推送或桌面打包。
- 新增验证：npm run test:logs（多轮完整输入输出、脱敏、旧/不完整日志及读取接口），已纳入 npm run check。

## Web 多会话与本地过期（2026-10-22）

- 复用 DCS Web 的 Home/GetSSOCode 和 WebApi 的 Account/CheckSSOCode。Node 配置 DCS_SSO_CHECK_URL（本机通常 http://localhost:19999/api/Account/CheckSSOCode）；无专用服务密钥、DCS 登录状态查询或退出通知。
- DCS Web 与 WebApi 是两个服务，本机调试都需运行。正式环境沿用既有 WebApi 地址。DCS_ALLOW_WEB_TEST_IDENTITY 默认关闭。
- Node 根据验证后的工号生成/恢复本地 Agent 会话。同一工号共享尚未过期的一组对话；不同用户隔离。agentSessionId 不依赖 DCS Session。
- 连续 30 分钟无操作后主动清理本次全部对话、上下文和内容日志，并使所有相关 Token 失效。实际 API 操作续期；无心跳、无 DCS 巡检。运行中的回答不按空闲清理，结束后重新计算 30 分钟。
- SQLite 保存到期时间；Node 重启只做本地过期处理，未过期会话重新 SSO 后恢复。停机期间不能执行清理，启动后补清理。
- 关闭窗口保留未过期对话；过期前端不专门推送，下次操作重新认证并恢复新会话，不自动重发用户的问题。
- 复用两表存储（logins 为本地会话范围、conversations 为对话）。旧数据仅增加 expires 列，按原 updated 时间加 30 分钟计算，已过期数据首次启动按规则清理；不直接删库或迁移到按工号永久保存。
- GET/POST /api/conversations，GET/DELETE /api/conversation；聊天和导航结果均带 conversationId。保持同员工单 Run、完整上下文检查点和删除后不重新写回。
- DCS 主页面加载自动打开助手（刷新也打开），单击图标重开；Layer 无遮罩。空对话显示固定功能介绍，不调用模型。
- 助手使用 rdev/liquid-glass-react 1.1.1 的真实 SVG 折射组件：窗口折射层由前端构建产物 assets/dcs-glass.js 挂载在 DCS 父页面，输入框复用同一组件；父页面独立应用 18px 背景虚化，折射限制在边缘。滚动消息使用普通浅色衬底，不挂载逐条折射滤镜，装饰层不拦截点击。尺寸变化重建装饰层，关闭窗口卸载父页面组件。左上角会话入口复用闭合的 DCS 云形图案。前端 npm run build 同时生成聊天页面和父页面 IIFE 资源，构建后需刷新 DCS 主页面。完整位移效果以 Chromium 浏览器为准；Safari/Firefox 的效果受上游支持限制。
- 导航复用 GetNewMenus 与 miniTab；已交给父页面的导航不因关闭助手或停止回答撤销，结果只回传原窗口。保留授权菜单、消息来源和请求对应关系。
- Web 内容日志继续按会话/对话归属存放，不混入 CLI/企微日志。数据文件不得置于 dist。Node 要求 22.13+，使用内置 node:sqlite。
- 验证命令：后端 npm run check、npm run test:dcs；前端 npm run typecheck、npm test、npm run build。隔离测试不等于真实 IIS/Oracle/模型联调通过。

## 1. 项目定位

自研一套**最小可用的轻量 Agent Runtime**（架构思想参考 Pi，零 Pi 依赖），面向 DCS 员工提供系统问题自助解答。当前工具为**知识库检索**（`search_dcs_knowledge`，本地解析 + LanceDB + 集团 Embedding/Rerank）、**数据库查询**（`query_dcs_data`）、**数据库结构**（`inspect_dcs_schema`）、**源码搜索/读取**（`search_dcs_code` / `read_dcs_code`）和**结果读取**（`read_dcs_result`），接入通道为**企业微信机器人**（`npm run wecom:bot`）与**网页端**（`npm run web`），另有 CLI REPL（`npm run dev`，默认模拟身份，用于开发调试）。

```
User Prompt → Agent → AgentLoop → LLM → ToolCall → Tool Execution
→ ToolResult → LLM → Final Response → newMessages 写回 Agent Context
```

身份链路：CLI 默认模拟身份；Web / 企微走真实身份解析（DCS SSO / 企微 userid → S2_Employee 数据库解析，仅在职，见 §5.2）。

---

## 2. 目录结构

```
dcs-agent/
├── package.json              # scripts: dev / typecheck / test / test:accept / test:live
├── tsconfig.json             # ESM + strict + allowImportingTsExtensions
├── src/
│   ├── core/                 # 通用 Agent Runtime（零 DCS 业务依赖）
│   │   ├── types.ts          # AgentMessage / ToolDefinition<P,C> / ToolHooks / StreamFn
│   │   ├── events.ts         # AgentEvent 最小生命周期集（7 个）+ Emitter
│   │   ├── agent.ts          # Agent：状态持有 + prompt() + subscribe()
│   │   ├── agent-loop.ts     # AgentLoop：无状态单次 Run 执行器
│   │   └── model/
│   │       └── openai-compatible.ts   # OpenAI 兼容客户端（Qwen3.5-35B，SSE 流式）
│   ├── dcs/                  # DCS Domain Layer（业务、身份、安全）
│   │   ├── session.ts        # SessionUser / DcsSession / DcsToolContext + Mock 会话
│   │   ├── prompt.ts         # systemPrompt 定稿文案 + 当前员工身份注入
│   │   ├── hooks.ts          # afterToolCall：PII 脱敏（手机号 / 身份证）
│   │   └── tools.ts          # 四个 DCS 工具的稳定注册列表
│   ├── observability/        # 日志系统（2026-10-12）：同一事件流 → 中文终端日志 + JSONL 结构化日志
│   │   ├── observer.ts       # attachRunObserver：订阅 Agent 事件、统计与编排；幂等 end(reason) 保证超时/断开恰一次落盘
│   │   ├── formatter.ts      # 中文终端格式化（NORMAL/DEBUG 两级，ANSI+符号双标识）
│   │   ├── jsonl-writer.ts   # 每 Run 一个 logs/*.jsonl，缓冲落盘、写失败不影响主流程
│   │   └── redact.ts         # 日志脱敏统一防线（仅凭据：字段名+嵌套结构识别；保留业务明细/路径/SQL 字面值）
│   └── index.ts              # CLI REPL 入口（组装 core + dcs）
└── test/
    ├── smoke.ts              # 42 项冒烟测试（FakeStreamFn，无需 API key）
    ├── acceptance.ts         # 三个验收场景端到端脚本
    └── llm-live.ts      # LLM 真实 key 单测（需环境变量）
```

**分层铁律**：`core` 中不出现任何 DCS / 企微 / 工号 / 脱敏规则等业务概念（已 grep 验证：仅注释中作为举例提及）。DCS 相关的 Session、Prompt、工具、脱敏全部在 `dcs` 层实现与组装。

---

## 3. 核心架构

### 3.1 Agent / AgentLoop 职责拆分

参考 Pi 的设计思想（`packages/agent/src` 的 Agent 与 AgentLoop 拆分），自行实现最小版本：

| | Agent (`core/agent.ts`) | AgentLoop (`core/agent-loop.ts`) |
|---|---|---|
| 角色 | 有状态外层对象 | 无状态单次 Run 执行器 |
| 持有 | 历史 context、systemPrompt、tools、toolContext、hooks、streamFn、maxTurns、Emitter | 无任何长期状态 |
| 对外 API | `prompt(text)`、`subscribe(fn)`、`readonly context` | `runAgentLoop(prompts, context, config)` |

**三个核心概念的边界**：

- `prompts` —— 本轮新增输入
- `context` —— 此前已存在的历史上下文（AgentLoop 只读，不修改）
- `newMessages` —— 本轮运行产生的全部新增消息（含本轮 UserMessage、各轮 AssistantMessage、ToolResultMessage）

### 3.2 prompt() 的消息所有权流转

```
agent.prompt("为什么我报不了餐？")
  1. 创建本轮 UserMessage
  2. UserMessage 作为 prompts 传给 AgentLoop
  3. 已有历史消息作为 context 传给 AgentLoop
  4. AgentLoop 执行完整循环（LLM → Tool → LLM → …）
  5. 返回本轮全部 newMessages
  6. Agent 将 newMessages 一次性合并进历史 context
  7. Agent 返回最终 AssistantMessage 文本
```

### 3.3 AgentLoop 单次 Turn 的执行链

```
历史 Context + 本轮 Prompts
        ↓
   调用 StreamFn（SSE 流式）
        ↓
  聚合 text_delta / tool_call_* 事件 → AssistantMessage
        ↓
  停止判定（stop / length / error / 无工具调用 → 退出循环）
        ↓
  顺序执行工具：
    beforeToolCall（可选扩展点）
      → Tool.execute(args, ctx)
      → afterToolCall（PII 脱敏管线）
      → ToolResultMessage 写入 workingMessages
        ↓
   下一 Turn LLM（ToolResult 已回填）
        ↓
   Final AssistantMessage
```

核心默认在模型停止或 `maxTurns` 用尽时退出（核心默认8，DCS工厂32）。DCS请求级策略还可要求一次补救、返回无法核实说明或结束为 awaiting_input；这些都复用同一个 Loop 和原预算。取证模式的截断、流中断、取消及模型错误仍按失败处理。
明确裁剪掉的 Pi 机制：消息队列与 queue draining、shouldStopAfterTurn、prepareNextTurn、工具并行执行。

### 3.4 事件系统（最小生命周期集）

仅保留有真实消费者（CLI）的 7 个事件：

| 事件 | 消费场景 |
|---|---|
| `agent_start { prompt }` | 会话日志 |
| `message_delta { text }` | CLI 流式显示 |
| `assistant_message { message }` | 每轮最终消息（日志） |
| `tool_execution_start { toolCallId, toolName, args }` | CLI 显示工具调用 |
| `tool_execution_end { toolCallId, toolName, isError, summary }` | CLI 显示工具结果 |
| `agent_end { finalText }` | 会话日志 |
| `agent_error { message }` | CLI / 日志错误提示 |

Emitter 为同步实现，单个消费者异常不阻断事件流。不实现 `turn_start` / `turn_end` / `progress` / `update` 类事件。

### 3.5 日志系统（observability，2026-10-12）

**唯一数据流**：`Agent Runtime → AgentEvent → attachRunObserver →（脱敏）→ Console Formatter（中文终端日志）+ JSONL Writer（logs/*.jsonl）`。core 只产生通用执行事件、零展示逻辑；日志系统的任何故障不影响主流程（observer 异常全部吞掉，JSONL 写失败仅标记不再写）。

- **core 侧新增 4 个结构化事件**（原 7 个事件字段语义不变）：`run_start` / `model_call_start` / `model_call_end` / `run_end`；`tool_execution_*` 增加 `runId / turn / step / durationMs / details`（工具自带统计：行数、命中数、错误码等）。Agent 为每次 `prompt()` 生成 runId。
- **Token 统计**：模型请求带 `stream_options.include_usage`，Provider 返回的真实 usage 逐轮记录；**未提供记「未提供」/ JSONL 记 null，绝不估算冒充**。部分轮次缺失时总量标「未知」并保留已知小计与覆盖轮数（不把小计冒充完整总量）；缓存读取/写入分别累计、不与输入 Token 相加。真实 0 与未提供严格区分。消息数不等于 Token，本系统不做近似换算。（集团网关对 `include_usage` 的兼容性未实测，列为限制。）
- **终端日志两级**（`DCS_LOG_LEVEL`，默认 normal）：normal 显示轮次/工具块（[01] 编号、SQL 结构、行数、耗时、状态符号 ✓/✗/⚠）与结束统计；debug 追加参数摘要、toolCallId、字段列表、停止原因、完整工具结果（含 hook 处理前后差异）与 Provider 原始 finish_reason。**DEBUG 不绕过凭据脱敏**。共享终端时终端行统一带 `[runId]` 前缀，多 Run 可区分归属；工具开始时立即输出 `▶ 工具调用 [NN] 名称` 简洁提示。
- **JSONL**：每 Run 一文件 `logs/YYYY-MM-DD_HH-mm-ss_<runId>.jsonl`，一行一条独立 JSON（`run_start / model_call_start / model_call_end / tool_start / tool_end / run_end`），含 timestamp/runId/turn/step/耗时/统计。缓冲 ≥20 条后台落盘，run_end flush。多 Run 并发按 runId 隔离，互不串日志。
- **脱敏统一防线（redact.ts，2026-10-13 边界澄清后收敛）**：开发者日志允许员工工号、姓名、业务查询明细与排障所需源码路径；仅脱敏访问凭据——按字段名+嵌套结构识别（password/token/apiKey/accessToken/secret 等，覆盖对象与数组），外加文本内常见凭据赋值形态（与 hooks.ts CREDENTIAL_RE 同规则）。Token 用量统计字段（inputTokens 等数字）明确排除不误脱敏。SQL 保留双引号字段名与业务字面值。脱敏只作用于日志副本，不改变工具参数/结果与模型上下文（对话输出保护仍由 dcs/hooks.ts maskPii 管线负责）。
- **结束与落盘（2026-10-13 修复）**：observer 提供幂等 `end(reason)`——Web 超时/客户端断开、企微超时（AgentRunner.onRunEnd 回调）记录准确结束原因并 flush；正常 run_end 与通道清理重复到达只终结一次，迟到事件不重开已结束日志。测试可 await flush，不依赖固定睡眠。
- **三通道统一接入**：CLI / Web / 企微在每次 Run 前 `attachRunObserver`（channel 标识区分），结束自动注销。Web/企微的回复机制与 SSE 协议不变，日志只写到服务端终端。run_start 的模型/Provider 标识由 factory 统一从 Provider 配置获取（不含服务地址），通道不再各自读环境变量猜测。默认日志位置固定为项目根 `logs/`。

---

## 4. 模型接入（core/model/openai-compatible.ts）

- OpenAI 兼容 `/chat/completions` 接口，SSE 流式解析（逐行 `data:` 前缀，支持 `[DONE]`、`tool_calls` 增量聚合）
- 可配置：`LLM_API_KEY` / `LLM_BASE_URL`（必填，填写部署方提供的 Base URL，含 `/v1`）/ `LLM_MODEL`（默认 `Qwen3.5-35B`）
- CLI / Web / 企微统一经 `createDcsAgent → createOpenAiStreamFn → fetch` 调用模型，旧 `DEEPSEEK_*` 不再读取；迁移时将本机配置改为 `LLM_*`。
- 含工具时显式发送 `tool_choice: "auto"`；模型名为 `Qwen3.5-35B` 时发送 `chat_template_kwargs: {"enable_thinking": false}`。不添加采样参数。
- **v1 错误契约**：StreamFn 永不抛异常、永不 reject；API / 网络 / SSE / 鉴权失败统一编码为 `stopReason:"error"`，错误说明置于 `message_end.errorMessage`，由 AgentLoop 转写为错误 AssistantMessage 并终止 Run
- `AgentMessage → OpenAI messages` 的角色转换只发生在此处（LLM 调用边界）：`user→user`、`assistant(+toolCalls)→assistant`、`toolResult→tool`
- 双保险：即使 StreamFn 违反契约抛异常，AgentLoop 也会兜住并编码为 error，Run 不崩溃（冒烟测试 G3 验证）

本次迁移实测（2026-10-09）：

- **PASS**：集团接口普通对话 HTTP 200、非流式原生自动工具调用、真实 SSE 分片、工具结果关联回填；现有适配器无需改动 SSE 解析器。
- **PASS（迁移工作树首次验证）**：`npm run typecheck`、`npm run check`、`npm run test:live`、`npm run dev` 普通问答（无工具调用）。Web 测试依赖同级真实前端目录，隔离工作树需准备该目录；不修改测试断言。
- **PASS（链路）**：现有工厂 + Runtime 实际执行源码调查（限定具体方法，两次调用）和知识库检索（明确指定文档，一次调用），工具结果回填后自然结束，无同一调用 ID 重复执行。使用 CLI 原有模拟身份，不代表真实员工验收。
- **PASS（上下文/错误接线）**：菜单权限问题触发真实数据库工具，缺数据库配置返回错误后仍生成答复；随后追问“那这个权限该怎么开通？”保留上文语境。该结果不证明数据库事实或业务回答正确。
- **FAIL（D 盘同步后复测）**：`npm run test:live` 的 DCS 工具场景 2e 未调用工具，直接从普通员工角色推断无权限；其余文本、虚拟工具 SSE、结果回填和错误契约通过。保留严格断言，当前 live 总结果为 FAIL；先前 PASS 仅代表当次结果。
- **FAIL（行为）**：独立会话询问“请查询知识库，告诉我 DCS 权限申请的操作流程，并保留出处。”时，一次未执行检索便生成流程及虚构出处；明确要求调用工具检索指定文档的另一次测试通过，不能覆盖此失败。
- **FAIL（长会话）**：菜单权限、多轮追问后继续广泛源码调查，15 次源码调用后超过服务端 32,768 token 上限，返回 HTTP 400；错误被编码为 error，后续同会话也因超限失败。本次不添加压缩或修改上下文机制。
- **UNVERIFIED**：真实数据库权限、真实员工案例驱动验收及 Web/企微真人端到端。`test:accept:live` 实际因缺 "DCS_DB_*" 跳过，真实案例也未准备。代码迁移已实施，但整体验收尚未通过。


---

## 5. 身份与安全设计

### 5.1 当前身份与查询口径

- Web SSO / 企微身份解析继续构造当前员工会话，供对话和原有菜单导航使用；CLI仍使用开发模拟身份。
- 当前调查工具为受限源码读取 + 通用只读SQL。SQL和binds可以指定业务查询目标，不再由固定目录绑定员工级数据范围。
- Schema和SQL工具使用数据库连接账号实际可见的对象；查询工具保留只读事务。此行为与历史Tool V2.1固定授权目录不同，现状以第6节及源码为准。

### 5.2 正式身份链路（2026-09-24 已实现，两级解析）

```
企微用户 → 可信 userid → 接入层 Identity Resolver（dcs/identity.ts）
  ├─ 第 1 级：identity.json 手动覆盖（可选，测试时强制指定身份）
  └─ 第 2 级：S2_Employee 数据库（UserId → Code/Name/DeptName，仅在职 LeaveDate IS NULL）
→ 构造 DcsSession → 传入 Agent toolContext
```

- `userid → employeeNo` 转换不属于 Agent Tool，不由 LLM 决定、不受用户输入控制（与 DCS 系统自身企微链路同一映射，源码证据：`EmployeeSet.GetEmpCode(userId)`）
- **schema 自动发现**：S2_Employee 所属 schema 优先取 `DCS_DB_SCHEMA` 显式指定；未设置时自动查 `ALL_TABLES` 发现（唯一 OWNER 自动采用 / 多个要求显式指定 / 无法访问报权限错误），进程内缓存一次
- 数据库层解析结果按 userid 缓存 10 分钟（进程重启刷新）；userid 走字符白名单（防 SQL 注入）；数据库故障按未识别拒答（不崩溃）
- roles 暂为空数组（ADM 权限表接入前）；权限类问题由模型通过 query_dcs_data 查库解决
- Agent Runtime 零改动——只替换了 Channel 层的 Session 构造数据源

### 5.3 PII 脱敏（dcs/hooks.ts）

管线位置：`Tool.execute → 原始 ToolResult → afterToolCall → 脱敏 → 写入消息 → 下一轮 LLM`——模型收到的一直是脱敏后的文本。

| 类型 | 规则 | 示例 |
|---|---|---|
| 11 位手机号 | 保留前 3 后 4 | `13812345678` → `138****5678` |
| 18 位身份证 | 保留前 6 后 4（先于手机号处理，避免部分匹配） | `110101199001011234` → `110101********1234` |

`beforeToolCall` 的业务校验 v1 有意不实现（tools 列表本身已是静态白名单），core 保留该扩展点供未来动态 Tool 权限 / 高风险审批使用（冒烟测试场景 D 验证了阻断契约可用）。

### 5.4 systemPrompt 防泄漏约束

`dcs/prompt.ts` 按源码、元数据、SQL和文档组织证据；注入源码目录和当前员工身份。未知结构先调查、已知条件直接查询，大结果由受限工具继续读取；保持原知识库检索规则和依据证据作答要求。

---

## 6. 工具清单（2026-10-23 只读调查）

六个基础工具，Web 另注入现有菜单导航。保持单 Agent、单 Loop，不增加框架或依赖。

| 工具 | 参数 | 当前行为 |
|---|---|---|
| `search_dcs_code` | `mode/pattern/directory/glob/regex/contextLines/offset/limit` | files按路径glob找文件，text搜索文本/正则；直接调用rg，不经过Shell |
| `read_dcs_code` | `files[{path,startLine,lineCount,startColumn}]` | 一次读取1–5个源码片段，返回行号和next续读位置 |
| `read_dcs_result` | `resultFile/select/offset/limit` | 只读SQL/结构结果文件，选择JSON条目或长字符串分页 |
| `inspect_dcs_schema` | `operation=search/describe/definition` | 查询字段、约束、索引、依赖、视图及程序定义 |
| `query_dcs_data` | `sql/binds/previewRows` | Oracle SELECT/WITH，支持关联/聚合/CTE/窗口函数，完整结果分批写入JSON |
| `search_dcs_knowledge` | `query` | 原知识检索保持不变 |

- 移除任意Shell入口和分析脚本执行能力。源码根目录使用 `DCS_SOURCE_ROOT`（缺省Agent工作目录），真实路径必须在该目录内；搜索不跟随链接。rg由PATH或 `DCS_RG_PATH` 指定，禁用rg配置文件，模型只能传固定参数的值。
- 搜索默认30条、最多100条，offset从0开始；固定按路径排序，contextLines默认2、最多5。上下文行也占分页条目，nextOffset用于继续同一搜索。单行预览最多1000字符，textTruncated时用源码读取工具查看。无匹配是empty；执行失败、取消和30秒超时单独返回。
- 源码读取startLine从1开始，默认80行、最多200行，每个文件最多12000字符。长行使用startColumn（从0开始）续读；next=null才表示该文件范围已读完。批量读取中每个文件分别报告错误。
- Schema参数与分页行为保留；数据库登记的约束和依赖不代表完整应用关系。大结果仍落盘，由read_dcs_result继续读取。
- 数据库沿用现有账号配置和只读事务；单次调用超时20秒，Run取消调用connection.break。使用ResultSet每批256行读取并写文件；本次不更改真实数据库权限。
- SQL预览默认50行、最多200行、16000字符。complete表示实际查询是否取完，previewTruncated仅表示预览缩短。部分失败文件标记complete=false；fetchedRows为已取得行数。
- SQL文件结构为 `{columns,columnTypes,rows,fetchedRows,complete}`。NUMBER保留十进制字符串，日期ISO，二进制base64；错误保留Oracle诊断和可用的offset。
- read_dcs_result只接受结果目录内的query/schema JSON文件。select如 `["rows"]` 或 `["objects",0,"columns",0,"TEXT"]`。数组/对象每页默认50、最多100条；字符串默认4000、最多16000字符。partial条目需用返回的select继续读取；hasMore仅表示当前值分页，sourceComplete表示原查询完整性。当前实现解析整个JSON文件后分页返回，不是流式JSON解析；大数据统计优先用SQL缩小结果。
- 结果默认保存在 `data/tool-results/`，可用 `DCS_TOOL_OUTPUT_DIR` 指定。日志、会话及结果文件仍由后端写入，模型没有写文件能力；不新增结果存储或自动清理机制。
- 功能说明无相关手册时继续查源码；先核对菜单/URL与页面接口对应关系，不按同名代码推定。导航unsupported只说明打开方式不支持。

## 7. 运行与测试

### 7.1 命令

```bash
npm install                  # 安装依赖（typescript / tsx / @types/* / @wecom/aibot-node-sdk / oracledb）
npm run check                # 统一离线检查（typecheck + 全部离线测试，任一失败非零退出；不含真实模型/数据库测试）
npm run typecheck            # tsc --noEmit
npm test                     # 冒烟测试（FakeStreamFn + 假 DbClient，无需 key/真库）
npm run test:accept          # Runtime 剧本 + 只读源码/数据库工具离线验收
npm run test:tools           # 真实rg/文件读取 + Fake Oracle/Model、分页与只读边界回归
npm run test:cli             # CLI 展示层入口级验证（本地假模型）
npm run test:wecom           # 企微 Channel 层测试（假动作/假 Agent/可控时钟）
npm run test:web             # Web Channel 层测试（假身份+假 Agent，真实 HTTP）
npm run test:identity        # 身份链路逻辑测试（临时 fixture，无需真库）
npm run test:factory         # Agent 组装工厂测试（拦截 fetch 验证取消信号真实接线）
npm run test:accept:harness  # 真实业务验收 harness 离线测试（案例加载/会话隔离/结果分类）
npm run test:knowledge      # 知识库全链路测试（真实 LanceDB 临时库 + mock 集团接口，无需配置）
npm run test:observability  # 日志系统测试（事件序列/统计/凭据脱敏/Usage 完整性/三层结果/并发隔离/写失败容错，61 项）
npm run knowledge:ingest    # 知识库资料导入/更新（需 DCS_EMBEDDING_*，见 §6.1）
npm run test:live            # LLM 真实 key 适配器单测（需 LLM_API_KEY）
npm run test:live:db         # 真实 Oracle 库验证（需 DCS_DB_* 三变量，未配置优雅 SKIPPED）
npm run test:accept:live     # 真实业务验收（真实员工身份 + 真实库 + 真实模型，案例驱动，见 §7.5）
npm run dev                  # CLI REPL（需 LLM_API_KEY；默认模拟身份）
npm run wecom:echo           # 企业微信长连接 Echo（需 WECOM_BOT_ID / WECOM_BOT_SECRET）
npm run wecom:bot            # 企业微信机器人（需 WECOM 凭据 + LLM_API_KEY）
npm run web                  # 网页端（需 LLM_API_KEY + DCS_DB_*）
```

**本地配置加载**：CLI、Web、企微、模型 live 测试与业务验收读取项目根目录 `.env.local`，复用 `src/dcs/env-local.ts`，系统环境变量优先。值不加引号、不带行尾注释；不读取 `.env`，不依赖 dotenv。内部地址与密钥只放在被 Git 忽略的 `.env.local` 或系统环境变量中。

### 7.2 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 所有模型入口 | Bearer 密钥，缺失时入口拒绝启动；live 测试标记未验证 |
| `LLM_BASE_URL` | 是 | 部署方提供的 Base URL（含 `/v1`），无默认地址 |
| `LLM_MODEL` | 否 | 默认 `Qwen3.5-35B` |
| `WECOM_BOT_ID` | wecom:echo | 企业微信智能机器人 BotID（管理后台获取） |
| `WECOM_BOT_SECRET` | wecom:echo | 智能机器人长连接专用 Secret（非 Token/EncodingAESKey） |
| `DCS_SOURCE_ROOT` | 源码工具 | 允许读取的DCS源码根目录；未配置时使用Agent工作目录 |
| `DCS_TOOL_OUTPUT_DIR` | 调查工具 | 完整结果与分析脚本目录，默认项目 data/tool-results |
| `DCS_EMBEDDING_URL` / `DCS_EMBEDDING_API_KEY` | search_dcs_knowledge | 集团 Embedding 接口完整请求 URL + 凭据（两项齐备才启用知识库；URL 为完整地址，代码不追加路径）。未配置 → 工具返回能力不可用，systemPrompt 不注入知识库段，不影响其他工具 |
| `DCS_EMBEDDING_MODEL` | 否 | 默认 `Qwen3-Embedding-8B`；更换模型需重建索引 |
| `DCS_RERANK_URL` | 否 | 集团 Rerank 接口完整 URL（未配置时检索降级为向量排序并注明） |
| `DCS_RERANK_API_KEY` / `DCS_RERANK_MODEL` | 否 | Rerank 凭据（缺省复用 Embedding 凭据）/ 模型（默认 `Qwen3-Reranker-8B`） |
| `KNOWLEDGE_DIR` / `KNOWLEDGE_INDEX_DIR` | 否 | 资料目录（默认 `./knowledge/documents`，gitignored）/ 索引目录（默认 `./data/knowledge`，gitignored） |
| `DCS_KB_TIMEOUT_MS` / `DCS_KB_CANDIDATES` / `DCS_KB_TOP_N` / `DCS_KB_EMBED_BATCH` | 否 | 接口超时（20000，覆盖正文读取）/ 召回候选（20）/ rerank 返回数（5）/ 向量化批量（16） |
| `DCS_DB_USER` | query_dcs_data（真实库） | DCS 库用户名（部署必须使用最小只读权限账号，本次未验证实际授权）。与下两项任一缺失 → 数据库查询能力明确返回不可用 |
| `DCS_DB_PASSWORD` | query_dcs_data（真实库） | DCS 库密码 |
| `DCS_DB_CONNECT_STRING` | query_dcs_data（真实库） | 连接串（`主机:端口/服务名` 或 EZConnect 格式），oracledb Thin 模式免装 Oracle 客户端 |
| `DCS_DB_SCHEMA` | 否 | DCS 表所属 schema。**通常无需设置**：未设置时身份链路会自动查 ALL_TABLES 发现 S2_Employee 的 OWNER（唯一时自动采用，多个时要求显式指定，无法访问时报权限错误）。设置后跳过自动发现 |
| `DCS_LOG_LEVEL` | 否 | 终端日志级别：`normal`（默认）/ `debug`（追加参数摘要、toolCallId、字段列表、停止原因、完整工具结果与原始 finish_reason；不绕过凭据脱敏） |
| `DCS_LOG_COLOR` / `NO_COLOR` | 否 | 终端颜色开关：`DCS_LOG_COLOR=0` 或设置 `NO_COLOR` 关闭 ANSI 颜色（状态符号 ✓/✗/⚠ 仍保留） |
| `WEB_PORT` / `WEB_RUN_BUDGET_MS` / `WEB_STATIC_DIR` | 否 | Web 通道端口（8787）/ 单 Run 预算（180000）/ 前端静态目录（默认 ../DCS Agent.web） |

### 7.2.1 三层验证口径（重要区分）

| 层级 | 命令 | 证明什么 | 不证明什么 |
|---|---|---|---|
| 离线接线测试 | `npm run check` | Runtime 接线、状态传递、脱敏管线、取消信号、护栏逻辑（Fake 模型 + 假库） | 真实模型行为、真实数据正确性 |
| 真实运行完成 | `npm run test:live` / `test:live:db` / `test:accept:live` | 真实模型/数据库链路可跑通、Run 正常结束 | 业务答案正确 |
| **人工业务验收** | `test:accept:live` 的 PENDING_REVIEW 项 | — | 由人工按 expectedFacts 核对实际回答后确认；**正常结束 / 调用过工具 / 命中关键词都不等于业务验收通过** |

### 7.2.1 企业微信接入（v2 方案）

**架构**：WeCom 只是 Channel/Adapter，与 Agent Runtime 完全分离——`src/wecom/` 不 import core 的任何类型概念，Agent 组装只用既有 dcs 工厂。CLI 入口保留，企微为平级新入口。

```
真实企微员工 → WSClient（@wecom/aibot-node-sdk 长连接）
→ msgid 去重（wecom/dedup.ts，内存 TTL）
→ Identity Resolver（dcs/identity.ts：identity.json 覆盖（可选）→ S2_Employee 数据库解析，见 §5.2）
→ 会话管理（wecom/conversation.ts：即时处理 IDLE/PROCESSING，处理中拒新消息）
→ AgentRunner（wecom/agent-runner.ts：runId + 90s 预算 + abort + 迟到丢弃）
→ Existing Agent Runtime（core，零改动）→ DCS Tools → 流式回复
```

| 文件 | 职责 |
|---|---|
| `src/wecom/echo.ts` | Step 1 长连接 Echo 验证（**已真实联调通过**：认证、收消息、真实 userid 回调解析、回复送达） |
| `src/wecom/dedup.ts` | msgid 内存去重 + 10min TTL 惰性清扫 |
| `src/wecom/conversation.ts` | 即时处理状态机（IDLE/PROCESSING）+ 多员工会话隔离 + 30min 空闲回收（纯逻辑，依赖注入可测）。**2026-09-24 用户决策删除"输入确认"环节**：消息到达即作为完整问题处理，代价是一条问题拆多条发送时每条独立处理 |
| `src/wecom/agent-runner.ts` | 超时控制：占位语→Run→最终回复；超时 abort+废弃实例+受控提示；迟到结果丢弃 |
| `src/wecom/bot.ts` | 正式入口：凭据校验、身份解析（未登记中性拒答）、按 userid 建 Agent（每用户独立 streamFn/取消信号）、群聊谢绝 |
| `identity.json` | 可选 | userid→DCS 身份**手动覆盖**（gitignored；命中时优先于数据库解析，用于测试指定身份；正式链路为 S2_Employee 数据库自动解析，见 §5.2；`identity.example.json` 为模板） |

交互规则（2026-09-24 更新）：消息到达即处理（无确认环节）；处理中新消息回复"上一问正在处理中"；超时回复"这次查询超时，请稍后重试"；未识别身份回复中性话术。已按审查 §十一删除所有编造联系信息（8888 分机等），全链路话术卫生有测试锁定（wecom.test.ts 场景 Q）。

启动：

```powershell
$env:WECOM_BOT_ID = "xxxx"; $env:WECOM_BOT_SECRET = "xxxx"; $env:LLM_API_KEY = "sk-xxxx"
npm run wecom:bot
```

可选环境变量：`WECOM_RUN_BUDGET_MS`（Agent 处理预算，默认 90000）、`DCS_IDENTITY_FILE`（身份映射文件路径）。

**当前状态**：Step 1 已真实联调通过；Step 2/4/5/6/7/8 代码与确定性测试完成（Channel 层 35 项测试）；身份链路已接入 S2_Employee 数据库（2026-09-24，§5.2）；**真实员工端到端验收（Step 9）进行中**——真人测试于 2026-09-24 启动（三问链路验证通过，身份自动解析验证待新一轮真人测试）。

### 7.2.2 网页端接入（Web Channel，2026-09-24）

**架构**：与 wecom 平级的第二个 Channel——`src/web/` 不侵入 core，Agent 组装复用同一套 dcs 工厂；core/wecom 零改动。零新增依赖（node:http + SSE）。

```
员工浏览器 → node:http（src/web/server.ts）
→ 工号建档（dcs/identity.ts resolveEmployeeByCode：S2_Employee 按 Code 查库，仅在职）
→ 每员工一个 Agent（busy 拒绝并发，无确认环节）
→ SSE 流式回复（文本增量 + 工具步骤事件；不转发工具参数/结果摘要）
→ 180s 预算 abort + 丢弃 Agent
```

| 位置 | 职责 |
|---|---|
| `src/web/server.ts` | HTTP 静态服务 + SSE + 会话/重置接口；依赖注入可测（`test/web.test.ts` 15 项） |
| `D:\work\DCS Agent.web\`（独立目录，不在本仓库） | 前端三件套 index.html / style.css / app.js（原生 JS 零框架；设计稿 v4） |

前端路径解析顺序：`WEB_STATIC_DIR` 环境变量 > 默认 `../DCS Agent.web`（与本项目同级）。测试期身份为页面输入工号建档（无认证，上线前换真实认证）。

**调用日志**：Web 复用现有 `logger`，在服务端终端逐行输出 JSON（不自动落盘）。同次提问用 `runId` 关联，工具开始/结束用 `toolCallId` 配对；记录调用序号、参数、耗时、成败和既有结果摘要，以及 Run 开始/结束、Agent 错误（含轮次耗尽）、超时和断开。参数、摘要及错误文本复用现有 `maskPii` 脱敏；不记录完整工具结果，不向前端增加日志字段。排查时按 `runId` 查看重复 SQL、搜索关键词与错误；`run_end` 仅代表请求结束，是否成功需结合错误事件判断。现有脱敏不覆盖所有个人信息，日志仍按内部调试资料管理。

启动：

```powershell
$env:LLM_API_KEY = "sk-xxxx"; $env:DCS_DB_USER="xxx"; $env:DCS_DB_PASSWORD="xxx"; $env:DCS_DB_CONNECT_STRING="host:1521/SVC"
npm run web   # http://localhost:8787
```

可选环境变量：`WEB_PORT`（默认 8787）、`WEB_RUN_BUDGET_MS`（默认 180000）、`WEB_STATIC_DIR`。

### 7.3 测试覆盖

2026-10-23：`npm run check` 全量离线检查通过，包含16项只读工具测试（真实rg及临时文件，Oracle/模型使用假实现）。真实DCS源码抽查成功定位两个AddressListController，并批量读取片段；一次测量中找文件1727ms、限定文件搜索52ms、批量读取5ms，不代表模型端到端性能。真实模型/数据库联调未执行。测试入口为 `npm run test:tools`。

旧 Tool V2.1 验证记录见 [交付记录](docs/tool-v21-delivery.md)。下面带旧日期/数量的记录是历史快照；新工具替换了旧源码接口测试，旧自由 SQL 剧本改用测试专用 fixture。

| 测试 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 通过 |
| 冒烟测试（smoke.ts，12 场景 95 项，含审查 F/R 全部回归 + investigate_dcs_code 14 项 + query_dcs_data 15 项） | ✅ 95/95 |
| 验收接线（acceptance.ts，FakeStreamFn 预置剧本） | ✅ 全过（仅证明接线，不证明模型行为） |
| CLI 展示层入口级验证（cli-display.ts，本地假模型） | ✅ 5/5 |
| 身份链路逻辑（identity.test.ts，文件层 + 数据库层两级解析 + schema 自动发现 + I21 工具描述动态 schema） | ✅ 21/21 |
| 身份链路真实验证（identity-live.ts，userid 经 WECOM_TEST_USERID 提供，两级解析） | ⏸ 待重跑（2026-09-24 链路升级为数据库解析后） |
| **身份链路真人验收**（企微"我是谁" → S2_Employee 数据库解析，13:33） | ✅ 2026-09-24 通过（真实工号/姓名/部门返回，schema 自动发现生效；中途 NJS-530 为用户侧网络变化，非代码问题） |
| Channel 层（wecom.test.ts：即时处理状态机/隔离/去重/超时/迟到丢弃/话术卫生） | ✅ 28/28 |
| Web Channel 层（web.test.ts：静态页/建档/鉴权/SSE 流式/busy 拒绝/reset/处理中 reset 409/超时清理不误删新实例） | ✅ 23/23（2026-09-28 更新，以实际运行输出为准） |
| Agent 组装工厂（agent-factory.test.ts：拦截 fetch 验证取消信号真实接线/新旧 Run 信号隔离） | ✅ 12/12（2026-10-09，含 Qwen 请求参数与三个工具保留检查） |
| 验收 harness（acceptance-harness.test.ts：案例加载跳过/会话复用与身份隔离/结果分类/报告渲染） | ✅ 21/21（2026-09-28 新增） |
| 知识库全链路（knowledge.test.ts：配置门控/分块规则/Embedding与Rerank客户端校验/导入增量同步/原子更新与维度校验/孤儿清理/配置不匹配拒开/检索→重排→出处格式/同义检索/降级/取消/完整片段不截断/长度控制） | ✅ 55/55（2026-09-29 审查修复后，真实 LanceDB 临时库 + mock 集团接口） |
| 企微长连接 Echo（Step 1，真实联调） | ✅ 2026-09-22 通过（真实 userid/msgid/回复送达） |
| core 纯净度（无 DCS import） | ✅ grep 验证 |
| 验收判定对抗（smoke 场景 K：错误字符串含关键词必须 FAIL） | ✅ 4/4 |
| LLM 真实接口适配器单测（test:live） | ⚠ 2026-10-09 首次 PASS；D 盘同步后复测 **FAIL**：DCS 场景 2e 未调用工具；其余接口项目通过，见 §4 |
| 真实 Oracle 库验证（test:live:db，L-DB1~4：DUAL/数据字典/UPDATE 拒绝/ORA 透传） | ✅ 2026-09-24 通过（连接 / 数据字典 / 护栏 / 错误透传 4/4） |
| 真实 LLM 验收（test:accept:live，2026-09-28 重建为案例驱动真实业务验收） | ⏸ **未验证（SKIPPED）**——当前缺 `DCS_DB_*` / 真实案例（cases.json 待填写，见 §7.5） |
| 知识库真实链路（集团接口 + 已导入文档 → 检索 → Agent 回答含出处） | ⚠ 2026-10-09：明确指定检索文档时真实闭环通过；自然问法出现未检索却生成流程和虚构出处，行为验收 **FAIL**，见 §4 |
| 企微→Agent→回复 端到端（Step 9 真人验收） | ⏸ **未验证**——需凭据配置后真人测试 |

冒烟测试验证点：prompts / context / newMessages 边界与调用方数组不可变性、多 Turn 循环、ToolCall→execute→ToolResult→下一轮 LLM 回填、Agent 状态写回、脱敏管线（含"脱敏发生在回填模型之前"）、beforeToolCall 阻断扩展点、maxTurns 保护（含耗尽时终止说明）、StreamFn 永不 reject 契约，以及审查回归：SSE 坏帧 / 无 finish_reason EOF 编码为 error（H1–H5）、length 截断残缺 toolCalls 剥离与序列化配对（I1–I6）、Hook 异常兜底不泄原文 / 不击穿 Run（J1–J7）。

### 7.4 历史 Runtime 剧本输出（FakeStreamFn + 测试专用工具 + 假 DbClient）

以下旧菜单/报餐剧本只验证通用 Runtime 接线；不是当前生产工具的数据授权验收。生产工具链见 `test/tools-v2.test.ts`。

```
场景 1  "为什么我没有权限管理菜单"
  工具调用：query_dcs_data（查 S2_MENU 权限数据，假库返回：权限管理 | 系统管理员）
  回复：你目前没有「权限管理」菜单权限：缺少系统管理员角色。
        如需开通，请联系管理员处理。

场景 2  "我为什么报不了餐"
  工具调用：query_dcs_data（查 S2_MEAL_ORDER，假库返回：已驳回 / 42 / 35）
  回复：你今天的报餐订单被驳回了：金额超出当日餐标 7 元
        （餐标 35 元，实付 42 元）。把金额改到 35 元以内重新提交即可。

场景 3  追问"那餐标是多少"（同一会话）
  工具调用：query_dcs_data（查 S2_MEAL_CONFIG 餐标配置）—— 不重复查权限/订单
  回复：餐标是 35 元/人/日，报餐窗口为工作日 08:00-10:30。
```

### 7.5 真实业务验收（案例驱动，2026-09-28 重建）

`npm run test:accept:live` 不再使用模拟身份与模拟事实判定器，改为**本地 JSON 案例驱动**：

1. 案例文件 `test/acceptance-cases/cases.json`（gitignored；模板 `cases.example.json`，填写说明见该目录 README）：每案例含真实工号、真实问题、**人工核实的** `expectedFacts` 与可选 `expectedNextAction`；
2. 身份用 `resolveEmployeeByCode` 解析（S2_Employee，仅在职，**不回退模拟身份**）；
3. 相同 `conversationId` 顺序执行并复用同一 Agent（支持追问），不同会话隔离，同一会话不得混用不同员工（违反 → FAILED）；
4. 每案例记录实际回答、耗时、模型轮次、工具调用数、工具错误数、停止原因；
5. 运行状态：COMPLETED（正常生成最终回答）/ FAILED（异常、超时、非自然结束）/ SKIPPED（配置或案例缺失；占位符案例不执行、不计入通过率）；
6. 业务正确性单独标记 **PENDING_REVIEW**——脚本不判定业务对错，由人工按 expectedFacts 核对报告中的实际回答；
7. 总超时 10 分钟强制收尾；结束关闭数据库连接池；
8. 报告输出 `test/acceptance-cases/reports/acceptance-<时间戳>.json`（机器可读）与 `.md`（人工核对）。

harness 离线测试（`npm run test:accept:harness`）覆盖案例加载跳过、会话复用与身份隔离、结果分类（含"中间工具错误但成功恢复 ≠ 失败"）、报告渲染。

---

## 8. 当前明确不做

知识库 / RAG、图片 / 文件 / 语音、消息缓冲与队列、多用户并发优化、复杂 Session（TTL / 存储）、转人工、工具并行执行、历史消息裁剪、4KB 防爆与 compaction、复杂停止策略、动态 Tool 权限、beforeToolCall 业务校验、ModelError / Runtime Error 体系重构、SQL 查询权限策略收紧、会话持久化、部署平台建设。后续由真实案例暴露的问题决定优先级（2026-09-28 本轮范围裁定）。

---

## 9. 已知偏差与审查修复记录

### 9.1 审查修复（2026-09-21，依据 audit/review-v2.md 与 audit/review-v3.md）

**第一轮（F1–F6）**：

| 编号 | 问题 | 修复 |
|---|---|---|
| F1 | SSE 坏帧 / 无 finish_reason 的 EOF 被误判为正常 stop | 坏数据帧与提前 EOF 均编码为 `stopReason:"error"`；心跳/注释/空行仍可忽略（回归测试 H1–H5） |
| F2 | length 截断的残缺 toolCalls 入历史，污染后续请求 | 非 toolCalls 完成时剥离残缺 toolCalls（不执行、不入历史），length 时附截断说明；tool_calls / tool 消息配对完整（I1–I6） |
| F3 | maxTurns 耗尽返回空答案 | 耗尽时生成明确终止说明写入 AssistantMessage，返回文本/事件/历史三者一致（G6–G7） |
| F4 | live 脚本误报通过；Fake 验收冒充模型行为 | live 脚本严格区分 PASS/FAIL/SKIPPED，工具调用缺失即 FAIL；acceptance.ts 声明证据边界、显式断言 42/35/7/驳回、追问允许餐标工具；新增 test/acceptance-live.ts 真实三问验收脚本 |
| F5 | CLI 直接打印内部源码路径 | 展示层口径：search_dcs_code 结果摘要显示"内部检索已完成"，完整结果仍回填模型供内部诊断（audit/cli-fixture 复测通过） |
| F6 | Hook 异常路径漏防（未脱敏原文流入模型 / Run 击穿） | beforeToolCall 抛错按"阻止"处理；afterToolCall 失败丢弃原始内容替换为安全 error ToolResult（J1–J7） |

**第二轮（R1–R5）**：

| 编号 | 问题 | 修复 |
|---|---|---|
| R1 | 三问验收判定可被"错误字符串命中关键词"骗过 PASS | 判定逻辑抽取为 test/acceptance-judge.ts：每问无 agent_error + 末轮自然 stop + 必要工具执行成功（isError=false）+ 核对 menuName=报餐管理 / dataType=报餐订单/餐标配置 + 结果摘要关键事实；对抗剧本（错误文字含全部关键词/查错菜单/无效 dataType）必须 FAIL（smoke K1–K4，复刻 audit/revision-fixture.mjs） |
| R2 | 三问脚本不打印实际回复，"证据见日志"名不符实 | run() 打印每问实际回复全文与工具调用成败（正常与失败均有真实回答可查） |
| R3 | length 截断说明/maxTurns 终止说明未显示到 CLI（用户看到空回答） | CLI 统计已流式字符数，prompt() 结束后补打 finalText 未显示后缀；正常流式回复不重复打印（入口级验证 L1–L2） |
| R4 | 工具参数明文打印，内部路径可从参数日志露出 | tool_execution_start 不打印原始参数；search_dcs_code 结果摘要无论成败均泛化显示（入口级验证 L3–L5） |
| R5 | SSE 坏帧后等待下一块数据才报错，对端保持连接时永远卡住 | 发现坏帧立即 yield error 并 return，不再请求下一块数据（H6：坏帧后流保持打开，错误即时返回） |

### 9.2 其余偏差

1. **模型验证更新（2026-10-09）**：Qwen3.5-35B 原生自动工具调用、SSE、结果回填与 CLI 普通问答已通过；真实员工菜单权限与案例驱动验收仍为 **UNVERIFIED**，当前缺数据库配置与真实案例。
2. **maxTurns 默认值**（方案未定值，CLI 显式传 8）。
3. **search_dcs_code 支持 `DCS_SOURCE_ROOT` 覆盖**：为测试可移植性所做的最小调整。
4. ~~菜单匹配含包含式兜底~~（已随 Legacy Mock 工具删除而不复存在，2026-09-24）。
5. **错误双保险**：StreamFn 违约抛异常 / 工具 execute 抛异常均编码为 error 消息而非崩溃——"永不 reject"契约的自然延伸。

### 9.3 能力释放改造（2026-09-23，方案 v2：docs/tool-convergence-plan-v2.md）

背景：9/22 企微真人测试暴露 prompt 固定路由与技术禁令压制模型能力（见 audit/review-v6.md 诊断）。用户确立"测试阶段最大限度释放能力、按真实失败案例逐步加约束"原则。

本轮变更：

| 变更 | 内容 |
|---|---|
| systemPrompt 重写 | 删除 4 条固定工具路由、≤200 字、≤3 步、"建议联系管理员"话术、全面技术禁令；改为能力声明 + 5 条硬边界（事实性结论须有证据支持，允许基于证据的推理并区分已确认/推断/不确定；凭据绝对禁；只查本人；不写操作）；TEST DATA 如实声明 |
| 工具收敛 | `search_dcs_code` 移除，能力并入新工具 `investigate_dcs_code`（query/path/contextLines，搜索+定位+上下文融合，渐进式返回）；`check_dcs_permission` / `query_business_data` 标记 Legacy 不再扩展 |
| 源码范围 | 顶层白名单 WebApi/WebApp/Common（覆盖 Areas 业务视图），黑名单目录+扩展名白名单；`DCS_SOURCE_ROOT` 必须显式配置（默认路径硬编码已删除） |
| 凭据防线 | hooks.ts maskPii 扩展：Password/Pwd/Secret/Token/ApiKey/AccessKey 值统一脱敏（所有工具） |
| maxTurns | 8 → 24（测试期安全阀，非生产值）；bot/CLI 每 Run 打印 turns/toolCalls 简单统计 |
| 性能 | 进程内文件列表 + 内容缓存（256MB 上限）：首次全量调查约 10s，同进程后续约 1s |

已知遗留：

1. **live 验收（含场景 4 核心验收 Case："黄石智通已勾选无需协调员…"源码自主调查）未执行**——该指定业务案例仍为 **UNVERIFIED**；2026-10-09 模型接口已验证，不能代替该案例验收；
2. **多轮源码调查可能逼近企微 90s 预算**（首次调查约 10s + 模型思考），必要时调 `WECOM_RUN_BUDGET_MS`；Channel 层本轮不动；
3. ~~**"我有哪些菜单"的回答错误问题（P0）本轮未修**~~——已随 Legacy Mock 工具删除统一解决（2026-09-24，见 §9.4）；
4. node_modules 曾缺失 `@wecom/aibot-node-sdk`（环境问题，已按 lockfile 补装）。

### 9.4 Legacy Mock 工具移除（2026-09-24）

背景：真人测试发现"我有哪些权限"类问题在真实库查不到测试身份（T000001 不在真实库）后，模型退回 Mock 工具回答模拟数据；且"你有权限"等结论混入 Mock 数据，可信度不可分。

| 变更 | 内容 |
|---|---|
| 工具删除 | `check_dcs_permission` / `query_business_data` 及其 Mock 数据（菜单表 / 报餐订单 / 餐标）全部移除；dcsTools = `investigate_dcs_code` + `query_dcs_data` |
| systemPrompt | 删除"业务数据工具（测试环境数据）"能力声明与"测试环境数据"沟通风格说明；改为"数据库查询返回系统真实数据；查不到如实说明" |
| 判定器重写 | acceptance-judge.ts 改为 query_dcs_data 语义：核对查询执行成功 + 结果摘要证据（权限/角色、报餐/订单、餐标）+ 回复事实；investigate_dcs_code 为允许的辅助工具 |
| 测试载体迁移 | smoke A/B/G/I/J/K、acceptance、cli-fixture、wecom.test Q5/Q6 全部从 Mock 工具迁移到 query_dcs_data + 假 DbClient（按 SQL 关键词返回剧本化数据） |
| 已知边界 | ~~identity.json 仍为 TEST DATA~~ → 已解决：同日接入 S2_Employee 数据库自动身份链路（见 §9.5） |

### 9.5 数据库身份链路（2026-09-24，README §5.2 的正式实现）

背景：真人测试确认"我有哪些权限"在真实库查不到测试身份（T000001 不存在）且模型退回 Mock（§9.4）；用户问"不是可以通过 userid 获取工号吗"——源码证实 DCS 员工表 `S2_Employee.UserId` 即企微 userid（`EmployeeSet.GetEmpCode(userId)`，QYWeixinMessageHandler 同源），遂将 §5.2 预留链路落地。

| 变更 | 内容 |
|---|---|
| 两级解析 | identity.json 手动覆盖（命中优先，测试用）→ S2_Employee 数据库（`UserId = ?` → Code/Name/DeptName，仅在职 LeaveDate IS NULL） |
| 安全 | userid 字符白名单（拼接查询防注入）；数据库故障按未识别拒答（不崩溃、不缓存失败）；两级未命中 → 中性拒答（原有铁律不变） |
| 缓存 | 数据库解析结果按 userid 缓存 10 分钟（进程重启刷新） |
| roles | 暂为空数组（ADM 权限表接入前）；权限类问题由模型经 query_dcs_data 查库 |
| identity.json | 由必需映射降级为可选覆盖文件（已清空为 `{}`；example 模板同步更新） |
| 测试 | identity.test.ts 7→17 项（新增 I8–I17：数据库命中/未命中/离职/覆盖优先级/防注入/故障拒答/未配置门控）；identity-live.ts 改走两级链路 |
| 已知边界 | 每用户 Agent 创建时的身份来自消息入口预解析（getSlot 同步契约，暂存 Map 传递）；角色字段为空——后续可从 ADM 权限表（ADMPersonnels/ADMRole）接入 |

### 9.6 查询探索成本治理（2026-09-24，方案A+B+C）

背景：真人测试"我有什么权限"能查到但代价极高（turns=25 / toolCalls=52 / 68 秒；上一轮 27 次未查出）——模型对数据库"没有地图"，全部工具调用花在找表名的试错上。根因之一是 query_dcs_data 描述的 schema 提示在 `DCS_DB_SCHEMA` 未设时回退**登录用户名**（只读账号非表所有者）：教模型查的数据字典返回 0 行、示例前缀必报 ORA-00942，等于把模型引向死路；identity.ts 的自动发现结果没有共享给工具层。

| 方案 | 变更 | 预期效果 |
|---|---|---|
| A：schema 提示修正 | tools.ts 描述改为 getter 动态生成；`DCS_DB_SCHEMA` 显式配置 > `getDiscoveredSchema()`（identity 自动发现共享）> 登录名兜底 | 提示永远指向正确 OWNER，不再误导 |
| B：常用表数据字典 | 描述内置 S2_Employee + 权限五表速查（字段名来自源码实体验证）+ 查权限 JOIN 示例 + ALL_TABLES 反查提示 | 模型不再需要试错探索，预期 52 次 → 3~5 次调用 |
| C：工具级观测日志 | bot.ts 订阅 tool_execution 事件：`[tool] → 工具名 参数摘要` / `[tool] ← 工具名（耗时，结果摘要）` | 每次测试可直接看到模型实际执行的 SQL 与白跑的调用 |

顺带解决：S2_Employee 实有 IdCard/Telephone 字段（Employee.cs:99/121），此前查身份证/电话 turns=1 toolCalls=0（模型不知有此字段而未查）——数据字典列出后此类问题可直接命中。测试：identity.test.ts 20→21 项（I21 描述动态 schema + 字典断言）；全量回归全绿。

**真机验证与字典修正（2026-09-24 14:17，两位员工实测）**：A+B+C 全部生效——首轮"我有什么权限"3 次调用 / 7 秒完成（对比修复前 52 次 / 68 秒），`[tool]` 日志全程可见每条 SQL。首轮按字典 JOIN ADM 权限表返回 0 行为诚实空结果：**DCS 存在两套并行权限表**——无 ADM 前缀的 `S2_UserRole / S2_Role / S2_RolePermission / S2_Permission` 才是员工主权限（实测孟为峰 221 个角色、莫灼恒 DCS_Developer 角色 14555 条功能权限）；ADM 组（S2_ADMUserRole 等）为管理模块独立权限、普通员工无记录。字典已修正为主权限表组并注明 ADM 组定位，另补防截断聚合提示与"数据字典视图不加 schema 前缀"提示（真机曾报 DCS.ALL_TAB_COLUMNS ORA-00942）。

### 9.7 运行问题修复与真实业务验收入口重建（2026-09-28）

目标：尽快进入真实业务试用。只解决已确认的运行问题与业务验收缺口，不扩展安全/合规/权限治理。

| 变更 | 内容 |
|---|---|
| **取消信号接线修复（P0）** | 旧实现：bot.ts / server.ts 把 `holder.controller` 的**初始值复制**进 entry，每 Run 替换的是 entry.controller，模型 `signalProvider` 闭包读的 holder 从未更新——超时 abort 打在模型不读的控制器上，**取消无效**。修复：提取 `src/dcs/agent-factory.ts` 统一组装（session/prompt/tools/hooks/模型适配/maxTurns:24），Web/企微/CLI/验收共用；Channel 层持有**同一个可变 holder 对象**，每 Run 替换 `holder.controller`，模型读取、运行时替换、超时取消三者同一对象。验收：agent-factory.test.ts 拦截全局 fetch，断言模型请求实际收到的 signal 就是 `holder.controller.signal`（同一对象）、abort 后模型调用失败、新 Run 使用新的未中止信号。**边界**：本轮只取消模型请求，不中断已执行中的 Oracle 查询 |
| **Web 处理中重置竞争修复** | `/api/reset` 在该员工 Agent busy 时返回 **409** `{"ok":false,"message":"上一问正在处理中，请完成后再新建会话。"}`，保留实例与 busy 状态；空闲时正常重置。超时/断开触发的清理改为 `discardEntryIfCurrent`——仅当 Map 中保存的仍是本次运行实例才删除，防止旧运行清理回调误删新实例。**前端注意**：`DCS Agent.web`（独立目录，本轮未改）的 app.js 若未处理 409，用户会在处理中点"新会话"时收到失败——前端需按 409 提示等待 |
| **SQL 失败状态如实标记** | `query_dcs_data`：guard 拒绝与数据库执行异常均返回 `isError:true`（事件流与 ToolResult 一致）；错误内容保留修正提示供模型改写重试；AgentLoop 继续执行语义不变（工具失败 → ToolResult → 下一轮模型）。验收区分"中间查询出错但成功恢复"与"最终业务失败"：smoke L13（错误→改写→成功→作答全链路）、L8/L9、live-db L-DB3/L-DB4 断言更新 |
| **真实业务验收入口重建** | test/acceptance-live.ts 弃用模拟身份 + 模拟事实判定器（"42 元/35 元/驳回"不适用于真实员工与真实库），改为案例驱动：`test/acceptance-cases/cases.json`（gitignored，模板 cases.example.json）+ `acceptance-harness.ts`（可离线测试的纯逻辑）+ JSON/Markdown 报告。COMPLETED/FAILED/SKIPPED 三态 + PENDING_REVIEW 人工核对（见 §7.5） |
| **入口与文档整理** | package.json 新增 `test:identity` / `test:factory` / `test:accept:harness` / `check`（统一离线检查，任一失败非零退出）；.env.example 修正工具名（search_dcs_code → investigate_dcs_code）、补齐 DCS_DB_* / WEB_* 配置、明确"不自动加载 .env"；README 修正"零运行时依赖""不做企微接入"等过期内容，区分离线接线 / 真实运行完成 / 人工业务验收三层口径 |

### 9.8 RAGFlow 知识库接入（2026-09-29，方案：knowledge-rag 用户指令）

| 项 | 内容 |
|---|---|
| **新增工具** | `search_dcs_knowledge`（src/dcs/knowledge/：types.ts 配置解析 + client.ts 检索客户端 + tool.ts 工具）。RAGFlow v0.27.x `POST /api/v1/retrieval` 片段检索，只检索不生成（答案由主模型综合）；混合检索 `keyword:true`；≤6 片段/单片段 1200 字/总输出 8000 字；超时默认 15s |
| **取消机制** | `DcsToolContext` 增加可选 `holder`（与模型 signalProvider 同一可变对象，agent-factory 组装时注入 `toolContext:{session,holder}`）；客户端用 `AbortSignal.any([超时信号, run信号])` 合并——Run 超时/用户停止后检索请求立即中止（knowledge.test K6 以真实工厂+假 streamFn 验证链路） |
| **结果口径** | 未配置（RAGFLOW_* 缺失）→ isError:true "能力不可用"，systemPrompt 不注入知识库段（模型不会调用不可用能力）；未找到（code=0 空结果）→ isError:false 明确"未找到"；服务失败（HTTP/业务码/网络/超时/取消）→ isError:true 供模型换路 |
| **提示词** | buildSystemPrompt 按配置注入知识库能力段；新增【出处引用】段：文档答案附出处（`依据：《文档》—章节`）、多资料冲突时明确指出、无证据不编造 |
| **测试** | test/knowledge.test.ts 22 项（mock RAGFlow，含 2026-09-28 假绿灯教训的 settle 路径）；npm script `test:knowledge` 已并入 `check` |
| **部署缺口（如实记录）** | 本机 **Docker 未安装**（RAGFlow 官方要求 Docker≥24 + Compose≥2.26.1，Windows 需 Docker Desktop/WSL2；本机 C 盘仅剩 9GB，安装位置须改 D 盘；内存 16GB 为官方最低线）。知识库真实链路（上传→解析→检索→回答）**未验证**，部署步骤见 §6.1；测试文档模板见 test/acceptance-cases/knowledge-testdoc.md（上传到独立测试知识库，勿混入正式资料） |

> **注**：本节为历史档案。RAGFlow 方案当日被 §9.9 本地方案替换（部署缺口正是替换动因之一），RAGFlow 专用客户端/配置/部署说明已移除。

### 9.9 知识库方案替换：RAGFlow → 本地解析 + LanceDB + 集团接口（2026-09-29，用户两段式指令）

保留全部基础修复（模型取消/超时/会话竞争/SQL 错误标记/真实业务验收/agent-factory），只针对性替换知识库实现，未整体回滚、未用 git reset。

| 项 | 内容 |
|---|---|
| **移除** | RAGFlow 专用 client.ts / types.ts（配置 RAGFLOW_*）、Docker/WSL2/RAGFlow 部署要求与说明。未触碰任何无关代码 |
| **保留** | 工具名 `search_dcs_knowledge` 与 query 参数、出处输出、总长度限制（~8000 字）、取消机制（ctx.holder → AbortSignal 合并）、AgentLoop 零改动、提示词注入逻辑（getKnowledgeConfig 同名替换，prompt.ts 仅改 import 路径） |
| **新模块** | `src/dcs/knowledge/`：config.ts（DCS_EMBEDDING_*/DCS_RERANK_*/KNOWLEDGE_* 等 11 项环境变量）→ extract.ts（mammoth DOCX / pdf-parse v2 逐页 PDF / MD/TXT；空文档与扫描版明确报错；.doc 提示转存）→ chunk.ts（标题链/表格表头重复/600–1000 字目标/句子切分 100 字重叠/PDF 页码如实保留、CHUNKING_VERSION 固化）→ embedding.ts（OpenAI 兼容格式；`data[].index` 对位；数量/维度/数值校验；首请求探测维度；超时覆盖正文读取全过程）→ rerank.ts（`results[].index` 找回候选；越界/重复/分数校验；top_n≤候选数；不发送文档冲突的 prompt 字段）→ store.ts（LanceDB + 显式 Arrow schema——null 字段必须显式声明，类型推断会失败；归一化向量 + cosine 距离；index-meta.json 固化模型/维度/分块版本，不匹配拒绝打开）→ ingest.ts（增量同步四态 + 单文件失败保留旧版）→ tool.ts（内部换检索流程，对外契约不变）|
| **导入入口** | `npm run knowledge:ingest`（scripts/knowledge-ingest.ts）；资料目录 knowledge/documents/ 与索引 data/knowledge/ 已 gitignored |
| **失败语义** | Embedding 失败 → isError:true（不伪装无资料）；Rerank 失败/超时/未配置 → 降级向量序并在结果注明（不阻断）；索引未建 → isError:false 正常说明；Run 取消 → 中止 HTTP |
| **测试** | knowledge.test.ts 重写为 46 项（真实 LanceDB 临时目录 + mock 集团接口按 URL 分发）：配置门控/分块规则 5 项/Embedding 客户端 6 项（含乱序 index 对位、NaN、超时）/Rerank 客户端 3 项/导入增量同步 8 项（新增/跳过/更新/删除/失败保留/空文档/配置不匹配拒开）/检索链路 9 项（含中文同义「取消报餐」→「撤销订餐」、降级、未建索引）/Run 取消真实链路 4 项/长度控制/注册与注入。**坑：LanceDB 对 null 字段无法类型推断需显式 Arrow schema；表目录为 `<name>.lance`；mock 双接口必须按 URL 分发** |
| **依赖** | 新增 @lancedb/lancedb@0.39.0、mammoth@1.13.0、pdf-parse@2.4.5（3 个 high 漏洞均来自 sharp/libvips，系 lancedb 可选传递依赖 @huggingface/transformers，本项目不使用该推理路径，不因此降级） |
| **未验证（如实记录）** | 集团真实 Embedding/Rerank 接口连通与真实响应格式（**需用户提供：DCS_EMBEDDING_URL、DCS_EMBEDDING_API_KEY，可选 DCS_RERANK_URL/API_KEY**——文档地址已脱敏，代码用完整 URL 不追加路径）；真实文档导入→检索→Agent 回答含出处的端到端。接口可用后：`npm run knowledge:ingest` → 提问验证（测试问题见 test/acceptance-cases/knowledge-testdoc.md） |

### 9.10 知识库审查修复（2026-09-29，外部代码审查三缺陷）

架构不变，只修三处必要缺陷，未扩展框架：

| 缺陷 | 修复 |
|---|---|
| **1. 更新失败丢旧资料**（先删后写，写入失败旧分块已删） | 原子替换：先写新分块（新 documentId）→ 成功后再删旧分块——写入失败时旧版本完整保留仍可检索；删除失败的残留由每次导入末尾的孤儿清理（findOrphanDocumentIds）移除；更新前显式校验向量维度与索引一致（不一致拒绝写入）。回归：K5i–K5l |
| **2. 长片段截断丢关键条件**（分块允许 2000 字但渲染只取 1500，末尾限制条件可能丢失） | 渲染返回完整片段正文，删除单片段截断；总长度约 8000 字控制改为按 rank 舍弃低排名【完整片段】（rank 1 无条件保留），并注明省略数量。回归：K9b'/K9d/K9e（构造末尾含"10:30 截止不可撤销"的长片段验证完整保留） |
| **3. 标题章节不参与检索**（只有正文参与向量化/重排序，长章节尾部片段缺上下文） | 新增 embeddingText（《标题》+章节+正文），导入向量化与检索 rerank 统一使用；展示仍用原文+出处。CHUNKING_VERSION 1→2 强制重建索引（旧索引向量未含标题信息）。回归：K9a'/K9c |
| **DOCX 能力边界**（纯文本提取，不保留标题层级与表格结构） | README §6.1 明确说明：制度表格类资料导入后需人工核对，不默认结构完整（见该节"DOCX 能力边界"） |

---

## 10. 快速上手（开发者）

```bash
cd <DCS-Agent 仓库本地目录>
npm install

# 1. 离线检查（无需任何凭据；任一失败非零退出）
npm run check

# 2. CLI 真实模型调试（默认模拟身份；优先按 .env.example 配置 .env.local）
# PowerShell：
$env:LLM_API_KEY = "sk-xxxxxxxx"
$env:LLM_BASE_URL = "https://your-model-host/v1"
# bash：
# export LLM_API_KEY="sk-xxxxxxxx"
# export LLM_BASE_URL="https://your-model-host/v1"
npm run dev

# 3. 真实业务验收（真实员工身份 + 真实库 + 真实模型，见 §7.5）
#    先按 test/acceptance-cases/cases.example.json 填写真实案例（cases.json）
$env:DCS_DB_USER="xxx"; $env:DCS_DB_PASSWORD="xxx"; $env:DCS_DB_CONNECT_STRING="host:1521/SVC"
npm run test:accept:live
```

扩展指引：加工具 → `dcs/tools.ts` 实现 `ToolDefinition<Args, DcsToolContext>` 并加入 `dcsTools`；换模型 → 实现 `StreamFn` 契约替换 `openai-compatible.ts`；组装 Agent → 一律走 `dcs/agent-factory.ts` 的 `createDcsAgent`（不要在 Channel 层手写 new Agent）。
