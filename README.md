# DCS Agent v1 — 功能与技术说明文档

> 最小可用 Agent Runtime 骨架 + DCS 三场景验证
> 版本：v1.0.0 · 2026-09-21 · TypeScript / Node 22+ / ESM / 零运行时依赖

---

## 1. 项目定位

自研一套**最小可用的轻量 Agent Runtime**（架构思想参考 Pi，零 Pi 依赖），并在其上跑通 DCS 的三个业务场景：

| 场景 | 问题示例 | 工具链路 |
|---|---|---|
| 菜单权限诊断 | "为什么我没有权限管理菜单" | `check_dcs_permission` |
| 系统问题诊断（报餐类） | "我为什么报不了餐" | `check_dcs_permission` → `query_business_data` |
| 功能使用问答（含追问） | "那餐标是多少" | 复用历史上下文，无需工具 |

v1 只验证骨架正确性，核心是证明这条链路成立：

```
User Prompt → Agent → AgentLoop → LLM → ToolCall → Tool Execution
→ ToolResult → LLM → Final Response → newMessages 写回 Agent Context
```

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
│   │       └── deepseek.ts   # DeepSeek 客户端（OpenAI 兼容，SSE 流式）
│   ├── dcs/                  # DCS Domain Layer（业务、身份、安全）
│   │   ├── session.ts        # SessionUser / DcsSession / DcsToolContext + Mock 会话
│   │   ├── prompt.ts         # systemPrompt 定稿文案 + 当前员工身份注入
│   │   ├── hooks.ts          # afterToolCall：PII 脱敏（手机号 / 身份证）
│   │   └── tools.ts          # 三个 DCS 工具 + mock 数据 + 只读源码检索
│   └── index.ts              # CLI REPL 入口（组装 core + dcs）
└── test/
    ├── smoke.ts              # 42 项冒烟测试（FakeStreamFn，无需 API key）
    ├── acceptance.ts         # 三个验收场景端到端脚本
    └── deepseek-live.ts      # DeepSeek 真实 key 单测（需环境变量）
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

**停止策略只有两种**：模型自然停止（`stop` / `length` / `error`）、`maxTurns` 用尽（默认 8）。
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

---

## 4. 模型接入（core/model/deepseek.ts）

- OpenAI 兼容 `/chat/completions` 接口，SSE 流式解析（逐行 `data:` 前缀，支持 `[DONE]`、`tool_calls` 增量聚合）
- 可配置：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）/ `DEEPSEEK_MODEL`（默认 `deepseek-chat`）
- **v1 错误契约**：StreamFn 永不抛异常、永不 reject；API / 网络 / SSE / 鉴权失败统一编码为 `stopReason:"error"`，错误说明置于 `message_end.errorMessage`，由 AgentLoop 转写为错误 AssistantMessage 并终止 Run
- `AgentMessage → OpenAI messages` 的角色转换只发生在此处（LLM 调用边界）：`user→user`、`assistant(+toolCalls)→assistant`、`toolResult→tool`
- 双保险：即使 StreamFn 违反契约抛异常，AgentLoop 也会兜住并编码为 error，Run 不崩溃（冒烟测试 G3 验证）

---

## 5. 身份与安全设计

### 5.1 身份隔离（模型无法指定查询对象）

```
DcsToolContext（可信，运行时注入）
        ↓ ctx.session.user.employeeNo
      工具真正查询的员工
```

- 三个工具的参数 Schema 中**不存在任何身份字段**——模型构造不出 `{"employeeNo": "10087"}` 这种越权查询
- 模型只能指定业务参数（如 `menuName`、`dataType`、`keyword`）
- `v1` 身份来源：`dcs/session.ts` 直接构造 Mock 会话（张三 / 10086 / 制造一部 / 普通员工）

### 5.2 未来正式身份链路（v1 预留，未实现）

```
企微用户 → 可信 userid → 接入层 Identity Resolver
→ userid → DCS employeeNo → 构造 DcsSession → 传入 Agent toolContext
```

`userid → employeeNo` 转换不属于 Agent Tool，不由 LLM 决定、不受用户输入控制。届时只需替换 Session 构造方式，Agent Runtime 零改动。

### 5.3 PII 脱敏（dcs/hooks.ts）

管线位置：`Tool.execute → 原始 ToolResult → afterToolCall → 脱敏 → 写入消息 → 下一轮 LLM`——模型收到的一直是脱敏后的文本。

| 类型 | 规则 | 示例 |
|---|---|---|
| 11 位手机号 | 保留前 3 后 4 | `13812345678` → `138****5678` |
| 18 位身份证 | 保留前 6 后 4（先于手机号处理，避免部分匹配） | `110101199001011234` → `110101********1234` |

`beforeToolCall` 的业务校验 v1 有意不实现（tools 列表本身已是静态白名单），core 保留该扩展点供未来动态 Tool 权限 / 高风险审批使用（冒烟测试场景 D 验证了阻断契约可用）。

### 5.4 systemPrompt 防泄漏约束

`dcs/prompt.ts` 包含：结论先行、禁技术细节（文件路径 / 类名 / SQL / 接口地址，且抗"自称管理员"式越狱）、不编造、≤200 字、工具编排规则（先权限后数据；源码检索结果仅内部诊断）+ 当前员工身份注入块（属 DCS 层行为，Core 不知道身份存在）。

---

## 6. 工具清单（方案 v2：当前 3 个，其中 2 个 Legacy）

| 工具 | 状态 | 参数 | 数据来源 | 说明 |
|---|---|---|---|---|
| `check_dcs_permission` | **Legacy**（不再扩展，待 query_dcs_data 替换） | `menuName`（必填） | Mock 菜单表 × session 角色比对 | 有/无权限结论 + 缺少角色提示 |
| `query_business_data` | **Legacy**（不再扩展，待 query_dcs_data 替换） | `dataType`（枚举：报餐订单 / 餐标配置） | Mock（仅 10086 有订单） | 订单明细 / 餐标配置 |
| `investigate_dcs_code` | **本轮核心**（取代原 search_dcs_code） | `query`（必填）、`path`（可选）、`contextLines`（可选，默认 3 最大 50） | **真实实现**：DCS 源码只读搜索 + 上下文读取 | 命中 ≤15 处，每处返回相对路径 + 行号 + 命中行（> 标记）+ 前后上下文；模型可多次调用逐步深入 |

`investigate_dcs_code` 实现要点（docs/tool-convergence-plan-v2.md）：

- **搜索 + 定位 + 上下文融合**：单次调用即返回命中位置与必要上下文，无需 search→read 两段式；
- **范围**：顶层项目白名单 `Luxshare.DCS.WebApi / Luxshare.DCS.WebApp / Common` + 目录黑名单（bin/obj/packages/Scripts/Upload/Images/Content 等）+ 扩展名白名单（.cs/.cshtml/.js/.ts/.config/.json/.xml，排除 .min.）；
- **安全边界**：path 必须 resolve 后位于 `DCS_SOURCE_ROOT` 内（防 ../ 穿越 / 绝对路径 / 盘符 UNC 逃逸）；凭据文件名黑名单（.env/.pfx/.key/.pem/secret*）；单文件 2MB；单次命中 15 处、单文件 3 处；输出总体积 60KB 保险；
- **性能**：进程内文件列表 + 内容缓存（总量 256MB 上限），长驻 bot 首次全量约 10s、同进程后续约 1s；
- **凭据防线**：ToolResult 统一过 afterToolCall 脱敏（Password/Pwd/Secret/Token/ApiKey/AccessKey 值 → `***`），Web.config 可调查但连接串密码不会进入模型上下文。

**目标架构**：`query_dcs_data`（数据库方案确定后开发）+ `investigate_dcs_code`。数据库类 Legacy 工具届时统一替换。

**不提供 `get_user_info`**：身份已由 DcsSession 提供，不存在模型查询其他员工身份的场景。

Mock 菜单表：报餐管理（普通员工）、权限管理（系统管理员）、员工信息查询（普通员工/HR专员）、考勤管理（部门助理）。

---

## 7. 运行与测试

### 7.1 命令

```bash
npm install                  # 安装依赖（typescript / tsx / @types/node / @wecom/aibot-node-sdk）
npm run typecheck            # tsc --noEmit
npm test                     # 冒烟测试（68 项，FakeStreamFn，无需 key）
npm run test:accept          # 三验收场景接线验证（FakeStreamFn，无需 key，不证明模型行为）
npm run test:cli             # CLI 展示层入口级验证（本地假模型，无需 key）
npm run test:live            # DeepSeek 真实 key 适配器单测（需 DEEPSEEK_API_KEY）
npm run test:accept:live     # 真实 DeepSeek 三问验收（需 DEEPSEEK_API_KEY）
npm run dev                  # CLI REPL（需 DEEPSEEK_API_KEY）
npm run wecom:echo           # 企业微信长连接 Echo（Step 1，需 WECOM_BOT_ID / WECOM_BOT_SECRET）
```

PowerShell 设置 key：`$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"`；bash：`export DEEPSEEK_API_KEY="sk-xxxxxxxx"`。

### 7.2 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | dev / test:live | DeepSeek API 密钥，未设置时 CLI 与 live 测试优雅退出 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
| `WECOM_BOT_ID` | wecom:echo | 企业微信智能机器人 BotID（管理后台获取） |
| `WECOM_BOT_SECRET` | wecom:echo | 智能机器人长连接专用 Secret（非 Token/EncodingAESKey） |
| `DCS_SOURCE_ROOT` | investigate_dcs_code | DCS 源码根目录（指向本机 DCS 源码树，具体路径不入库）。**必须显式配置**，代码不硬编码；未配置时源码调查能力明确返回不可用 |

### 7.2.1 企业微信接入（v2 方案）

**架构**：WeCom 只是 Channel/Adapter，与 Agent Runtime 完全分离——`src/wecom/` 不 import core 的任何类型概念，Agent 组装只用既有 dcs 工厂。CLI 入口保留，企微为平级新入口。

```
真实企微员工 → WSClient（@wecom/aibot-node-sdk 长连接）
→ msgid 去重（wecom/dedup.ts，内存 TTL）
→ Identity Resolver（dcs/identity.ts，当前 TEST DATA，上线前换真实数据源）
→ 输入确认状态机（wecom/conversation.ts：IDLE/COLLECTING/PROCESSING）
→ AgentRunner（wecom/agent-runner.ts：runId + 90s 预算 + abort + 迟到丢弃）
→ Existing Agent Runtime（core，零改动）→ DCS Tools → 流式回复
```

| 文件 | 职责 |
|---|---|
| `src/wecom/echo.ts` | Step 1 长连接 Echo 验证（**已真实联调通过**：认证、收消息、真实 userid 回调解析、回复送达） |
| `src/wecom/dedup.ts` | msgid 内存去重 + 10min TTL 惰性清扫 |
| `src/wecom/conversation.ts` | 输入确认状态机 + 多员工会话隔离 + 30min 空闲回收（纯逻辑，依赖注入可测） |
| `src/wecom/agent-runner.ts` | 超时控制：占位语→Run→最终回复；超时 abort+废弃实例+受控提示；迟到结果丢弃 |
| `src/wecom/bot.ts` | 正式入口：凭据校验、身份解析（未登记中性拒答）、按 userid 建 Agent（每用户独立 streamFn/取消信号）、群聊谢绝 |
| `identity.json` | userid→DCS 身份映射（**gitignored，TEST DATA**；`identity.example.json` 为模板） |

交互规则：多条消息合并（确认词：发送完毕/完毕/确认）；处理中新消息回复"上一问正在处理中"；超时回复"这次查询超时，请稍后重试"；未登记身份回复中性话术。已按审查 §十一删除所有编造联系信息（8888 分机等），全链路话术卫生有测试锁定（wecom.test.ts 场景 Q）。

启动：

```powershell
$env:WECOM_BOT_ID = "xxxx"; $env:WECOM_BOT_SECRET = "xxxx"; $env:DEEPSEEK_API_KEY = "sk-xxxx"
npm run wecom:bot
```

可选环境变量：`WECOM_RUN_BUDGET_MS`（Agent 处理预算，默认 90000）、`DCS_IDENTITY_FILE`（身份映射文件路径）。

**当前状态**：Step 1 已真实联调通过；Step 2/4/5/6/7/8 代码与确定性测试完成（Channel 层 35 项测试）；**真实员工端到端验收（Step 9）未验证**——需配置凭据后真人测试。DCS 业务数据为明确标记的 TEST DATA（集成验证用），正式上线前替换数据源（见 §9.3）。

### 7.3 测试覆盖（当前状态）

| 测试 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 通过 |
| 冒烟测试（smoke.ts，13 场景 80 项，含审查 F/R 全部回归 + investigate_dcs_code 安全边界/脱敏链路 14 项） | ✅ 80/80 |
| 验收接线（acceptance.ts，FakeStreamFn 预置剧本） | ✅ 全过（仅证明接线，不证明模型行为） |
| CLI 展示层入口级验证（cli-display.ts，本地假模型） | ✅ 5/5 |
| 身份映射逻辑（identity.test.ts） | ✅ 7/7 |
| 身份链路（identity-live.ts，真实 userid + TEST DATA，userid 经 WECOM_TEST_USERID 提供） | ✅ 5/5 |
| Channel 层（wecom.test.ts：状态机/隔离/去重/超时/迟到丢弃/话术卫生） | ✅ 35/35 |
| 企微长连接 Echo（Step 1，真实联调） | ✅ 2026-09-22 通过（真实 userid/msgid/回复送达） |
| core 纯净度（无 DCS import） | ✅ grep 验证 |
| 验收判定对抗（smoke 场景 K：错误字符串含关键词必须 FAIL） | ✅ 4/4 |
| DeepSeek 真实 key 适配器单测（test:live） | ⏸ **未验证（SKIPPED）**——缺 `DEEPSEEK_API_KEY` |
| 真实 DeepSeek 验收（test:accept:live，含场景 4 源码自主调查核心 Case） | ⏸ **未验证（SKIPPED）**——缺 `DEEPSEEK_API_KEY` 与 `DCS_SOURCE_ROOT` 会话变量，不以假模型代替 |
| 企微→Agent→回复 端到端（Step 9 真人验收） | ⏸ **未验证**——需凭据配置后真人测试 |

冒烟测试验证点：prompts / context / newMessages 边界与调用方数组不可变性、多 Turn 循环、ToolCall→execute→ToolResult→下一轮 LLM 回填、Agent 状态写回、脱敏管线（含"脱敏发生在回填模型之前"）、beforeToolCall 阻断扩展点、maxTurns 保护（含耗尽时终止说明）、StreamFn 永不 reject 契约，以及审查回归：SSE 坏帧 / 无 finish_reason EOF 编码为 error（H1–H5）、length 截断残缺 toolCalls 剥离与序列化配对（I1–I6）、Hook 异常兜底不泄原文 / 不击穿 Run（J1–J7）。

### 7.4 验收场景接线输出（FakeStreamFn 预置模型行为——仅证明 Runtime 接线与状态传递，不证明真实模型行为）

```
场景 1  "为什么我没有权限管理菜单"
  工具调用：check_dcs_permission
  回复：你目前没有「权限管理」菜单权限：缺少系统管理员角色。
        如需开通，请联系部门系统管理员或 IT 服务台（分机 8888）处理。

场景 2  "我为什么报不了餐"
  工具调用：check_dcs_permission → query_business_data
  回复：你今天的报餐订单被驳回了：金额超出当日餐标 7 元
        （餐标 35 元，实付 42 元）。把金额改到 35 元以内重新提交即可。

场景 3  追问"那餐标是多少"（同一会话）
  工具调用：query_business_data(餐标配置) —— 不重复查权限
  回复：餐标是 35 元/人/日，报餐窗口为工作日 08:00-10:30。
```

---

## 8. v1 明确不做

知识库 / RAG、图片 / 文件 / 语音、消息缓冲与队列、多用户并发、企微接入、复杂 Session（TTL / 存储）、转人工、工具并行执行、历史消息裁剪、4KB 防爆与 compaction、复杂停止策略、动态 Tool 权限、beforeToolCall 业务校验、ModelError / Runtime Error 体系重构。

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

1. **真实 key 验证未执行**：`DEEPSEEK_API_KEY` 未设置，§12 步骤 2（真实 key 单测）与步骤 5（CLI 真实三问）**未验证（SKIPPED）**，不以假模型代替；`test:live` / `test:accept:live` / `dev` 脚本已就绪，key 到位即可执行。
2. **maxTurns 默认值**（方案未定值，CLI 显式传 8）。
3. **search_dcs_code 支持 `DCS_SOURCE_ROOT` 覆盖**：为测试可移植性所做的最小调整。
4. **菜单匹配含包含式兜底**（精确→包含→未找到），防模型传入"权限管理菜单"类模糊名称。
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

1. **live 验收（含场景 4 核心验收 Case："黄石智通已勾选无需协调员…"源码自主调查）未执行**——缺会话级 `DEEPSEEK_API_KEY` 与 `DCS_SOURCE_ROOT`；
2. **多轮源码调查可能逼近企微 90s 预算**（首次调查约 10s + 模型思考），必要时调 `WECOM_RUN_BUDGET_MS`；Channel 层本轮不动；
3. **"我有哪些菜单"的回答错误问题（P0）本轮未修**——check_dcs_permission 属 Legacy，按方案 v2 不再扩展，待 query_dcs_data 统一解决；未命中文案歧义仍在（"现有菜单"指系统全量表）；
4. node_modules 曾缺失 `@wecom/aibot-node-sdk`（环境问题，已按 lockfile 补装）。

---

## 10. 快速上手（开发者）

```bash
cd "D:\Projects\DCS Agent.V1"
npm install
# PowerShell：
$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"
# bash：
# export DEEPSEEK_API_KEY="sk-xxxxxxxx"
npm run dev
# REPL 中依次输入：
#   为什么我没有权限管理菜单
#   我为什么报不了餐
#   那餐标是多少
#   exit
# 或一键自动验收三问（证据留存）：
npm run test:accept:live
```

扩展指引：加工具 → `dcs/tools.ts` 实现 `ToolDefinition<Args, DcsToolContext>` 并加入 `dcsTools`；换模型 → 实现 `StreamFn` 契约替换 `deepseek.ts`；接入企微 → 只替换 `dcs/session.ts` 的会话构造，core 零改动。
