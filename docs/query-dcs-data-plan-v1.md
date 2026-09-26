# DCS Agent 数据库接入方案（query_dcs_data）

> 版本：v1 · 2026-09-24 · 状态：**已批准实施**（含当日两项拍板，见 §10）
> 依据：docs/tool-convergence-plan-v2.md 预留的 query_dcs_data 空位
> 环境：Oracle 19c（oracledb Thin 模式，免装客户端）；测试期权限全开放（决策记录见 §10）

## 1. 目标

为 Agent 增加第二个核心工具 query_dcs_data：AI 自主编写 SELECT 查询 DCS 真实数据库，与 investigate_dcs_code（查源码）互补——源码回答"系统是怎么规定的"，数据库回答"实际发生了什么"。

## 2. 驱动与连接

- 依赖 oracledb ^6 Thin 模式（纯 JS，npm install 即用）。
- 连接池 min 1 / max 2（bot 长驻进程）。
- 环境变量门控（未配置时工具明确返回"数据库查询能力当前不可用"，与 DCS_SOURCE_ROOT 模式一致）：DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING。

## 3. 文件落位（core 零改动）

```
src/dcs/db/
├── client.ts   # DbClient 接口 + oracledb 连接池惰性单例 + 测试工厂注入
├── guard.ts    # SQL 稳定性护栏（纯函数）
└── format.ts   # 查询结果格式化（纯函数）
src/dcs/tools.ts  # 新增 queryDcsDataTool
```

DbClient 抽象为接口（execute(sql) → {columns, rows}），冒烟测试注入假实现（同 FakeStreamFn 套路）。

## 4. 工具定义

- 名称 query_dcs_data；参数 `{ sql: string }`（唯一参数，模型自由编写）。
- 模型不知表结构时可自行查 Oracle 数据字典（ALL_TABLES / ALL_TAB_COLUMNS，示例带 OWNER 过滤）；也可先用 investigate_dcs_code 从源码发现表名/字段——两工具自然协同。
- 工具描述写明：DCS 系统库、只读、附数据字典查询示例。

## 5. 护栏（测试期最小集：仅防卡死）

| 护栏 | 规则 |
|---|---|
| 只读校验 | 仅 SELECT/WITH 开头、单语句（含注释内分号检测）、FOR UPDATE 拒绝；只读账号双保险 |
| 数量上限 | maxRows=100；输出超 60KB 截断并提示加 WHERE 收窄 |
| 超时 | callTimeout=20s |

错误契约：工具永不抛异常；ORA 错误截断后原样返回模型（供自我修正 SQL 重试，isError=false）。ToolResult 回填前过既有 maskPii 管线。

## 6. Prompt 调整

能力声明新增数据库一条（不固定路由、不限次数）：可查 DCS 系统数据库（只读、真实运行数据），不知表结构可先查数据字典或先用源码调查。**边界 4 对数据库查询继续生效**（见 §10 拍板）。

## 7. 测试计划

- 冒烟（假 DbClient）：格式化、100 行截断、非 SELECT 拒绝、多语句拒绝、FOR UPDATE 拒绝、ORA 透传、未配置不可用、maskPii 链路。
- 真实库：test:live:db（环境变量不齐即 SKIPPED，不以假数据冒充）。
- 真人验收：企微真实提问，观察模型自主写 SQL（并入 Step 9）。

## 8. 实施顺序

oracledb 安装 → guard/format（纯函数）→ client + 工具接线 → prompt → 冒烟全绿 + typecheck → 真实库验证 → 企微验收。

## 9. 上线前待办（当前明确不做）

- 恢复"只查本人"硬约束：named query catalog（employeeNo 服务端绑定）；选题依据 = 测试期高频真实问题。
- Legacy 工具（check_dcs_permission / query_business_data）删除：query_dcs_data 验证稳定后按方案 v2 §11 执行。
- 敏感表黑名单 / schema 白名单：测试期全开放决策下搁置。
- **脱敏增强（2026-09-24 拍板补充）**：银行卡号正则（16-19 位）、敏感列名黑名单（工资/银行卡/住址类列）——真实库含 maskPii 未覆盖的敏感字段，测试期知情接受，上线前必须补。

## 10. 拍板记录（2026-09-24）

1. **硬边界 4（只查本人）对数据库查询继续生效**：prompt 引导模型拒绝代查他人数据（软约束，测试期观察其有效性；工具层无强制，属知情决策）。
2. 脱敏覆盖面风险已知会（§9 第 4 条），记入上线前待办。
