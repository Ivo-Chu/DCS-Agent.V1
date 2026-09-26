# DCS Agent v1 严格审查报告

> 状态：存档（修复档案，文中问题均已修复，勿当作待办）
> 日期：2026-09-21
> 修复记录：见 README §9.1

审查日期：2026-09-21。依据：用户提供的完整 14 节定稿方案及开发目录约束。

**结论：架构基本符合，假模型链路已验证；不能认定 v1 已按方案完成验收。建议保留现有架构，修复模型边界与停止收尾问题，补齐真实模型验收后再签收。**

本次只新增 `audit/` 下的审查报告与复现脚本，没有修改 `src/`、原测试、依赖或配置。Pi、DCS 均只读查阅；复现模型响应全部在本地模拟，没有调用外部模型，也没有连接真实业务数据库/API。

## 1. 证据范围与限制

- 读完全部 10 个 src 文件、3 个原测试、package.json、tsconfig、lockfile 中相关依赖信息及 WorkBuddy 项目记忆。
- 本地 Pi 与 DCS 路径存在；`<DCS_SOURCE_ROOT>\Luxshare.DCS.WebApi\Controllers` 存在，当前统计 109 个 `.cs` 文件。项目记忆记载 97 个，与当前不符，但不能据此判断此前发生过什么变更。
- 对照阅读 Pi 的 Agent / AgentLoop 实现：当前项目是明显简化的独立实现，没有 Pi package/import 依赖，未发现大段照搬证据；这不是对全部 Pi 源码的逐行相似度鉴定。
- 当前没有 DEEPSEEK_API_KEY，真实 DeepSeek SSE 与真实 CLI 三问未执行。没有把缺 key 当作模型服务故障，也没有把跳过当作通过。
- 无完整历史操作审计，不能从最终代码证明 WorkBuddy 从未在项目外写文件，或严格按照阶段顺序实施。项目记忆已承认真实模型验证未做，因此第 12 节要求的阶段门槛并未全部满足。

## 2. 需求符合性

| 方案要求 | 判定 | 依据与限制 |
|---|---|---|
| 独立项目、指定目录 | 符合当前布局 | 工程位于指定路径；历史文件操作范围不可追溯 |
| Pi 仅作参考，无依赖/import | 符合已检查范围 | package 与 src 未引入 Pi |
| core / dcs / CLI 分层 | 基本符合 | 业务类型、规则、身份和工具在 dcs；core 仅有少量业务措辞注释 |
| Agent 持有状态，Loop 无长期状态 | 符合正常路径 | Loop 使用工作数组，Agent 在 Run 后一次性合并 newMessages |
| prompts / context / newMessages 所有权 | 符合正常路径 | 原测试验证完整历史传入、新增消息写回与输入数组未改变 |
| 通用 ToolDefinition / ToolHooks / StreamFn 接口 | 符合 | 泛型上下文无 DCS 类型绑定 |
| 模型消息转换只在调用边界 | 符合 | deepseek.ts 负责 OpenAI 格式转换 |
| API / 网络 / SSE 失败编码为 error | 部分不符合 | API/网络失败有处理；坏 JSON 与无完成标志 EOF 被标为 stop |
| 固定 mock 身份、不能由模型换工号 | 符合实现意图 | 工具读取 ctx.session；Schema 无身份字段；额外身份参数不会被业务逻辑采用 |
| 三个工具、权限/业务 mock | 符合 | 没有真实业务数据库/API 连接，没有 get_user_info |
| 源码搜索真实、只读、Controllers/.cs、≤5 命中 | 基本符合 | 实测搜索可用；多了环境变量根目录覆盖与静默扫描上限 |
| afterToolCall 脱敏再回填 | 正常路径符合 | 手机/身份证断言通过；hook 抛错时保留原文是缺陷 |
| v1 不实现 beforeToolCall 业务逻辑 | 符合 | 仅 core 保留扩展点 |
| 定稿 Prompt 与身份注入 | 基本符合 | 核心规则、200 字上限、身份块齐备；遵守程度尚无真实模型证据 |
| 七种最小生命周期事件 | 定义/发射符合，消费不完整 | CLI 忽略 agent_start/agent_end，assistant_message 主要用于换行，并非完整日志 |
| maxTurns 额外保护 | 仅轮次限制符合 | 耗尽时缺少明确终止结果，可能空回答 |
| FakeStreamFn 冒烟 | 通过 | 42 项断言通过，但不能证明模型决策与防泄露行为 |
| 第 12 节真实模型单测与 CLI 三问 | 未完成 | 当前跳过；现有 live 脚本也不是完整 Agent 三场景测试 |
| 第 14 节明确不做的能力 | 符合 | 没有引入 RAG、队列、多用户、持久化、工具并行、compaction 等 |

“Schema 无 employeeNo，所以模型不能指定”应更准确地理解为：模型可能输出额外字段，但工具不信任或使用该字段，因此不能切换实际查询身份。没有必要为了 v1 增加完整权限系统。

## 3. 必须处理的问题

### F1 — 高优先级：SSE 解析错误和不完整响应被视作正常完成

位置：`src/core/model/deepseek.ts:75`、`:180`、`:233`。

坏 JSON 被直接跳过；流结束后即使从未取得 finish_reason，也会通过 mapFinishReason(undefined) 得到 stop。用 HTTP 200、本地 SSE 响应复现：

- `data: {broken json}` → message_end / stop。
- 只有 `partial answer` 文本增量、没有完成原因就 EOF → 保留残缺文本并 message_end / stop。

影响：违反方案 §4 的 SSE 失败编码契约；用户可能拿到未完成答案，CLI/日志却没有错误提示。原测试只覆盖了无 key、网络错误，没覆盖解析器异常。

建议：记录收到的有效消息与完成原因；区分可忽略的注释/心跳和损坏的数据帧；无合法完成原因、坏数据帧等转为既有 error 事件。补分片、坏 JSON、正常结束、提前 EOF 的确定性测试，不必重构错误体系。

### F2 — 高优先级：length 截断的工具调用进入历史，缺少对应 ToolResult

位置：`src/core/agent-loop.ts:140`–`:152`；序列化边界 `src/core/model/deepseek.ts:56`。

当模型已输出工具调用增量，但结束原因为 length，Loop 仍把 toolCalls 写入 AssistantMessage，随后不执行工具就退出。下次请求实测被序列化为 system → user → assistant(tool_calls) → user，没有任何对应 tool 消息。

影响：后续模型请求包含未闭合的工具调用，存在被服务端拒绝、同一会话无法继续的风险。此处已证明请求形状错误；没有声称真实 DeepSeek 已返回某个 HTTP 错误。

建议：非 toolCalls 正常完成的调用片段不应作为完整可执行 tool_calls 留入历史。对 length 明確收尾，保留适当文本或错误说明，并确保下一次请求中的 tool_calls / tool_call_id 配对完整。不要执行截断参数。

### F3 — 中优先级：maxTurns 耗尽返回空答案，没有最终完成说明

位置：`src/core/agent-loop.ts:76`、`:149`、`:233`。

实测 maxTurns=1 且模型只发起工具调用：工具执行完成，context 为 user / assistant / toolResult；prompt 返回空字符串，同时发射 agent_end。maxTurns=8 遇到连续工具调用时也会发生相同收尾问题。

现有 G1/G2 只验证调用次数，没有验证 finalText、末尾消息或用户看到的结果。

建议：保持原轮次限制，耗尽后产生简短明确的终止说明并写入 AssistantMessage，使返回文本、事件与历史一致。可用既有 error 机制，无需引入复杂停止策略。补耗尽及无效 maxTurns 参数测试。

### F4 — 高优先级验收缺口：Fake 场景不能替代真实模型，live 脚本会误报通过

位置：`test/acceptance.ts:41`–`:44`、`:125`；`test/deepseek-live.ts:80`–`:94`。

- acceptance 的 FakeStreamFn 直接忽略 req，工具调用顺序、最终回复和追问答案全部预先写死。其作用是集成接线验证，不能证明真实模型读懂 Prompt、依据 ToolResult 作答、遵守权限顺序或使用历史。
- smoke 对消息传递的断言有效，因此不是“所有测试都无价值”；只是不能跨越证据边界宣称模型行为通过。
- live 的工具轮没有工具调用只 console.warn，最后仍显示“全部通过”。本地拦截 fetch，让模型始终只返回文本，实测 exit=0 且打印成功横幅。
- live 只调用适配器，不执行工具后再回填，也没有同一 Agent 的报餐追问，所以即使全部严格通过仍不能替代第 12 节 CLI 三问。
- 追问脚本输出了“工作日 08:00–10:30”，但前序只查过报餐订单，订单 ToolResult 并没有该配置；这是预置答案知道了测试外的信息。

建议：缺 key 明确报告 SKIPPED；必须出现工具调用时缺失即失败；验证完整 id/name/JSON 参数与完成原因。新增真实 Agent 三问验收，记录实际调用序列、回复、历史写回和请求结果。追问断言应是“不重复查权限”，不要擅自收紧成“任何工具都不能调用”；若要答报餐窗口，可以调用餐标配置工具。场景 2 应显式断言 42、35、7 和驳回，而不只是“超出/餐标”关键词。

### F5 — 输出边界问题：CLI 直接显示内部源码路径

位置：`src/index.ts:48`–`:51`；`src/core/agent-loop.ts:224` 附近的工具结果摘要。

实际 CLI + 本地模型 fixture + 真实只读搜索已复现：即使最终模型答复完全不含路径，终端仍打印 `[工具结果] ... Luxshare.DCS.WebApi/Controllers/...` 与代码摘要。afterToolCall 只做 PII 脱敏，不隐藏源码；Prompt 也无法约束 CLI 自己的输出。

方案 §6 要求 CLI 显示工具结果，而 §9 禁止向员工透露技术细节，存在展示口径需要协调：若 CLI 是开发者调试终端，可以保留内部日志但不得当成员工输出保密验收；若 CLI 就是 v1 用户界面，这条属于验收阻断。

建议：最小修改是在展示层对源码工具输出普通状态（例如“内部检索已完成”），完整内部结果仍回填模型。防源码泄露测试覆盖整个用户可见输出，而不只 finalText。真实模型输出的禁透露规则仍需单独验证；仅有 Prompt 不构成确定性防泄露保证。

### F6 — 中优先级、异常路径：afterToolCall 抛错时未经脱敏结果流入模型

位置：`src/core/agent-loop.ts:199`–`:210`。

catch 明确保留原始结果。本地工具返回测试手机号，afterToolCall 故意抛错；下一轮模型请求仍收到原手机号且 isError=false。

建议：处理失败时用安全的错误 ToolResult 替换原文，并设置 isError=true；不要继续使用未经过处理的内容。这不需要添加业务白名单或动态权限。当前正常 maskPii 未观察到自然抛错，故这是已复现的故障注入边界缺陷，不是声称当前每次都会泄露。

## 4. 次要问题与偏差

1. **before hook 异常没有兜底。** `src/core/agent-loop.ts:179` 在执行工具的 try/catch 外。故障注入时 prompt reject，Agent 不写回本轮消息、不发 agent_end。DCS v1 未配置 before hook，因此不作为当前 DCS 正常路径阻断；建议作为 core 扩展点低成本补强，并纠正 CLI “prompt 契约不会 throw”的注释。
2. **源码搜索新增未完全披露的限制。** 支持 DCS_SOURCE_ROOT、最多 500 文件、单文件 2 MiB，超过限制静默跳过。当前 109 个文件，不触发文件数上限；不能把这种搜索的“未找到”理解为完整仓库中没有。固定授权根目录，或明确覆盖参数仅用于受信任测试；保留限制则在结果中说明不完整。本次未发现写 DCS 文件的实现。
3. **权限菜单包含匹配可能歧义。** 输入“管理”会返回首个匹配的报餐管理，可能与用户意图不符；建议精确匹配优先、多个候选时要求澄清。不是当前三个明确问句的阻断项。
4. **core 严格文字要求仅部分满足。** 实现层无 DCS import 或业务字段，但 types.ts / agent-loop.ts 注释有 DCS、DcsToolContext、PII 等。若按“core 中不出现业务概念”逐字验收，应改成通用上下文/结果处理说明。不要把注释问题误判为运行时耦合。
5. **事件消费者不完整。** agent_start、agent_end 在 CLI 被忽略，assistant_message 不记录完整消息。这与 §6 的会话日志用途有差距，但事件 API 已存在。
6. **运行说明不适配 PowerShell。** CLI 与 live 提示使用 export；Windows 应使用 `$env:DEEPSEEK_API_KEY = '...'`。补 README、明确 Node 版本与 scripts 即可。
7. **交付材料不足。** 原目录无 README、独立验收报告或真实运行记录；只有 `.workbuddy/memory/2026-09-21.md` 的开发摘要。没有历史对话，不能断言开发者从未在对话中提供过说明，但仓库交付本身不完整。
8. **不应列为缺陷的内容。** 多用户并发、持久化、历史裁剪、RAG、企微、动态工具权限、工具并行均明确排除。当前不建议为验收新增这些能力。maxTurns=8 是可接受的默认实现选择；继续使用 mock 也完全正确。

## 5. 本次实际验证

环境：Windows PowerShell；Node v24.18.0；现有本地依赖，无安装操作。

| 命令/检查 | 实测结果 |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | 通过，exit 0 |
| `node --import tsx test/smoke.ts` / acceptance / live | 在当前工具环境加载 tsx 时，os.userInfo 报 uv_os_get_passwd ENOMEM；未进入项目测试 |
| `node test/smoke.ts` | 用 Node 24 原生 TS 支持执行，通过 42，失败 0 |
| `node test/acceptance.ts` | 3 个假模型场景，8 项断言全部通过 |
| `node test/deepseek-live.ts` | 缺 DEEPSEEK_API_KEY，明确跳过，exit 0；不是通过 |
| `node src/index.ts` | 缺 key，输出启动提示，exit 1，符合启动检查 |
| `node audit/reproduce.mjs` | 8 个审查观察全部复现；断言确认当前缺陷行为，不代表正确性通过 |

tsx 失败是当前审查执行环境的限制，未据此认定项目在用户普通终端无法运行。Node 24 直接执行证明了源码测试行为，但不能冒充 `npm run dev` 已真实通过。

复现脚本通过本地替换 fetch 构造 SSE，不调用外网；CLI fixture 会真实只读检索 DCS。`live-fixture.mjs` 特意让“模型不调用工具”以证明验收脚本的误报问题。

三个场景的实际输出（均为 FakeStreamFn 预置模型答案）：

| 问句 | 实际工具调用 | 实际返回文本 |
|---|---|---|
| 为什么我没有权限管理菜单 | check_dcs_permission | 你目前没有「权限管理」菜单权限：缺少系统管理员角色。如需开通，请联系部门系统管理员或 IT 服务台（分机 8888）处理。 |
| 我为什么报不了餐 | check_dcs_permission → query_business_data | 你今天的报餐订单被驳回了：金额超出当日餐标 7 元（餐标 35 元，实付 42 元）。把金额改到 35 元以内重新提交即可。 |
| 那餐标是多少（同一 Agent） | 无 | 餐标是 35 元/人/日，报餐窗口为工作日 08:00–10:30。 |

第二问之后的 6 条新增消息已写入 context；另有 smoke A11/A12 验证下一次请求携带历史。以上证明 Runtime 接线与状态传递，不证明真实模型按规则作答。

## 6. 最终目录与模块职责

```text
<DCS-Agent 仓库本地目录>\
├── package.json / package-lock.json / tsconfig.json / .gitignore
├── src/
│   ├── core/
│   │   ├── types.ts          通用消息、工具、上下文与模型事件接口
│   │   ├── events.ts         七种生命周期事件与同步订阅器
│   │   ├── agent.ts          配置、历史、prompt 与一次性状态写回
│   │   ├── agent-loop.ts     单次 Run 内的模型→工具→模型循环
│   │   └── model/deepseek.ts 消息转换、HTTP 请求与 SSE 解析
│   ├── dcs/
│   │   ├── session.ts        mock 员工身份与可信工具上下文
│   │   ├── prompt.ts         定稿 Prompt 与身份块
│   │   ├── tools.ts          两个 mock 工具与一个真实只读搜索工具
│   │   └── hooks.ts          手机号/身份证脱敏
│   └── index.ts              组装与 CLI REPL
├── test/
│   ├── smoke.ts              Runtime/工具的确定性断言
│   ├── acceptance.ts         三场景的脚本化假模型集成测试
│   └── deepseek-live.ts      适配器真实调用脚本，当前未完成验证
├── .workbuddy/memory/2026-09-21.md
├── node_modules/             原有依赖
└── audit/                    本次审查新增
    ├── review.md
    ├── reproduce.mjs
    ├── cli-fixture.mjs
    └── live-fixture.mjs
```

## 7. 最小整改与重新验收建议

1. 保留目录与接口，修 F1/F2/F3：SSE 错误识别、截断工具消息配对、maxTurns 最终收尾。
2. 修 F6 的处理失败策略；按 CLI 用户定位处理 F5 的内部摘要展示。
3. 修 F4 的测试判定。补本报告复现问题对应的正确行为回归断言；保留原 Fake 测试作为 Runtime 测试，不再视作真实模型验收。
4. 在用户本地安全配置 key 后执行真实适配器测试，再用真实 CLI 跑指定三问；保存脱敏事件记录、实际回答、请求是否携带历史、工具调用序列及全部检查结果。严格区分 PASS / FAIL / SKIPPED。
5. 补 README 与偏差清单；确认未拓展 v1 范围，再签收“最小 Agent Runtime 已验证”。

不需要重写架构，也不建议现阶段接真实数据库、实现复杂权限或搬入更多 Pi 功能。当前最重要的是修好已有最小链路的边界，并把实际验证做到方案要求的层级。
