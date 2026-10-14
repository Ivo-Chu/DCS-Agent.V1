# Tool V2 实施交付记录

状态：现行（本次交付记录；运行现状以 README.md 和 src/ 为准）
日期：2026-10-14
取代关系：本次工具接口取代旧 query/contextLines 源码搜索及开放 SQL 工具；不取代 Runtime

## 1. 结果与边界

已直接修改代码，四工具固定注册：知识库、源码、Schema、授权数据查询。没有新增 Router、Planner、Agent 或框架；本次未改 Core、Provider、maxTurns、Context、入口及 RAG 实现。工作区原有的 Core/日志/入口/RAG 未提交变更均保留，不能把整个 git diff 当成本次改动。

未完成真实数据库或模型上线验收；没有连接真实 Oracle，也没有调用集团模型。跨员工宿舍查询、自由 SQL 和全部表结构访问没有已验证授权，执行层拒绝。不是已上线全业务版本。

## 2. 本次文件变化

新增：

- src/dcs/code-tool.ts：find/search/read。
- src/dcs/schema-tool.ts：受控 list/describe。
- src/dcs/query-tool.ts：本人菜单模板、状态与拒绝边界。
- src/dcs/db/authorization.ts：可信身份、Schema 解析、元数据允许表及参数化模板。
- src/dcs/db/result.ts：安全错误分类，不回传原始异常。
- test/tools-v2.test.ts：26组生产工具离线测试。
- test/runtime-tools.fixture.ts：保留旧 Runtime 剧本专用的假查询工具；不在生产注册。
- docs/tool-v2-delivery.md：本记录及实际 Schema。

修改：src/dcs/tools.ts、src/dcs/prompt.ts、src/dcs/db/client.ts、src/dcs/db/format.ts、src/dcs/db/guard.ts、package.json、.env.example、README.md、test/smoke.ts、test/acceptance.ts、test/agent-factory.test.ts、test/identity.test.ts、test/wecom.test.ts、test/cli-fixture.mjs。

没有删除文件。旧 tools.ts 中的融合搜索/开放SQL实现被替换；旧源码接口测试迁移到 tools-v2。smoke 和 acceptance 的旧菜单/报餐剧本使用测试专用 fixture，继续验证 Runtime，不再冒充生产授权测试。

## 3. 源码实现

使用 execFile 调用外部 rg，参数数组传递 pattern，没有 Shell 拼接。find 用 rg --files 获取白名单项目文件，先进行有界 * / ? 通配符过滤，再校验候选真实路径；search 按稳定排序分批传递已校验文件，使用 rg --json，默认 --fixed-strings，regex 模式使用 rg 原生正则；read 使用 Node 文件读取，1基行号返回。

严格顶层白名单：Luxshare.DCS.WebApi、Luxshare.DCS.WebApp、Common。保留目录/扩展名/secret文件过滤；绝对路径、..、盘符/UNC 和符号链接不允许。没有“找不到白名单就搜索整个根目录”的旧降级。配置文件允许发现名称，禁止展示内容；源码敏感行及跨行赋值隐藏，保留行号。凭据扫描并非能识别任意无标签秘密：源码目录仍需由部署方维护为允许暴露的受控代码。

集中限制 CODE_LIMITS：find50、search20、read默认80/最多200行、文件2MiB、候选15000、扫描10秒、行1000字符、总输出24000字符；rg缓冲4MiB。超限明确返回 truncated/hasMore/incomplete；扫描不完整不得解释为不存在。find/search offset从0计，read从1计，返回nextOffset支持继续读取。literal空格不拆词，换行pattern明确拒绝，避免rg隐式拆成多模式。

依赖：没有新增 npm 包。本机 rg 已可用；Windows/Linux 部署需安装 rg 到PATH或配置 DCS_RG_PATH。缺失会明确提示，不自动安装、不回退到无界扫描。本次实际执行环境为 Windows，Linux 未实机验证。

本机真实源码抽查：find *RegAccom*.cs 完整返回7个文件，约899ms；宿舍目录内搜索 DormAdmin，返回5条并明确仍有结果，约270ms。第一次 find 的候选校验位置不佳曾触及10秒，随后改为先过滤文件名再校验。以上为一次本机抽查，无旧版对照，不是端到端效率基准。

## 4. Schema 实现

仅可信企微会话可调用；当前可见表为 S2_USERROLE、S2_ROLE、S2_ROLEPERMISSION、S2_PERMISSION。此范围只支持解释本人的角色/菜单分配，不代表有其他员工数据权限。

list 使用 ALL_TABLES、OWNER 和 INSTR(TABLE_NAME, :keyword)，keyword按字面子串，不将%/_当通配符。describe 使用 ALL_TAB_COLUMNS、ALL_CONSTRAINTS、ALL_CONS_COLUMNS，返回OWNER、字段、类型、NULLABLE、实际主键及外键；复合约束按POSITION对齐。引用未授权表的外键端点被过滤。没有约束时不造关系，businessRelationships=unknown；表不可见和不存在无法区分时明确 not_found_or_not_visible。

优先 DCS_DB_SCHEMA，再复用身份链路已发现Schema；尚未发现时仅找S2_EMPLOYEE的OWNER，必须唯一，不回退数据库登录用户名。所有表名做标识符验证并受静态表范围限制，查询值绑定，无业务记录样例。describe最多5表、list默认20/上限50、输出24000字符，驱动截断与输出截断显式标记。

## 5. 数据查询、安全与已核对证据

query=self_permissions 唯一当前开放模板；工号来自 ctx.session，绑定 :employeeNo，模型不能提供工号或SQL片段。可信入口是企微 userid → 现有 Identity Resolver → createSession；Web代码明确 source=web，CLI为mock，均拒绝数据库工具。roles文字、自称管理员、源码调查结果都不能赋予执行权限。

已核对本地 DCS 源码：Libraries/Luxshare.DCS.BLL/UserRoleSet.cs 的 GetRoleCodesByEmpCode 按 EmpCode 取RoleCode；Data目录 UserRole/Role/RolePermission/Permission 实体中的 TableName、RoleCode、Code、PermissionId、Id 等字段。模板连接这四表，返回本人角色与菜单分配，不声称等价于所有有效权限或数据范围。

自由SQL统一forbidden，包括SELECT、WITH、函数调用、跨员工、AND/OR优先级绕过、DML/DDL；不是靠正则证明SQL安全。guardSql保留为保守预检查，不是授权边界。未知业务不使用虚构规则放行。

复用现有DbClient/连接池，增加可选binds和 SET TRANSACTION READ ONLY；finally回滚后释放连接，保留20秒callTimeout。驱动最多读取1001行，以第1001行判断1000行上限；展示最多100行、单元格200字符、序列化预算约60KiB，报告获得行数及实际展示行数，不声称是数据库总行数。错误按status/code/安全说明返回，原始连接异常不进入模型或工具日志。PII继续经过工具和Hook脱敏。

必须由部署方确认数据库账号最小SELECT权限、无写入/危险过程权限。本次没有查询真实账号授权；只读事务不等价于账号最小权限，也不保证任意函数无副作用，因此没有开放自由SQL。

## 6. 兼容性变化

- 源码旧 query/contextLines 参数不再接受，改用 operation/pattern/path/mode/offset/limit；search不再自动附带上下文，深入使用read。
- 原可读取配置文件现在仅能发现文件名；严格保留项目白名单，不再对其他根目录回退全盘扫描。
- 数据库旧sql参数只返回forbidden；模型应改用query=self_permissions。Web/CLI不能凭输入工号读库，需先建设正式认证。
- Schema为新增第四工具，非全库浏览器；宿舍表目前拒绝暴露。
- DbClient.execute增加可选binds，现有单参数调用兼容；增加只读事务/回滚及截断元数据。
- RAG参数、算法、分块、召回、Rerank保持原样；原实现已有未配置/空结果/检索失败/重排降级说明。

## 7. 验证结果

| 命令 | 结果 |
|---|---|
| npm run typecheck | PASS，exit 0 |
| npm run check | PASS，exit 0；全部离线套件 |
| npm run test:accept | PASS，exit 0；旧Runtime剧本 + 26组生产工具测试 |
| npm run test:web | PASS，30项 |
| npm run test:wecom | PASS，32项 |
| npm run test:tools | PASS，生产工具边界；已纳入check和test:accept |
| git diff --check | PASS；仅Git行尾提示，无空白错误 |

check覆盖：Tool V2 26组、smoke 81项、旧Runtime三场景、CLI 7项、WeCom 32项、Web 30项、identity 21项、factory 12项、验收harness 21项、knowledge 55项、observability 79项。日志位于工作区 tools-v2-check.log / tools-v2-accept.log / tools-v2-web.log / tools-v2-wecom.log（被现有日志忽略规则排除，不含真实数据）。

修复过的中间失败：新全链路测试误将Agent.context当作带messages对象，已按实际数组接口修正；identity旧测试期待自由SQL描述字典，改为验证执行层复用已发现Schema。最终没有遗留失败。

Oracle驱动接线测试使用fake createPool，验证只读事务、绑定参数、callTimeout、1001行截断判断、查询异常回滚和close；不是实际Oracle执行证明。Web/WeCom/CLI验证的是入口和流式协议，不是线上企业认证或业务验收。未执行真实DB、真实LLM、线上Web/WeCom测试；历史live-db自由SQL剧本不适用当前授权接口，需要正式测试身份与环境后更新验收案例。

## 8. Fake Model 调用示例

1. inspect_dcs_schema({operation:"describe",tables:["S2_ROLE"]})，ToolCallId=v2-0，假库返回CODE字段。
2. 下一轮确认收到v2-0结果；investigate_dcs_code({operation:"read",path:"Common/Dorm.cs",offset:2,limit:1})，id=v2-1，读取临时源码。
3. 下一轮同时看见前两条结果；query_dcs_data({query:"self_permissions"})，id=v2-2，以可信会话工号绑定假库。
4. 结果success，Fake Model输出“查到本人菜单；宿舍范围尚未授权。”并stop。最终三条ToolResult及id全部对应，消息顺序和停止机制没有改变。

Fake Model剧本固定，因此3次调用不能作为真实模型较38次调用更高效的证明。

## 9. 需要人工确认/真实环境验证

- 宿舍代码 RegAccomController.Search 使用 R_DataPermissionSet.GetCompanyCodes(DormAdmin, User.EmpCode)；R_DataPermissionSet还存在IsDeveloper分支。需确认可信DCS身份如何映射到该权限、PowerTypes实际存储及厂区代码、特殊身份是否应在Agent开放。不能将菜单权限推导为全公司范围。
- “东莞立讯”对应哪些厂区；2026-10-03至10-10是按入住日期、登记时间、在住快照还是办理次数；人员去重、退宿/调宿/历史记录及10月10日是否含全天的口径。
- 宿舍入住→房间→楼栋→厂区的完整关系与当前数据库约束/字段，以及历史统计应使用哪张记录表。源码发现的局部连接不能当作已确认统计SQL。
- 正式企微身份映射维护与撤销、Web/CLI正式认证、生产账号最小只读权限、真实Schema和表结构。
- 如需自由SQL管理员调查能力，必须先定义并验证对应权限及数据库隔离边界；本次没有管理员开关或信任角色名的后门。
- 需要对真实模型进行授权成功场景与明确拒绝场景的独立验收，记录工具次数、错误率、耗时；当前未宣称已减少真实业务38次调用问题。

## 10. 四个实际 Tool Schema

以下直接从本次代码的dcsTools导出，包括description和parameters；operation相关必要参数由execute进一步严格校验。

```json
[
  {
    "name": "search_dcs_knowledge",
    "description": "检索 DCS 知识库中的文档资料（操作手册、管理制度、通知公告、常见问题 FAQ 等）。适合回答「怎么操作」「制度规定是什么」「某功能怎么用」类文档问题；返回相关原文片段与文档标题及章节，回答时注明简洁出处（如：依据：《报餐操作手册》—取消报餐章节）。查实时业务数据（报餐记录、审批状态等）请改用 query_dcs_data。",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "检索关键词或问题（针对手册/制度/FAQ 的措辞检索效果最好）。"
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "investigate_dcs_code",
    "description": "定位并读取源码实现。find 使用文件名/路径 glob（如 *Dorm*.cs）；search 默认 literal 连续字面量匹配，空格不会自动拆词；regex 使用 ripgrep 正则，可用 宿舍|入住 表示或。read 用返回的相对 path 读取行号。offset：find/search 为从0开始的结果偏移，read 为从1开始的行号。配置文件内容不暴露。",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operation": {
          "type": "string",
          "enum": [
            "find",
            "search",
            "read"
          ]
        },
        "pattern": {
          "type": "string",
          "maxLength": 500
        },
        "path": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "literal",
            "regex"
          ],
          "default": "literal"
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200
        }
      },
      "required": [
        "operation"
      ]
    }
  },
  {
    "name": "inspect_dcs_schema",
    "description": "调查允许暴露的数据库元数据，不读取业务记录。list 按 keyword 字面子串找表（默认20，最多50）；describe 一次最多5张表，返回字段、主键及数据库实际外键。当前仅可信企微身份可查看本人菜单查询涉及的4张表；未确认授权的其他表拒绝。没有外键不代表不存在业务关系，未知关系不可猜测。",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operation": {
          "type": "string",
          "enum": [
            "list",
            "describe"
          ]
        },
        "keyword": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "tables": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1,
          "maxItems": 5,
          "uniqueItems": true
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [
        "operation"
      ]
    }
  },
  {
    "name": "query_dcs_data",
    "description": "查询已授权的真实业务数据。目前仅支持 query=self_permissions，返回可信企微当前员工的角色和菜单分配；工号由程序绑定。菜单不代表数据范围权限。自由 SQL 尚无可验证授权，传入 sql 会被拒绝；不可通过调查源码或自行声明管理员绕过。表结构使用 inspect_dcs_schema。",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "query": {
          "type": "string",
          "enum": [
            "self_permissions"
          ]
        },
        "sql": {
          "type": "string",
          "description": "兼容旧调用，仅返回 forbidden，不执行自由 SQL。"
        }
      },
      "oneOf": [
        {
          "required": [
            "query"
          ]
        },
        {
          "required": [
            "sql"
          ]
        }
      ]
    }
  }
]
```
