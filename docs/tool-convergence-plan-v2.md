# DCS Agent Tool 收敛方案 v2

> 状态：**已批准，本轮实施依据**（2026-09-23 用户定稿）
> 取代：docs/capability-release-plan-v1.md 中与本方案冲突的部分（Tool 拆分方式、search/read 融合、DCS_SOURCE_ROOT 配置方式）。

## 1. 本轮目标

重新收敛 DCS Agent 的 Tool 设计。

之前规划的：

- check_dcs_permission
- query_business_data
- search_dcs_code
- read_dcs_file

从能力本质上可以归纳为两类：

1. 查询 DCS 当前运行时数据；
2. 调查 DCS 源码实现。

因此不再按照"权限、报餐、搜索代码、读取文件"等具体动作拆分 Tool。

目标架构调整为：

```
DCS Agent
├── query_dcs_data        （暂缓：数据库接入方式未定）
└── investigate_dcs_code  （本轮实现）
```

其中：

- query_dcs_data：获取 DCS 当前运行时业务事实；
- investigate_dcs_code：调查 DCS 源码，寻找与用户问题相关的实现证据。

LLM 负责：

- 理解用户问题；
- 判断需要查数据、查代码，还是两者都查；
- 自主决定调查步骤；
- 综合 ToolResult；
- 基于证据推理；
- 最终组织答案。

Tool 负责提供基础能力，不负责为不同自然语言问题预定义业务流程。

## 2. 当前实施范围

本轮只开发 investigate_dcs_code；暂缓 query_dcs_data（数据库类型 / Schema / ORM / SQL 策略 / 数据权限边界 / 超时与结果限制均未确定，确定前不实现）。

不要为了兼容当前 Fake 数据而继续扩展 check_dcs_permission / query_business_data。旧 Tool 暂时保留用于现有测试，标记 Legacy / Temporary，不再扩展能力。本轮不删除旧 Tool，避免同时修改过多范围。

## 3. investigate_dcs_code 设计

职责："根据当前调查目标，在 DCS 源码中寻找相关实现证据，并返回足够模型继续推理的代码上下文。"

同时承担之前 search_dcs_code + read_dcs_file 的能力。不要求模型走 search→read→search→read 链路，Tool 单次调用即提供：搜索 + 定位 + 必要上下文读取。需要进一步调查时再次调用同一 Tool。

参数（保持简单）：

```
{ query: string, path?: string, contextLines?: number }
```

- query：必填，当前要寻找的关键词/方法名/字段名/业务名称；
- path：可选，限定搜索范围（DCS_SOURCE_ROOT 下的文件或目录），不传则搜索允许的源码范围；
- contextLines：可选，控制每个命中附近返回的上下文行数，有默认值与上限，防止一次返回大量源码。

不增加 intent / businessType / scenario / searchMode / controllerOnly / permissionType 等业务枚举。

## 4. 源码搜索范围

- DCS_SOURCE_ROOT 必须通过环境变量配置（指向本机 DCS 源码根目录，具体路径不入库），代码中不硬编码路径；未配置时 investigate_dcs_code 明确返回源码调查能力当前不可用。
- 允许搜索：Luxshare.DCS.WebApi、Luxshare.DCS.WebApp、Common。
- 排除：bin、obj、node_modules、dist、.git、.vs、packages、Upload、Images、Content、CSS、Documents、Template、App_Data、ffmpeg、RefDLL、Scripts、fonts、echarts 及其他明显依赖、构建产物、二进制和资源目录。
- 允许文本源码类型：.cs、.cshtml、.js、.ts、.config、.json、.xml；排除 minified / binary。

## 5. 搜索 + 阅读融合策略（渐进式上下文）

不采用"20 个命中 × 每个 200 行"。默认：最多返回 10~20 个候选命中，每个候选只返回少量上下文，每个结果含相对路径 + 行号。模型发现某文件值得深入时，再次调用（更具体 query / path 限定 / 增大 contextLines）。

宽搜索 → 模型选择线索 → 窄搜索 → 更多上下文 → 继续推理。

具体 MAX_HITS / contextLines 默认值按测试性能选择合理值，不作为最终生产参数。

## 6. 文件安全边界

- 所有 path 必须 resolve 后仍位于 DCS_SOURCE_ROOT 内；
- 防 ../ 路径穿越、绝对路径逃逸、UNC / 盘符绕过；
- 只读；单文件大小限制；单次上下文行数限制；扩展名白名单；凭据文件名黑名单；
- 不扩展成通用文件读取 Tool，只能调查 DCS 源码。

## 7. 凭据脱敏

任何 investigate_dcs_code ToolResult 进入 LLM Context 前必须经过统一脱敏，至少覆盖：Password、Pwd、Secret、Token、ApiKey、AccessKey、connectionString 中的密码字段。保留现有 PII 脱敏。重点针对 Web.config / connectionString 建测试 fixture。

原则：源码可以调查，配置可以调查，模型可以知道"这里存在数据库配置"，但真实凭据值不能进入模型上下文。

## 8. Prompt 调整

继续采用能力释放原则。Tool 描述调整为两能力模型。query_dcs_data 尚未实现，Prompt 不得假装它可用。Prompt 应告诉模型：

- 可以使用现有业务数据 Tool 获取已支持的测试数据；
- 可以使用 investigate_dcs_code 自主调查 DCS 源码；
- 遇到未预定义的 DCS 问题，不要因为没有专用 Tool 就直接拒绝；
- 源码能提供证据时可自主调查；
- 事实性结论需要证据支持；可以基于证据合理推理；区分已确认事实、推断和不确定信息；
- 不泄露凭据；不执行写操作；不越权查询他人敏感数据。

不增加固定 Tool 路由。

## 9. maxTurns

测试阶段 maxTurns = 24（宽松安全阀，非生产参数）。继续记录 turns / toolCalls 用于观察真实 Case 的 Agent Loop 深度。

## 10. 本轮明确不做

开发 query_dcs_data / 接真实数据库 / SQL Agent / list_my_menus / 扩展 check_dcs_permission / 扩展 query_business_data / 新增 read_dcs_file / 保留独立 search_dcs_code 作为最终 Tool / 考勤·厂区·数据权限·业务场景 Tool / RAG / 向量数据库 / 代码索引服务 / 修改 WeCom Channel / 无关重构。

## 11. 旧 Tool 迁移策略

- check_dcs_permission → 暂时保留，Legacy
- query_business_data → 暂时保留，Legacy
- search_dcs_code → 被 investigate_dcs_code 替代（本轮移出工具列表）
- 数据库方案确定后：query_dcs_data 验证 → 替换两个 Legacy 数据 Tool → 删除 Legacy。

## 12. 测试重点

全局搜索命中 WebApi/WebApp/Common；Areas 业务代码可搜索；path 限定；contextLines 生效；不会一次返回巨量源码；../ 穿越拒绝；ROOT 外路径拒绝；凭据文件拒绝；Web.config password/connectionString 进模型前脱敏；PII 脱敏不回归；未配置 DCS_SOURCE_ROOT 返回能力不可用；typecheck / smoke / acceptance 全量回归。

核心验收 Case（真实模型，不提示搜索关键词）：

> "黄石智通已勾选无需协调员，为什么离职流程还会显示协调员信息？"

观察：理解问题 → 自主调用 investigate_dcs_code → 根据第一轮结果选择下一条线索 → 再次调用 → 获得足够上下文 → 综合证据 → 给出有依据的业务解释。

## 13. 实施顺序

1. 凭据脱敏增强；
2. 实现 investigate_dcs_code（迁入并增强原 search_dcs_code 能力）；
3. Prompt 切换到能力释放版本；
4. maxTurns + turns/toolCalls 简单统计；
5. 更新测试；
6. typecheck + 全量测试；
7. 真实 Case live acceptance。

除非出现真实 blocker，不再进行总体架构 REVIEW，不扩大 scope。
