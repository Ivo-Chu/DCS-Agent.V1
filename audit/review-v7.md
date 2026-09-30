# DCS Agent v1 全面代码审查（review-v7）

> 状态：现行审查结论 · 日期：2026-09-30 · 范围：src/ 全部 30 个 TS 文件（约 4500 行）+ test/ + docs/ + 配置
> 性质：只评估不改代码。与以往 review 不同，本次为整体健康度评估，非针对单一缺陷的修复档案。

---

## 一、总体结论

项目整体质量**明显高于同规模个人项目的平均水平**：分层铁律（core 零业务依赖 / dcs 域层 / wecom+web 通道层）被真实执行而非口头约定；错误契约（StreamFn 永不 reject、工具异常编码为 ToolResult、Hook 失败丢弃原文）设计严谨且有对抗性测试锁定；README 是罕见的"活文档"。

当前主要风险不在代码质量，而在三处：**①上下文无累积长度治理（最大技术隐患）；②Web 通道认证形同虚设（最大安全隐患）；③知识库与真实业务验收两条"最后一公里"未闭环（最大功能缺口）**。

---

## 二、代码质量

### 优点
- 文件小而专注（最大 460 行），每个文件头部注释完整记录设计意图与修复历史，可追溯性极佳。
- 纯函数与依赖注入运用得当：guard.ts / format.ts / chunk.ts 纯函数；conversation / agent-runner / web server 全部 DI 可测。
- 命名、注释、README 三者一致性好；冒烟测试命名（H1–H5、I1–I6、J1–J7）与审查编号挂钩。

### 问题
| 级别 | 问题 | 位置 |
|---|---|---|
| 中 | **超时/取消/迟到丢弃逻辑重复实现两份**（约 90 行近乎相同）；getSlot/getEntry 模式也重复 | wecom/agent-runner.ts vs web/server.ts `runChat` |
| 中 | **模块级可变单例散落各处**：listCache/contentCache（tools.ts）、cache/dbCache/discoveredSchema（identity.ts）、clientFactory 单例（db/client.ts）。测试靠 reset 函数补救，长期会脆弱 | 多处 |
| 中 | **同步 fs I/O 阻塞事件循环**：investigate 工具的 readdirSync/readFileSync/statSync 在 async execute 内执行，首次全量扫描约 10s 期间 bot 无法处理任何其他用户消息 | tools.ts L94–153 |
| 低 | README §7.1 仍写"本项目不读取 .env 文件（无 dotenv）"，但 env-local.ts（2026-09-29）已加载 .env.local——**文档漂移** | README vs dcs/env-local.ts |
| 低 | README §9.9 / §7.3 仍记"知识库真实链路未验证"，但集团接口连通与首次真实导入已于 2026-09-30 验证通过——状态未回写 | README §9.9 / §7.3 |
| 低 | prompt.ts KNOWLEDGE_PROMPT 注释仍写"仅 RAGFLOW_* 配置齐全时注入"（RAGFlow 已移除）；session.ts 头注仍写"v1 身份来源 Mock"（已接真实库）——注释漂移 | prompt.ts L26 / session.ts L8 |
| 低 | ingest.ts 末尾 `void crypto;` 死引用；agent-runner.ts `void runId;` 语义靠 finished 标志实现，runId 名存实亡 | ingest.ts L255 / agent-runner.ts L123 |
| 低 | README 出现两个 §7.2.1（三层验证口径 / 企微接入） | README |
| 低 | 无 ESLint/Prettier/CI，代码风格靠自律 | package.json |

---

## 三、架构设计

### 优点
- core / dcs / channel 三层划分清晰且经 grep 验证；Agent（有状态）/ AgentLoop（无状态）职责拆分干净；agent-factory 统一组装杜绝了 Channel 层各自 new Agent 的分叉。
- 取消信号的"可变 holder"约定（2026-09-28 修复）在工厂、通道、工具三处保持同一对象，设计闭环。

### 问题
| 级别 | 问题 | 说明 |
|---|---|---|
| 高 | **Agent context 无累积长度治理** | 单条工具结果上限 60KB（SQL）/ 60KB（源码）/ 8KB（知识库），maxTurns=24。理论上一个 Run 可累积数百 KB 历史，长会话多轮追问后必然撞模型上下文上限 → API 报错；且每轮全量重发历史，token 成本线性膨胀。README §8 已列入"明确不做"，但这是最可能先在真实使用中爆雷的点 |
| 中 | **Web 通道无空闲回收**：agents/sessions 两个 Map 只增不减；token 永不过期 | wecom 侧有 30min 空闲回收，web 侧没有对应机制，长驻运行内存缓慢增长 |
| 中 | bot.ts `resolvedIdentities` Map 无界增长（量级小，但同类问题） | wecom/bot.ts L55 |
| 低 | 工具描述 getter 动态生成（schema 发现后修正提示）是聪明解法，但意味着同一进程内工具 schema 可变，若未来接模型侧 prompt 缓存需注意 | tools.ts L402 |

---

## 四、功能完整度

### 已实现
三工具（知识库/数据库/源码调查）+ 三入口（CLI/企微/Web）+ 真实身份链路（两级解析）+ 超时取消 + PII/凭据脱敏 + 本地 RAG 全链路（导入/增量/原子替换/孤儿清理/降级）。

### 明显缺口
| 优先级 | 缺口 | 说明 |
|---|---|---|
| P0 | **知识库端到端未闭环** | 集团 Embedding/Rerank 接口连通与首次真实导入已于 2026-09-30 验证通过（README 尚未更新此状态）；剩余缺口为"真实文档 → 检索 → Agent 回答含出处"的完整端到端验证（knowledge:e2e 脚本已就绪） |
| P0 | **真实业务验收未执行** | test:accept:live 案例驱动 harness 已建好，cases.json 未填写——"Agent 回答业务问题是否正确"目前没有任何证据 |
| P0 | **Web 通道认证缺失** | 页面输入工号即可冒任任何在职员工身份查其个人数据；token 为内存 randomUUID、无过期、无失败限速。测试期知情决策，但只要端口对内网开放就是实质越权入口 |
| P1 | "只查本人"仅靠 systemPrompt 软约束 | query_dcs_data 的 execute 完全不读 ctx.session，模型可写任意员工工号的 SQL。边界 4 依赖模型自觉——prompt 注入或模型失误即越权 |
| P1 | 无问答留痕与反馈机制 | 只有 console 日志；无 bad case 收集通道，运营改进缺数据入口 |
| P2 | 群聊不支持、无会话持久化、无历史导出、dedup 纯内存（重连可能重复投递） | 均有文档记录为范围外，按需排期 |

---

## 五、性能与安全

### 性能
- 连接池（min1/max2）、callTimeout 20s、结果 100 行/60KB 截断、知识库候选 20→5，量级设计合理。
- 主要隐患即上文：**同步 fs 扫描阻塞事件循环**（首次 ~10s）与**上下文无界增长**（token 成本 + 撞上限）。
- investigate 工具为线性文本扫描（无索引），当前 1.5 万文件上限内可接受；源码树继续膨胀后可考虑 trigram 索引或复用 ripgrep。

### 安全
| 级别 | 项 | 评估 |
|---|---|---|
| 高 | Web 工号建档无验证 | 见 §四 P0 |
| 中 | SQL 越权查询他人数据 | 工具层无拦截，仅靠 prompt（见 §四 P1）；guardSql 只防写不防越权读 |
| 低 | identity.ts 字符串拼接 SQL | userid 有字符白名单兜底，schema 来自环境变量/ALL_TABLES，风险可控；但建议改绑定变量彻底消除拼接 |
| 低 | 工具日志打印 SQL 原文（含工号） | 仅本地控制台，测试期可接受；转结构化日志时需评估脱敏 |
| 低 | guardSql 误杀合法 SQL（如字符串字面量含分号 `SELECT ';' FROM DUAL`） | 模型可改写绕过，影响小 |
| ✓ | 凭据/PII 脱敏、路径穿越防护、凭据文件黑名单、.env.local gitignored | 均有实现与测试锁定 |
| ✓ | 历史提交含敏感信息 | 已知遗留（私有仓库，filter-repo 暂不做），保持知情即可 |

---

## 六、测试与文档

### 测试
- 离线覆盖优秀：smoke 95 项（12 场景含全部历史审查回归）+ 身份 21 + wecom 28 + web 23 + factory 9 + harness 21 + 知识库 55，`npm run check` 一键收敛。
- 测试金字塔口径清晰（离线接线 / 真实运行完成 / 人工业务验收三层），且对抗性测试（场景 K：错误文本含关键词必须 FAIL）说明测试本身经过验证。
- 缺口：**真实模型/真实库/真实接口三层验证大面积 SKIPPED**（缺 key 与凭据）；无并发场景测试（两用户同时提问）；无 DB 连接池故障恢复测试。

### 文档
- README 作为唯一现状文档质量很高，AGENTS.md 的可信度优先级规则有效。
- 存在小幅漂移（§二已列）：env-local 与"不读 .env"矛盾、RAGFlow 残留注释、Mock 身份旧注、§7.2.1 编号重复。

---

## 七、改进方向（按优先级）

| # | 优先级 | 建议 | 理由 | 预期收益 |
|---|---|---|---|---|
| 1 | P0 | **闭环两条"最后一公里"**：跑通 `knowledge:e2e` 端到端（接口连通与首次导入今日已验证）；填写 cases.json 执行 `test:accept:live` | 这是"能用"与"证明能用"的分水岭，且能暴露离线测试无法发现的真实问题 | 知识库从"接口已通"变"能力就绪"；业务正确性首次有证据 |
| 2 | P0 | **上下文长度治理（最小版）**：历史消息超阈值时裁剪最旧工具结果（保留摘要）或设单 Run 累积字符预算，超限提前收尾 | 当前最可能在真实使用中爆雷的技术点；不需要完整 compaction 框架，一个 60 行的裁剪函数即可挡住 | 消除上下文溢出导致的莫名 API 失败；token 成本可控 |
| 3 | P0 | **Web 认证最低加固**：token 加 TTL（如 8h）+ sessions 过期清扫 + 建档失败限速（同 IP 连续失败锁定）；上线前换企微扫码/SSO | 当前任何能访问端口的人可冒任任何员工身份查个人数据 | 堵住最大越权入口；成本极低（约 50 行） |
| 4 | P1 | **抽取共享 Run 执行器**：把 web/server.ts runChat 与 wecom/agent-runner.ts 的"占位→预算→abort→迟到丢弃→受控收尾"合并为一个模块，两通道各自只做回复适配 | 消除最大的重复代码块；这类逻辑已出过一次真实 bug（2026-09-28 取消信号失效），重复两份意味着下次修复可能只改一处 | 减少约 90 行重复；修一处即两通道受益 |
| 5 | P1 | **Web 侧补齐会话回收**：agents/sessions Map 空闲 TTL 回收（对齐 wecom 30min 口径） | 长驻进程内存只增不减 | 防缓慢内存膨胀 |
| 6 | P1 | **数据访问收紧第一步**：query_dcs_data 执行时把 `ctx.session.user.employeeNo` 注入工具层，至少对命中 S2_Employee/含 IdCard/Telephone 的查询强制附加本人过滤，或先做"查询他人敏感表即警告日志" | "只查本人"目前纯靠模型自觉；prompt 注入即可绕过 | 软约束变半硬约束，为正式版 named query catalog 探路 |
| 7 | P2 | **investigate 扫描异步化**（改 fs.promises + 分片让出事件循环，或首次扫描放启动预热） | 首次 10s 同步扫描期间全 bot 无响应 | 消除事件循环阻塞点 |
| 8 | P2 | **文档漂移清扫**：README §7.1 环境变量段、两个 §7.2.1 编号、prompt.ts/session.ts 残留注释 | 小成本保 README 可信度（AGENTS.md 约定 README 是第二事实源） | 防后来者按过期说明操作 |
| 9 | P2 | **结构化问答留痕**：每 Run 输出一行 JSONL（时间/工号/问题摘要/工具调用数/耗时/成败），为 bad case 收集与运营分析备料 | 当前只有人眼读 console，无法回溯统计 | 运营改进有数据入口；排查问题可回放 |
| 10 | P3 | **CI 与工具链**：GitHub Actions 跑 `npm run check` + 引入 ESLint/Prettier | 多人协作或长期维护的基础保障 | 防回归自动化 |
| 11 | P3 | identity.ts 改绑定变量、guardSql 支持字符串字面量内的分号 | 彻底性改进，当前风险已被白名单控制 | 消除理论注入面与误杀 |

> P0 三项建议优先于一切新功能（群聊、多模态、持久化等）——它们决定当前已建成能力是否"真实可用且安全"。
