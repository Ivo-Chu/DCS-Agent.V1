# DCS Agent v1 严格审查报告（第二次独立审查）

- 审查日期：2026-09-21
- 审查对象：`D:\Projects\DCS Agent.V1`（GLM5.3 按定稿方案实施）
- 审查依据：《DCS Agent v1 方案（最小可用 Agent Runtime 骨架 · 定稿）》共 14 节
- 审查方式：只审不改。项目源码、测试、配置零改动；复现脚本在系统临时目录执行后已删除
- 前置工作：复核了 `audit/review.md`（前次审查）全部结论，本报告全部疑点均经独立复现确认

---

## 一、总结论

**架构与方案逐条符合，最小骨架链路已验证成立；但 §12 真实模型验收未完成，且存在 6 项实测确认的边界缺陷，v1 当前不能签收。**

建议：保留现有架构不动，按优先级修复 P1 缺陷，拿到 DEEPSEEK_API_KEY 后完成真实三问验收，再行签收。

---

## 二、需求符合性（逐条核对）

| 方案要求 | 判定 | 依据 |
|---|---|---|
| 独立项目、固定路径 `D:\Projects\DCS Agent.V1` | ✅ 符合 | 工程位于指定路径 |
| Pi 仅作架构参考，零依赖 / 零 import / 无大段照搬 | ✅ 符合 | package.json 零运行时依赖，src 无 Pi 引用 |
| 目录结构（core/dcs/index.ts，共 10 个源文件） | ✅ 符合 | 与 §2 完全一致 |
| core 零业务依赖（无 DCS/企微/工号/脱敏概念） | ✅ 符合 | grep 验证无 DCS import；仅 types.ts:57、agent-loop.ts:178 等 3 处注释举例提及 |
| Agent 持有状态 / AgentLoop 无状态纯执行器 | ✅ 符合 | agent.ts / agent-loop.ts 职责划分与 §3 一致 |
| prompts / context / newMessages 消息所有权 | ✅ 符合 | AgentLoop 不修改调用方数组；Agent 在 Run 后一次性合并写回（冒烟 F1–F5 验证） |
| ToolDefinition / ToolHooks / StreamFn 通用接口 | ✅ 符合 | 与 §4 签名一致，泛型 Context 无 DCS 绑定 |
| StreamFn 契约：永不 reject，失败编码为 stopReason:"error" | ⚠️ 部分符合 | 无 key / 网络失败已编码；但 SSE 坏帧与无 finish_reason 的 EOF 被误判为 stop（见 F1） |
| 身份隔离：Schema 无 employeeNo，身份走 DcsToolContext | ✅ 符合 | 模型无法构造越权查询；工具只读 ctx.session |
| v1 Mock Session（张三/10086/制造一部/普通员工） | ✅ 符合 | dcs/session.ts |
| 三工具清单（无 get_user_info） | ✅ 符合 | 与 §7 一致 |
| check_dcs_permission / query_business_data 用 mock | ✅ 符合 | 未连接真实数据库/API；mock 数据与 §10 一致 |
| search_dcs_code 极简真实实现、只读、≤5 命中 | ✅ 基本符合 | 实测可用；新增 DCS_SOURCE_ROOT 覆盖、500 文件 / 2MB 上限（README §9 已披露的合理调整） |
| afterToolCall PII 脱敏，回填模型前执行 | ✅ 正常路径符合 | 手机号 138\*\*\*\*5678、身份证前 6 后 4（冒烟 C1–C6 验证） |
| v1 不实现 beforeToolCall 业务逻辑 | ✅ 符合 | core 仅保留扩展点 |
| systemPrompt 定稿文案 + 身份注入 | ✅ 符合 | dcs/prompt.ts 与 §9 逐字一致 |
| 7 个最小生命周期事件 | ✅ 定义/发射符合 | 消费不完整（见次要偏差 2） |
| maxTurns 额外停止保护 | ⚠️ 仅轮次限制符合 | 耗尽时无终止说明，返回空答案（见 F3） |
| FakeStreamFn 冒烟测试 | ✅ 通过 | 42/42，但不能证明真实模型行为（见 F4） |
| §12 真实 key 单测 + CLI 真实三问 | ❌ 未完成 | DEEPSEEK_API_KEY 未设置；live 脚本判定逻辑还有误报问题（见 F4） |
| §14 v1 明确不做的 14 项 | ✅ 符合 | 一项未偷跑 |

---

## 三、实测确认的问题（全部独立复现）

### P1 — 必须修复

**F1：SSE 异常被误判为正常完成（违反 §4 错误契约）**
- 位置：`src/core/model/deepseek.ts:180`、`:233`
- 复现：本地假 SSE 服务返回坏 JSON 帧 + 无 finish_reason 的文本增量后直接 EOF → 事件流产出 `text_delta → message_end:stop`
- 影响：坏 JSON 被静默跳过；流提前中断时 `mapFinishReason(undefined)` 落到 `"stop"`，用户拿到半截回答而系统认为一切正常
- 建议：区分可忽略行（心跳/注释）与损坏数据帧；无合法 finish_reason、坏帧 → 编码为既有 error 事件

**F2：length 截断的残缺 toolCalls 写入历史，污染后续请求**
- 位置：`src/core/agent-loop.ts:140–152`；序列化边界 `src/core/model/deepseek.ts:56`
- 复现：stopReason=length 且已收到工具调用增量（参数残缺为 `{"a":`）→ AssistantMessage 带着 toolCalls 入库但工具未执行；下一轮请求被序列化为 `assistant(tool_calls)` 后无配对 `tool` 消息
- 影响：服务端大概率拒绝该请求形状，整个会话无法继续
- 建议：非 toolCalls 正常完成时剥离残缺 toolCalls（保留文本或转错误说明），确保 tool_calls / tool_call_id 配对完整

**F3：maxTurns 耗尽返回空答案**
- 位置：`src/core/agent-loop.ts:76`、`:233`
- 复现：maxTurns=1 + 模型只发 toolCalls → 工具执行后循环退出，`finalText=""`，同时发射 `agent_end`；CLI 显示一条空回复
- 影响：现有 G1/G2 测试只断言调用次数，未断言 finalText，因此漏网
- 建议：耗尽后生成明确终止说明（可复用 error 机制）写入 AssistantMessage，使返回文本、事件、历史一致

**F4：真实模型验收未完成，且现有测试判定会误报**
- 位置：`test/acceptance.ts`、`test/deepseek-live.ts:80–94`
- 问题：
  1. acceptance 的 FakeStreamFn 忽略请求内容，工具顺序与答案全部预置——追问轮答出"08:00–10:30"，但前文 ToolResult 并无窗口时间，属剧本穿越；它验证的是接线，不是模型行为
  2. live 脚本模型不调工具时仅 `console.warn`，最终仍打印"全部通过"横幅（exit 0）
  3. live 只测适配器，不执行工具回填，也没有同 Agent 追问，即使全过也不能替代 §12 CLI 三问
- 建议：缺 key 明确报 SKIPPED；必须出现工具调用时缺失即 FAIL；新增真实 Agent 三问验收并留存实际工具调用序列、回复与历史写回证据

### P2 — 应当修复

**F5：CLI 直接打印内部源码路径**
- 位置：`src/index.ts:48–51`（打印 `tool_execution_end.summary`）；`src/core/agent-loop.ts` summarize 原文
- 影响：即使模型最终回复不含技术细节，终端仍打印 `[工具结果] ... Luxshare.DCS.WebApi/Controllers/...`。§6（CLI 显示工具结果）与 §9（禁止透露技术细节）存在口径冲突，需要拍板 CLI 定位：开发调试终端（可保留）还是员工界面（验收阻断）
- 建议（若为员工界面）：展示层对源码检索工具输出普通状态（如"内部检索已完成"），完整结果仍回填模型

**F6：Hook 异常路径漏防**
- 位置：`src/core/agent-loop.ts:179`（beforeToolCall 在 try/catch 外）、`:199–210`（afterToolCall catch 保留原文）
- 复现 1：afterToolCall 抛错 → 未脱敏原文（手机号）原样流入下一轮模型请求，isError=false
- 复现 2：beforeToolCall 抛错 → runAgentLoop 直接 reject，本轮消息不写回、不发 agent_end；index.ts 中"prompt 契约上不会 throw"的注释不成立
- 建议：afterToolCall 失败时替换为安全的 error ToolResult（isError=true）；beforeToolCall 调用包 try/catch

---

## 四、次要偏差（记录在案，不阻断签收）

1. **菜单包含匹配可能歧义**：输入"管理"会命中"报餐管理"（首个包含匹配），建议多候选时要求澄清
2. **事件消费不完整**：CLI 忽略 agent_start / agent_end，assistant_message 仅用于换行，§6 的"会话日志"场景名存实亡
3. **运行提示不适配 PowerShell**：README 与 CLI 报错提示使用 `export`，Windows 应为 `$env:DEEPSEEK_API_KEY = '...'`
4. **core 注释含业务词汇**：types.ts / agent-loop.ts 注释提及 DCS、DcsToolContext、PII；若按"core 中不出现业务概念"逐字验收需改为通用措辞（仅措辞问题，非运行时耦合）
5. **已披露的合理调整**（README §9）：maxTurns 默认 8、DCS_SOURCE_ROOT 覆盖、500 文件 / 2MB 上限、菜单包含式兜底、错误双保险——均属方案未明确处的最小补充，可接受

---

## 五、本次独立验证记录

环境：Windows；Node v24.18.0（原生 TS 执行）+ Node v22.22.2（tsc / tsx）；无安装、无项目文件变更。

| 检查项 | 实测结果 |
|---|---|
| `tsc --noEmit` | ✅ 通过，exit 0 |
| `test/smoke.ts`（Node 24 原生 TS） | ✅ 42/42 通过 |
| `test/acceptance.ts` | ✅ 3 场景 8 项断言全过（假模型预置答案，仅证明接线） |
| `test/deepseek-live.ts` | ⏸ 缺 DEEPSEEK_API_KEY，明确跳过（SKIPPED，非 PASS） |
| `src/index.ts` 无 key 启动 | ✅ 输出提示并退出，符合启动检查 |
| tsx 可用性 | ✅ tsx v4.23.15 在 Node 22 下正常（前次审查的 ENOMEM 为其工具环境特有问题，npm scripts 在普通终端可用） |
| F1 复现（本地假 SSE：坏 JSON + 无 finish_reason EOF） | ✅ 复现：误判 stop |
| F2 复现（length 截断 + 残缺 toolCalls 入历史） | ✅ 复现 |
| F3 复现（maxTurns=1 耗尽） | ✅ 复现：finalText="" |
| F6 复现（afterToolCall 抛错 / beforeToolCall 抛错） | ✅ 复现：原文流入 / runAgentLoop reject |
| DCS Controllers 目录 | ✅ 存在，109 个 .cs 文件（只读访问） |

三个验收场景实际输出（FakeStreamFn 预置，工具与链路真实）：

| 问句 | 工具调用 | 最终回复 |
|---|---|---|
| 为什么我没有权限管理菜单 | check_dcs_permission | 你目前没有「权限管理」菜单权限：缺少系统管理员角色。如需开通，请联系部门系统管理员或 IT 服务台（分机 8888）处理。 |
| 我为什么报不了餐 | check_dcs_permission → query_business_data | 你今天的报餐订单被驳回了：金额超出当日餐标 7 元（餐标 35 元，实付 42 元）。把金额改到 35 元以内重新提交即可。 |
| 那餐标是多少（同一会话追问） | 无 | 餐标是 35 元/人/日，报餐窗口为工作日 08:00–10:30。 |

---

## 六、整改与签收路线（按优先级）

1. 修 F1：SSE 坏帧 / 无合法 finish_reason → 编码为 error；补坏帧、提前 EOF、正常结束的确定性测试
2. 修 F2：非 toolCalls 完成时剥离残缺 toolCalls，保证历史消息中 tool_calls 配对完整
3. 修 F3：maxTurns 耗尽生成明确终止说明写入 AssistantMessage；补 finalText 断言
4. 修 F6：afterToolCall 失败替换为安全 error ToolResult；beforeToolCall 包 try/catch
5. 修 F4：live 脚本缺工具调用即 FAIL、严格区分 PASS/FAIL/SKIPPED；追问断言改为"不重复查权限"（允许调餐标配置工具）
6. 拍板 F5 的 CLI 定位，必要时对源码检索结果做展示层泛化
7. 设置 DEEPSEEK_API_KEY，执行 `npm run test:live` + CLI 真实三问，留存证据后签收

不需要重写架构，不建议现阶段接真实数据库或引入更多 Pi 机制。当前骨架设计是对的，把边界补上、把真实验收跑到位即可。
