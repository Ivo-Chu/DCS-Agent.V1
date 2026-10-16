# V2.1 权限证据与验证边界

状态：现行
日期：2026-10-14
取代关系：取代 V2 仅本人菜单的数据查询范围；不把 API 证书查询当作后台管理列表

本地源码根：`D:/work/DCS code`（已与 DCS_SOURCE_ROOT 核对）。以下路径相对该目录。

| 功能 | 入口/权限证据 | 数据规则 | 实施结论 |
|---|---|---|---|
| 岗位证书（重点/一般） | `Luxshare.DCS.WebApi/Areas/Staff/Controllers/ElearningController.cs:130` GetCertInfo；`:133-140` 非本人时检查请求者 AppMyMenu.MenuCodes.Contains("shanggangzhengchaxun") | 重点：`:150-170` 目标工号、State=ZC、员工岗位与岗位定义均未禁用；一般：`:209-226` 目标工号、State=Accept、未禁用、内连Employee | 可做等价只读查询；继承该入口明确的跨员工授权，不以角色名或通用菜单授权代替 |
| 状态存储 | `Libraries/Luxshare.DCS.Data/E_TechnicalJobEmp.cs:566` ZC=1；`GeneralJobApply.cs:154` Accept=2；两个实体TableName分别S2_E_TechnicalJobEmp/S2_GeneralJobApply | 两种岗位不同表、不同状态；原GetCertInfo没有用当前日期过滤证书到期时间 | 不擅加有效期过滤，不读取未被此入口允许的申请/拒绝/禁用记录 |
| 岗位 API 身份 | `Luxshare.DCS.WebApi/Controllers/BaseApiController.cs` RequestAuthorize；`Common/Attributes/RequestAuthorizeAttribute.cs` ValidateTicket验证当前请求者身份 | 原接口依赖DCS ticket；还生成证书图片/写查询日志 | 不伪造ticket调用接口；仅移植只读数据投影。Agent沿用企微身份/显式Web本机测试身份 |
| 后台重点岗位审核列表 | `Luxshare.DCS.WebApp/Areas/Elearning/Controllers/TechnicalJobSearchController.cs:283` Search；`:289` CompanyOwner范围与IsDeveloper分支；BaseController.cs:125 PermissionUrls/ADMPermissionUrls检查 | 状态!=SX、岗位未禁用，另有厂区、递归部门、申请日期、证书日期、是否离职等筛选 | 与GetCertInfo不是同一页面，不声称证书查询覆盖后台全部记录；完整后台权限映射未验证前不开放 |
| 特殊开发者 | `Common/Luxshare.DCS.Common/Classes/UserInfo.cs` IsDeveloper → `Common/Luxshare.DCS.Common/CommonHelper.cs:437` → GetDCSDevelopers静态工号名单 | 不是角色名称；部分入口绕过范围 | 不复制名单，不开放开发者绕过 |
| 宿舍厂区范围 | `Libraries/Luxshare.DCS.BLL/R_DataPermissionSet.cs:28-45`；`Libraries/Luxshare.DCS.Data/R_DataPermission.cs` DormAdmin=1 | EmpCode + PowerTypes.HasFlag(DormAdmin)，关联Company；IsDeveloper分支可获得全厂区 | 只采用显式厂区授权；不得把普通菜单或Web测试开关当成全厂区授权 |
| 报餐 | `Luxshare.DCS.WebApi/Areas/Staff/Controllers/BookDinnerApiController.cs:29` GetInit、`:63` GetComplitInfo | 本人 OR 业务地点范围；不同方法取的CompanyAddressCode来源不完全一致 | 只能先接入可证实的本人分支，管理地点范围需另核对GetLocations，不能虚构通用报餐权限 |

未读取真实权限记录前不声称某个实际员工有权。数据库在沙箱内外均返回 NJS-530；这是连接/主机解析问题，不是账号无业务权限的证据。用户要求本次仅完成离线，真实数据库与真实模型均标记未验证。
