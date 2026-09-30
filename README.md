# DCS Agent v1 — 功能与技术说明文档

> 状态：**现行（项目唯一现状文档）**；docs/ 为决策历史、audit/ 为修复档案、docs/archive/ 为已废弃方案，冲突时以代码为准（详见 AGENTS.md）
> DCS 员工智能助手：自研轻量 Agent Runtime + 企业微信机器人 / 网页端两个接入通道 + 真实 Oracle 数据查询、本地知识库（LanceDB + 集团 Embedding/Rerank）与 DCS 源码调查三个工具
> 版本：v1.x · TypeScript / Node 22+ / ESM（运行时依赖：@wecom/aibot-node-sdk、oracledb）

---

## 1. 项目定位

自研一套**最小可用的轻量 Agent Runtime**（架构思想参考 Pi，零 Pi 依赖），面向 DCS 员工提供系统问题自助解答。当前工具为**知识库检索**（`search_dcs_knowledge`，本地解析 + LanceDB + 集团 Embedding/Rerank）、**数据库查询**（`query_dcs_data`）与**源码调查**（`investigate_dcs_code`），接入通道为**企业微信机器人**（`npm run wecom:bot`）与**网页端**（`npm run web`），另有 CLI REPL（`npm run dev`，默认模拟身份，用于开发调试）。

```
User Prompt → Agent → AgentLoop → LLM → ToolCall → Tool Execution
→ ToolResult → LLM → Final Response → newMessages 写回 Agent Context
```

身份链路：CLI 默认模拟身份；Web / 企微走真实身份解析（工号建档 / 企微 userid → S2_Employee 数据库解析，仅在职，见 §5.2）。

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

`dcs/prompt.ts` 包含：结论先行、禁技术细节（文件路径 / 类名 / SQL / 接口地址，且抗"自称管理员"式越狱）、不编造、≤200 字、工具编排规则（先权限后数据；源码检索结果仅内部诊断）+ 当前员工身份注入块（属 DCS 层行为，Core 不知道身份存在）。

---

## 6. 工具清单（当前 3 个，全部真实数据源）

| 工具 | 状态 | 参数 | 数据来源 | 说明 |
|---|---|---|---|---|
| `search_dcs_knowledge` | **在用**（2026-09-29 RAG 接入；同日由 RAGFlow 替换为本地实现） | `query`（必填） | **本地知识库**：本地解析分块 → 集团 Embedding（Qwen3-Embedding-8B）→ LanceDB 余弦召回（默认 20 候选）→ 集团 Rerank（Qwen3-Reranker-8B，默认前 5） | 操作手册/制度/FAQ 等文档问答；返回原文片段+文档标题+章节/PDF页码出处；总输出约 8000 字（超出时减少低排名片段）；Rerank 失败降级向量序并注明；Embedding 失败 isError:true（不伪装无资料）；未找到（isError:false）与服务失败严格区分；超时与 Run 取消中止 HTTP；未配置 DCS_EMBEDDING_* 时能力不可用且 systemPrompt 不注入 |
| `query_dcs_data` | **在用**（方案 docs/query-dcs-data-plan-v1.md） | `sql`（必填） | **真实 Oracle 库**（oracledb Thin 连接池，只读） | 模型自主写 SELECT；护栏：纯函数 guardSql（仅 SELECT/WITH、单语句、拒 FOR UPDATE）+ 100 行截断 + 单元格 200 字符 + 60KB 体积保险；ORA 错误透传供模型自修正；结果统一过 maskPii 脱敏 |
| `investigate_dcs_code` | **在用**（方案 v2，取代原 search_dcs_code） | `query`（必填）、`path`（可选）、`contextLines`（可选，默认 3 最大 50） | **真实实现**：DCS 源码只读搜索 + 上下文读取 | 命中 ≤15 处，每处返回相对路径 + 行号 + 命中行（> 标记）+ 前后上下文；模型可多次调用逐步深入 |

**Legacy Mock 工具（check_dcs_permission / query_business_data）已于 2026-09-24 移除**（真实库验证 live:db 4/4 通过后，用户授权删除；所有业务数据查询统一走 query_dcs_data 真实库）。

`query_dcs_data` 实现要点（docs/query-dcs-data-plan-v1.md）：

- **数据链路**：`src/dcs/db/` 三模块——guard.ts（纯函数护栏）/ format.ts（行数与体积截断）/ client.ts（DbClient 接口 + oracledb Thin 连接池 min 1 / max 2，callTimeout 20s）；
- **环境变量门控**：`DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING` 任一缺失 → 能力明确返回不可用（与 DCS_SOURCE_ROOT 模式一致），不硬编码连接信息；
- **安全边界**：仅 SELECT/WITH；单语句（注释外分号即拒绝）；拒 FOR UPDATE；不执行任何 DML/DDL——测试期账号本身只读；
- **边界 4 对 DB 继续生效**：session 身份决定可查范围，数据库中其他员工的个人数据同样不得代查；
- **数据字典提示（2026-09-24 方案A+B）**：工具描述内置常用表速查（S2_Employee + 主权限表 S2_UserRole / S2_Role / S2_RolePermission / S2_Permission，字段名来自源码实体验证）+ "查某工号权限" JOIN 示例 + 防截断聚合提示；DCS 另有一组 ADM 前缀权限表（S2_ADMUserRole 等）为管理模块独立权限、普通员工通常无记录，已在字典中注明；schema 提示为 getter 动态生成——`DCS_DB_SCHEMA` 显式配置 > identity 链路自动发现结果 > 登录名兜底，修复了"未设 DCS_DB_SCHEMA 时回退登录用户名把模型引向 0 行数据字典"的死路提示（真人测试"我有什么权限"曾因此消耗 52 次工具调用试错）；
- **工具级观测日志（2026-09-24 方案C）**：bot.ts 订阅 tool_execution 事件，每次调用打印 `[tool] → 工具名 参数摘要` / `[tool] ← 工具名（耗时，结果摘要）`——测试期区分"没查对表"与"真没有数据"的观测手段（仅本地控制台，不进企微回复）；
- **测试**：smoke 场景 L（12 项，假 DbClient 注入，无需真库）+ `npm run test:live:db`（真实库 L-DB1~4，需环境变量，未配置优雅 SKIPPED）。

`investigate_dcs_code` 实现要点（docs/tool-convergence-plan-v2.md）：

- **搜索 + 定位 + 上下文融合**：单次调用即返回命中位置与必要上下文，无需 search→read 两段式；
- **范围**：顶层项目白名单 `Luxshare.DCS.WebApi / Luxshare.DCS.WebApp / Common` + 目录黑名单（bin/obj/packages/Scripts/Upload/Images/Content 等）+ 扩展名白名单（.cs/.cshtml/.js/.ts/.config/.json/.xml，排除 .min.）；
- **安全边界**：path 必须 resolve 后位于 `DCS_SOURCE_ROOT` 内（防 ../ 穿越 / 绝对路径 / 盘符 UNC 逃逸）；凭据文件名黑名单（.env/.pfx/.key/.pem/secret*）；单文件 2MB；单次命中 15 处、单文件 3 处；输出总体积 60KB 保险；
- **性能**：进程内文件列表 + 内容缓存（总量 256MB 上限），长驻 bot 首次全量约 10s、同进程后续约 1s；
- **凭据防线**：ToolResult 统一过 afterToolCall 脱敏（Password/Pwd/Secret/Token/ApiKey/AccessKey 值 → `***`），Web.config 可调查但连接串密码不会进入模型上下文。

### 6.1 本地知识库（search_dcs_knowledge 的后端）

**架构**（2026-09-29 由 RAGFlow 方案替换：取消 Docker / WSL2 / RAGFlow 部署要求，无需任何本地服务部署）：资料导入与检索全部在本地完成，仅向量化与重排序调用集团接口。

```
导入（npm run knowledge:ingest，可重复执行）：
本地文档（MD / TXT / DOCX / 可提取文字的 PDF，knowledge/documents/）
  → 提取正文（mammoth / pdf-parse；扫描版 PDF 与空文档明确报错，.doc 提示转存 .docx）
  → 结构分块（标题链保留 / 表格重复表头 / 段落 600–1000 字 / 超长句切 + 100 字重叠 / PDF 保留页码）
  → 集团 Embedding 批量向量化（Qwen3-Embedding-8B；输入=《标题》+章节+正文；首请求探测实际维度，不硬编码）
  → 本地 LanceDB（data/knowledge/，保存原文、向量、出处与导入清单）

检索（Agent 提问时）：
问题 → 集团 Embedding → LanceDB 余弦召回（默认 20 候选）
  → 集团 Rerank 排序（Qwen3-Reranker-8B，默认前 5；输入同 embedding=标题+章节+正文）
  → 完整原文片段 + 出处（片段正文绝不截断，末尾限制条件保留）→ 现有 Agent 组织答案并引用出处
```

**导入增量语义**：新文件入库；未变化跳过；已修改文件**原子替换**（先写入新分块、成功后再删旧分块——写入失败时旧版本完整保留仍可检索；删除失败的新版残留由下次导入的孤儿清理移除）；已删除文件同步移除；单文件失败保留此前可用版本。更新前显式校验向量维度与索引一致（不一致拒绝写入并提示重建）。更换 Embedding 模型 / 维度 / 分块规则后索引不兼容——打开时报错要求删除索引目录重建，绝不混用向量。

**DOCX 能力边界**：当前 DOCX 走纯文本提取，不保留 Word 标题层级与表格结构（表格会被摊平为文本行）。普通说明文档可直接试用；**若正式资料以制度表格为主，导入后必须人工核对检索结果**，不能默认"支持 DOCX"等于结构完整。结构化表格建议转存 Markdown 表格后导入。

**使用步骤**：

1. 放资料：`knowledge/documents/`（目录不存在时导入命令自动创建；已 gitignored 不入库；不递归子目录、不扫工作区）
2. 配置环境变量（见 .env.example 知识库段）：`DCS_EMBEDDING_URL` + `DCS_EMBEDDING_API_KEY` 必填（完整请求 URL，代码不追加路径）；`DCS_RERANK_URL` 可选——未配置时检索降级为向量排序并在结果中注明
3. 导入：`npm run knowledge:ingest`（失败项退出码 1，成功为 0）
4. 照常启动：`npm run web`（或 `wecom:bot` / `dev`），无需其他操作

**接口对接口径**：Embedding 按响应 `data[].index` 对位（不假设顺序）、校验数量/维度/数值有效性；Rerank 按 `results[].index` 找回本地候选、校验越界与重复、`top_n` 不超过候选数；两接口均不发送文档中冲突的 `prompt` 字段（按完整请求示例实施）。请求超时覆盖响应正文读取全过程。

**当前已验证状态**：离线全链路 46 项测试通过（真实 LanceDB 临时库 + mock 集团接口：含中文同义检索「取消报餐」→「撤销订餐」、增量同步四态、单文件失败保留、Rerank 降级、请求取消、超时）。**集团真实接口与真实文档导入未验证**（缺接口地址与凭据），见 §9.9。测试文档模板：`test/acceptance-cases/knowledge-testdoc.md`（虚构系统手册 + 5 个验证问题）。

**目标架构已落地**：`search_dcs_knowledge`（知识库）+ `query_dcs_data`（数据库）+ `investigate_dcs_code`（源码调查），无 Mock 工具。



**不提供 `get_user_info`**：身份已由 DcsSession 提供，不存在模型查询其他员工身份的场景。

**身份链路已接入真实库**（2026-09-24）：企微 userid → S2_Employee.UserId 自动解析工号/姓名/部门（仅在职；见 §5.2）；identity.json 降级为可选的手动覆盖文件。角色字段暂为空（ADM 权限表接入前）。

---

## 7. 运行与测试

### 7.1 命令

```bash
npm install                  # 安装依赖（typescript / tsx / @types/* / @wecom/aibot-node-sdk / oracledb）
npm run check                # 统一离线检查（typecheck + 全部离线测试，任一失败非零退出；不含真实模型/数据库测试）
npm run typecheck            # tsc --noEmit
npm test                     # 冒烟测试（FakeStreamFn + 假 DbClient，无需 key/真库）
npm run test:accept          # 三验收场景离线接线验证（FakeStreamFn，不证明模型行为）
npm run test:cli             # CLI 展示层入口级验证（本地假模型）
npm run test:wecom           # 企微 Channel 层测试（假动作/假 Agent/可控时钟）
npm run test:web             # Web Channel 层测试（假身份+假 Agent，真实 HTTP）
npm run test:identity        # 身份链路逻辑测试（临时 fixture，无需真库）
npm run test:factory         # Agent 组装工厂测试（拦截 fetch 验证取消信号真实接线）
npm run test:accept:harness  # 真实业务验收 harness 离线测试（案例加载/会话隔离/结果分类）
npm run test:knowledge      # 知识库全链路测试（真实 LanceDB 临时库 + mock 集团接口，无需配置）
npm run knowledge:ingest    # 知识库资料导入/更新（需 DCS_EMBEDDING_*，见 §6.1）
npm run test:live            # DeepSeek 真实 key 适配器单测（需 DEEPSEEK_API_KEY）
npm run test:live:db         # 真实 Oracle 库验证（需 DCS_DB_* 三变量，未配置优雅 SKIPPED）
npm run test:accept:live     # 真实业务验收（真实员工身份 + 真实库 + 真实模型，案例驱动，见 §7.5）
npm run dev                  # CLI REPL（需 DEEPSEEK_API_KEY；默认模拟身份）
npm run wecom:echo           # 企业微信长连接 Echo（需 WECOM_BOT_ID / WECOM_BOT_SECRET）
npm run wecom:bot            # 企业微信机器人（需 WECOM 凭据 + DEEPSEEK_API_KEY）
npm run web                  # 网页端（需 DEEPSEEK_API_KEY + DCS_DB_*）
```

**环境变量不会自动加载**：本项目不读取 .env 文件（无 dotenv），所有变量须在 shell 中设置（PowerShell：`$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"`；bash：`export DEEPSEEK_API_KEY="sk-xxxxxxxx"`），仅当前窗口有效。

### 7.2 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | dev / test:live | DeepSeek API 密钥，未设置时 CLI 与 live 测试优雅退出 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
| `WECOM_BOT_ID` | wecom:echo | 企业微信智能机器人 BotID（管理后台获取） |
| `WECOM_BOT_SECRET` | wecom:echo | 智能机器人长连接专用 Secret（非 Token/EncodingAESKey） |
| `DCS_SOURCE_ROOT` | investigate_dcs_code | DCS 源码根目录（指向本机 DCS 源码树，具体路径不入库）。**必须显式配置**，代码不硬编码；未配置时源码调查能力明确返回不可用 |
| `DCS_EMBEDDING_URL` / `DCS_EMBEDDING_API_KEY` | search_dcs_knowledge | 集团 Embedding 接口完整请求 URL + 凭据（两项齐备才启用知识库；URL 为完整地址，代码不追加路径）。未配置 → 工具返回能力不可用，systemPrompt 不注入知识库段，不影响其他工具 |
| `DCS_EMBEDDING_MODEL` | 否 | 默认 `Qwen3-Embedding-8B`；更换模型需重建索引 |
| `DCS_RERANK_URL` | 否 | 集团 Rerank 接口完整 URL（未配置时检索降级为向量排序并注明） |
| `DCS_RERANK_API_KEY` / `DCS_RERANK_MODEL` | 否 | Rerank 凭据（缺省复用 Embedding 凭据）/ 模型（默认 `Qwen3-Reranker-8B`） |
| `KNOWLEDGE_DIR` / `KNOWLEDGE_INDEX_DIR` | 否 | 资料目录（默认 `./knowledge/documents`，gitignored）/ 索引目录（默认 `./data/knowledge`，gitignored） |
| `DCS_KB_TIMEOUT_MS` / `DCS_KB_CANDIDATES` / `DCS_KB_TOP_N` / `DCS_KB_EMBED_BATCH` | 否 | 接口超时（20000，覆盖正文读取）/ 召回候选（20）/ rerank 返回数（5）/ 向量化批量（16） |
| `DCS_DB_USER` | query_dcs_data（真实库） | DCS 库用户名（测试期建议只读账号）。与下两项任一缺失 → 数据库查询能力明确返回不可用 |
| `DCS_DB_PASSWORD` | query_dcs_data（真实库） | DCS 库密码 |
| `DCS_DB_CONNECT_STRING` | query_dcs_data（真实库） | 连接串（`主机:端口/服务名` 或 EZConnect 格式），oracledb Thin 模式免装 Oracle 客户端 |
| `DCS_DB_SCHEMA` | 否 | DCS 表所属 schema。**通常无需设置**：未设置时身份链路会自动查 ALL_TABLES 发现 S2_Employee 的 OWNER（唯一时自动采用，多个时要求显式指定，无法访问时报权限错误）。设置后跳过自动发现 |
| `WEB_PORT` / `WEB_RUN_BUDGET_MS` / `WEB_STATIC_DIR` | 否 | Web 通道端口（8787）/ 单 Run 预算（90000）/ 前端静态目录（默认 ../DCS Agent.web） |

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
$env:WECOM_BOT_ID = "xxxx"; $env:WECOM_BOT_SECRET = "xxxx"; $env:DEEPSEEK_API_KEY = "sk-xxxx"
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
→ 90s 预算 abort + 丢弃 Agent（与 agent-runner 同口径）
```

| 位置 | 职责 |
|---|---|
| `src/web/server.ts` | HTTP 静态服务 + SSE + 会话/重置接口；依赖注入可测（`test/web.test.ts` 15 项） |
| `D:\work\DCS Agent.web\`（独立目录，不在本仓库） | 前端三件套 index.html / style.css / app.js（原生 JS 零框架；设计稿 v4） |

前端路径解析顺序：`WEB_STATIC_DIR` 环境变量 > 默认 `../DCS Agent.web`（与本项目同级）。测试期身份为页面输入工号建档（无认证，上线前换真实认证）。

启动：

```powershell
$env:DEEPSEEK_API_KEY = "sk-xxxx"; $env:DCS_DB_USER="xxx"; $env:DCS_DB_PASSWORD="xxx"; $env:DCS_DB_CONNECT_STRING="host:1521/SVC"
npm run web   # http://localhost:8787
```

可选环境变量：`WEB_PORT`（默认 8787）、`WEB_RUN_BUDGET_MS`（默认 90000）、`WEB_STATIC_DIR`。

### 7.3 测试覆盖（当前状态）

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
| Agent 组装工厂（agent-factory.test.ts：拦截 fetch 验证取消信号真实接线/新旧 Run 信号隔离） | ✅ 9/9（2026-09-28 新增） |
| 验收 harness（acceptance-harness.test.ts：案例加载跳过/会话复用与身份隔离/结果分类/报告渲染） | ✅ 21/21（2026-09-28 新增） |
| 知识库全链路（knowledge.test.ts：配置门控/分块规则/Embedding与Rerank客户端校验/导入增量同步/原子更新与维度校验/孤儿清理/配置不匹配拒开/检索→重排→出处格式/同义检索/降级/取消/完整片段不截断/长度控制） | ✅ 55/55（2026-09-29 审查修复后，真实 LanceDB 临时库 + mock 集团接口） |
| 企微长连接 Echo（Step 1，真实联调） | ✅ 2026-09-22 通过（真实 userid/msgid/回复送达） |
| core 纯净度（无 DCS import） | ✅ grep 验证 |
| 验收判定对抗（smoke 场景 K：错误字符串含关键词必须 FAIL） | ✅ 4/4 |
| DeepSeek 真实 key 适配器单测（test:live） | ⏸ **未验证（SKIPPED）**——缺 `DEEPSEEK_API_KEY` |
| 真实 Oracle 库验证（test:live:db，L-DB1~4：DUAL/数据字典/UPDATE 拒绝/ORA 透传） | ✅ 2026-09-24 通过（连接 / 数据字典 / 护栏 / 错误透传 4/4） |
| 真实 DeepSeek 验收（test:accept:live，2026-09-28 重建为案例驱动真实业务验收） | ⏸ **未验证（SKIPPED）**——缺 `DEEPSEEK_API_KEY` / `DCS_DB_*` / 真实案例（cases.json 待填写，见 §7.5） |
| 知识库真实链路（集团真实 Embedding/Rerank 接口 + 真实文档导入 → 检索 → Agent 回答含出处） | ⏸ **未验证**——缺集团接口地址与凭据配置（见 §9.9）；离线 46/46 已过，配置后 `npm run knowledge:ingest` 即可启用 |
| 企微→Agent→回复 端到端（Step 9 真人验收） | ⏸ **未验证**——需凭据配置后真人测试 |

冒烟测试验证点：prompts / context / newMessages 边界与调用方数组不可变性、多 Turn 循环、ToolCall→execute→ToolResult→下一轮 LLM 回填、Agent 状态写回、脱敏管线（含"脱敏发生在回填模型之前"）、beforeToolCall 阻断扩展点、maxTurns 保护（含耗尽时终止说明）、StreamFn 永不 reject 契约，以及审查回归：SSE 坏帧 / 无 finish_reason EOF 编码为 error（H1–H5）、length 截断残缺 toolCalls 剥离与序列化配对（I1–I6）、Hook 异常兜底不泄原文 / 不击穿 Run（J1–J7）。

### 7.4 验收场景接线输出（FakeStreamFn 预置模型行为 + 假 DbClient——仅证明 Runtime 接线与状态传递，不证明真实模型行为）

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

1. **真实 key 验证未执行**：`DEEPSEEK_API_KEY` 未设置，§12 步骤 2（真实 key 单测）与步骤 5（CLI 真实三问）**未验证（SKIPPED）**，不以假模型代替；`test:live` / `test:accept:live` / `dev` 脚本已就绪，key 到位即可执行。
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

1. **live 验收（含场景 4 核心验收 Case："黄石智通已勾选无需协调员…"源码自主调查）未执行**——缺会话级 `DEEPSEEK_API_KEY` 与 `DCS_SOURCE_ROOT`；
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

# 2. CLI 真实模型调试（默认模拟身份；环境变量需在 shell 设置，不自动加载 .env）
# PowerShell：
$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"
# bash：
# export DEEPSEEK_API_KEY="sk-xxxxxxxx"
npm run dev

# 3. 真实业务验收（真实员工身份 + 真实库 + 真实模型，见 §7.5）
#    先按 test/acceptance-cases/cases.example.json 填写真实案例（cases.json）
$env:DCS_DB_USER="xxx"; $env:DCS_DB_PASSWORD="xxx"; $env:DCS_DB_CONNECT_STRING="host:1521/SVC"
npm run test:accept:live
```

扩展指引：加工具 → `dcs/tools.ts` 实现 `ToolDefinition<Args, DcsToolContext>` 并加入 `dcsTools`；换模型 → 实现 `StreamFn` 契约替换 `deepseek.ts`；组装 Agent → 一律走 `dcs/agent-factory.ts` 的 `createDcsAgent`（不要在 Channel 层手写 new Agent）。
