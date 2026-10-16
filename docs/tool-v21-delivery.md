# Tool V2.1 离线交付记录

状态：现行
日期：2026-10-14
取代关系：取代tool-v2-delivery.md的当前接口、授权范围和验证结论

本次完成源码可验证的离线实现。**真实Oracle及真实模型未验证，不声称完成全业务授权或实际员工业务验收。** 用户已明确本次仅完成离线。Core、Agent Loop、Provider、模型、maxTurns、Context、登录流程、RAG实现及四工具注册入口不变。

## 文件清单

| 文件 | 变化 |
|---|---|
| src/dcs/code-tool.ts | 精确开放Libraries/Luxshare.DCS.BLL、Libraries/Luxshare.DCS.Data；凭据字面值脱敏，保留正常Token签名/变量 |
| src/dcs/schema-tool.ts | 批准DCS Schema内可见表元数据；可选schema不能切换owner；保留标识符/数量限制 |
| src/dcs/db/authorization.ts | 会话绑定；岗位跨员工专用授权、宿舍显式厂区授权；未知权限独立状态 |
| src/dcs/db/queries/catalog.ts | 四个固定查询、严格参数验证、权限范围SQL条件及分页 |
| src/dcs/query-tool.ts | list_available；目录执行、结构化行、过滤说明、分页、SQL执行明细 |
| src/dcs/db/result.ts | 区分员工拒绝与连接账号无法验权 |
| src/dcs/prompt.ts | 区分操作指导/代查、不同岗位页面、工具不支持/无权限/无记录；允许有证据的技术说明 |
| src/observability/observer.ts | tool_end.databaseQueries记录SQL、binds、行数、耗时、安全错误码，递归凭据脱敏 |
| test/tools-v2.test.ts | 原边界测试保留；适配有意变化的状态/元数据契约；新增生产工具授权分支用例 |
| test/observability.test.ts | SQL绑定日志与凭据隐藏回归 |
| test/wecom.test.ts | 旧自由SQL仍不执行，状态由forbidden改unsupported |
| README.md、docs/tool-v21-* | 当前范围、证据、完整Schema与验收边界；旧V2交付标为存档 |

## 最终四工具Schema

[tool-v21-schemas.json](tool-v21-schemas.json)从实际`dcsTools`和`queryCatalog`导出，包含四个工具的完整name/description/parameters及每个业务查询的参数Schema。无第五个工具。

## 实际查询目录

| query | 参数 | 读取范围与权限 |
|---|---|---|
| list_available | 无 | 返回能力定义；不读取数据库，也不声明员工拥有权限 |
| self_permissions | keyword/roleKeyword/menuKeyword/offset/limit | 绑定请求者工号的角色、菜单和菜单URL；不用于推断数据范围 |
| position_certificates | employeeNo（缺省本人）/kind=all或technical或general/jobId/keyword/offset/limit | GetCertInfo证书列表投影；本人直接查，其他工号需请求者AppMyMenu包含shanggangzhengchaxun |
| self_book_dinners_today | offset/limit | 本人当天未取消的客人订餐；不包括其他报餐系统或地点管理分支 |
| dorm_room_residents | companyCode/roomId（必需）/offset/limit | 指定厂区房间在住人员；当前员工显式DormAdmin厂区权限 |

limit默认100、最大100；offset默认0、最大10000。字面关键词采用绑定INSTR，不插入SQL。查他人先独立验权，业务SQL再次带请求者授权/范围条件，不能用模型提供的角色或actor绕过。自由SQL、未知业务返回unsupported；没有开放SQL拼接执行入口。

分页使用Oracle OFFSET/FETCH（需12c+，尚待真实版本/语法验证）。每页多取一行用于hasMore。rowCount是本次取回行数（含探测行），**不是总命中数**；returnedRowCount是实际展示行数。输出控制约50k字符行数据、单元格200字符；截断明确标记。没有COUNT全表统计。

## 真实源码依据与实现差异

详细路径与行号见[权限证据](tool-v21-permissions.md)，本机源码根为`D:/work/DCS code`。源码核对不等于数据库验收。

- **岗位证书**：ElearningController.cs:130、133–140明确检查请求者AppMyMenu专用代码。150–170重点岗位State=ZC(1)、员工岗位及岗位定义未禁用；209–226一般岗位State=Accept(2)、未禁用、内连Employee并左连Paper。没有当前日期到期过滤。查询只投影证书记录，不生成图片、不写查询日志；稳定按kind/记录ID分页。可选jobId按各kind对应ID过滤，一般岗位的这一筛选为Agent额外缩小条件；返回说明明确这一点。
- **后台岗位管理**：TechnicalJobSearchController.cs:283及289还使用CompanyOwner范围、状态!=SX；BaseController.cs:125检查PermissionUrls/ADMPermissionUrls。这与证书列表不同，不能用证书授权开放全部后台岗位申请/定义/审核记录。
- **宿舍**：DormController.cs:803 GetDormitory（819起范围/关联）；R_DataPermissionSet.cs:28–45按员工和DormAdmin位标志(1)获得厂区。Agent只继承显式厂区授权，绑定房间与厂区；关联未禁用且未锁定房间、未禁用楼栋、OutEmpCode为空的入住记录。相对原接口只取在住人员，不返回空床、不联查EDH班次；分页不提供全量历史统计。
- **报餐**：BookDinnerApiController.cs:63 GetComplitInfo的本人OR分支。保留本人、未取消(BookStatus!=2)、当天条件；Agent明确使用Asia/Shanghai当天，原服务DateTime.Now的部署时区仍须比对。未复制未经核实的GetLocations地点管理授权。
- **开发者**：UserInfo.IsDeveloper来自CommonHelper.GetDCSDevelopers静态名单，非用户声明角色。没有复制名单或放开该绕过；需要依赖特殊绕过的员工尚不支持完整等价访问。
- **菜单与角色**：UserRole/Role/RolePermission/Permission只证明分配关系，不能代替上面各业务范围。

## 可复制工具调用示例

以下为工具参数示例；OTHER001/C1/7是合成示例值，不能证明实际员工已获授权。请求者从当前会话获得，不能通过params指定。

```json
{"query":"list_available"}
{"query":"self_permissions","params":{"keyword":"岗位","limit":20}}
{"query":"position_certificates","params":{"kind":"technical"}}
{"query":"position_certificates","params":{"employeeNo":"OTHER001","kind":"general"}}
{"query":"dorm_room_residents","params":{"companyCode":"C1","roomId":7}}
{"query":"self_book_dinners_today"}
```

同一条OTHER001调用：当前员工有专用授权时查询；没有时denied；授权SQL失败时unverifiable且不查询业务记录。宿舍C1授权不允许访问C2。不能把岗位证书规则虚构为按部门限制：该API源码的专用授权没有部门过滤。

```json
{"operation":"find","pattern":"*TechnicalJob*.cs"}
{"operation":"search","path":"Libraries/Luxshare.DCS.BLL","pattern":"GetCompanyCodes|DormAdmin","mode":"regex"}
{"operation":"read","path":"Luxshare.DCS.WebApi/Areas/Staff/Controllers/ElearningController.cs","offset":130,"limit":45}
{"operation":"list","keyword":"S2_E_TECHNICAL"}
{"operation":"describe","tables":["S2_E_TECHNICALJOBEMP","S2_GENERALJOBAPPLY"]}
```

## ToolResult状态示例

以下为精简合成示例，实际成功结果还包含columns、filters、分页和截断字段。

```json
{"status":"success","authorization":{"status":"authorized","basis":"GetCertInfo: 请求者AppMyMenu明确授予跨员工证书查询"},"rows":[["OTHER001"]],"returnedRowCount":1}
{"status":"empty","authorization":{"status":"authorized","basis":"本人"},"rows":[],"returnedRowCount":0,"hasMore":false}
{"status":"denied","message":"当前员工没有GetCertInfo要求的跨员工上岗证查询授权；不代表没有其他页面的权限。","isError":true}
{"status":"unverifiable","code":"NJS-530","message":"业务授权查询失败，无法确定权限；未读取目标员工业务数据。","isError":true}
{"status":"unsupported","message":"工具尚未覆盖此业务查询；不能据此判定用户无权限。","isError":true}
```

Oracle连接账号ORA-01031为unverifiable，不是员工denied；连接失败为unavailable、SQL错误为sql_error、超时为timeout、参数错误为invalid_args。empty只说明本页/条件的结果，不能推断整个岗位模块为空或缺少数据权限。

## 离线测试结果

2026-10-14以下命令全部实际运行并退出0：

| 命令 | 结果 |
|---|---|
| npm run typecheck | 通过 |
| npm run check | 完整离线回归通过 |
| npm run test:tools | 32组通过 |
| npm run test:accept | 原3个Runtime剧本及32组生产工具测试通过 |
| npm run test:web | 30项通过 |
| npm run test:wecom | 32项通过 |

check其余套件：smoke81、CLI7、identity21、factory12、harness21、knowledge55、observability80，均零失败。本地原始输出保存在忽略文件`.v21-check.log`及`.v21-{typecheck,tools,accept,web,wecom}.log`。

新增工具测试覆盖：A本人、B有专用权限的他人、C无权限/伪管理员、未知授权停止、宿舍C1允许/C2拒绝、输入actor/SQL注入/非法分页参数拒绝、范围条件和绑定参数、空结果、分页、BLL/Data访问及Token凭据处理。Fake Model链验证工具回填与多轮接线；它的固定答案不证明真实模型会主动调查。SQL文本/绑定的离线测试也不证明Oracle真正接受这些SQL。

沙箱执行源码测试曾因系统临时目录realpath返回EPERM，改为沙箱外执行同一套离线测试；没有因此连接真实服务或放宽生产权限。

## 真实验证及性能

- Oracle：此前沙箱内外均返回NJS-530（主机解析失败）。没有成功读取元数据、权限或业务记录。用户要求本次只完成离线，因此不继续联网尝试。部署前需比对Oracle版本、表字段/布尔映射、权限记录、时间口径、已知员工的DCS页面结果。
- 真实模型：本次未运行，不能保证Qwen会正确选工具、正确引用或更快回答。Prompt约束仍不是强制检索路由，本次按要求未添加Router或改Loop。
- 用户提供旧日志：三轮模型累计267.73秒、工具1.6秒，总269.34秒；能确认原例主要耗时在模型调用，不能把本次离线通过描述为模型延迟优化。没有测量新的首Token或思考Token耗时。
- 管理员日志继续保留现有上下文、参数、结果；新增固定查询的SQL/binds/行数/耗时/错误码。凭据必须脱敏；SQL日志不是用户可提交SQL的入口。

## 未支持与后续核对

没有实现全业务通用授权。后台岗位管理/审核完整列表、部门递归范围、岗位汇总、历史住宿统计、管理地点报餐、开发者特殊绕过仍未开放；缺少完整页面授权映射或真实数据库对照。需要恢复环境后以至少本人/授权范围内/范围外三类真实账号逐项对照原DCS；不需要为了完成本次离线实现再人工批准权限规则。

用户所说“重点岗位和一般岗位功能里没有数据”仍需确认具体入口，并对照该页面过滤条件及真实记录。本次修复使工具能依据已核实规则查询和调查，但不能在无数据库证据时断言该故障已经解决。
