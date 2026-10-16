/** 查询目录是固定参数化查询，不是SQL路由器。权限依据见docs/tool-v21-permissions.md。 */
import type { DbClient, DbQueryResult } from "../client.ts";
import { authorizeCertificates, authorizeDormitory, type AuthorizationDecision } from "../authorization.ts";

const paging = { offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100 } };
const keyword = { type: "string", maxLength: 100 };
const employeeNo = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "目标员工；不覆盖会话请求者。缺省为本人。" };
export const queryCatalog = [
  { name: "self_permissions", description: "本人角色/菜单分配，非业务范围授权；可按角色或菜单过滤及分页。", parameters: { type: "object", additionalProperties: false, properties: { keyword, roleKeyword: keyword, menuKeyword: keyword, ...paging } } },
  { name: "position_certificates", description: "GetCertInfo证书列表：重点岗位正常且未禁用，一般岗位通过且未禁用。可查本人；查他人需AppMyMenu专门授权。不是后台岗位定义/全部申请列表。", parameters: { type: "object", additionalProperties: false, properties: { employeeNo, kind: { type: "string", enum: ["all", "technical", "general"], default: "all" }, jobId: { type: "integer", minimum: 1 }, keyword, ...paging } } },
  { name: "self_book_dinners_today", description: "BookDinnerApi.GetComplitInfo的本人分支：当天未取消的客人订餐。不是所有报餐系统，不开放管理地点或历史范围。", parameters: { type: "object", additionalProperties: false, properties: { ...paging } } },
  { name: "dorm_room_residents", description: "GetDormitory在指定厂区/房间的在住人员投影；必须具有该厂区显式DormAdmin权限。不含历史入住统计或开发者绕过。", parameters: { type: "object", additionalProperties: false, properties: { companyCode: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, roomId: { type: "integer", minimum: 1 }, ...paging }, required: ["companyCode", "roomId"] } },
];
export type Params = Record<string, unknown>;
export function validateParams(name: string, p: Params): string | undefined {
  const allowed: Record<string, string[]> = {
    self_permissions: ["keyword", "roleKeyword", "menuKeyword", "offset", "limit"],
    position_certificates: ["employeeNo", "kind", "jobId", "keyword", "offset", "limit"],
    self_book_dinners_today: ["offset", "limit"], dorm_room_residents: ["companyCode", "roomId", "offset", "limit"],
  };
  if (Object.keys(p).some(k => !allowed[name]?.includes(k))) return "包含此查询不支持的参数；不得提供请求者身份、权限范围或SQL片段。";
  for (const k of ["keyword", "roleKeyword", "menuKeyword"]) if (p[k] !== undefined && (typeof p[k] !== "string" || (p[k] as string).length > 100)) return `${k}必须是最多100字符的字符串。`;
  for (const k of ["employeeNo", "companyCode"]) if (p[k] !== undefined && (typeof p[k] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p[k] as string))) return `${k}格式错误。`;
  for (const [k, min, max] of [["offset", 0, 10000], ["limit", 1, 100], ["roomId", 1, 2147483647], ["jobId", 1, 2147483647]] as const) {
    if (p[k] !== undefined && (!Number.isInteger(p[k]) || Number(p[k]) < min || Number(p[k]) > max)) return `${k}超出范围。`;
  }
  if (p.kind !== undefined && !["all", "technical", "general"].includes(String(p.kind))) return "kind必须为all/technical/general。";
  if (name === "dorm_room_residents" && (p.companyCode === undefined || p.roomId === undefined)) return "宿舍查询需要companyCode和roomId。";
}
export interface QueryExecution { authorization: AuthorizationDecision; result?: DbQueryResult; filters?: string[] }
export async function executeBusinessQuery(name: string, p: Params, db: DbClient, owner: string, actor: string): Promise<QueryExecution> {
  const offset = Number(p.offset ?? 0), limit = Number(p.limit ?? 100);
  const binds: Record<string, string | number> = { actor, offset, take: limit + 1 };
  let sql: string;
  let authorization: AuthorizationDecision = { status: "authorized", basis: "当前员工本人数据，固定参数绑定" };
  let filters: string[] = [];
  if (name === "self_permissions") {
    binds.keyword = String(p.keyword ?? ""); binds.roleKeyword = String(p.roleKeyword ?? ""); binds.menuKeyword = String(p.menuKeyword ?? "");
    sql = `SELECT r.Name AS ROLE_NAME, p.Name AS PERMISSION_NAME, p.Url AS PERMISSION_URL
      FROM ${owner}.S2_UserRole ur JOIN ${owner}.S2_Role r ON r.Code=ur.RoleCode
      LEFT JOIN ${owner}.S2_RolePermission rp ON rp.RoleCode=ur.RoleCode LEFT JOIN ${owner}.S2_Permission p ON p.Id=rp.PermissionId
      WHERE ur.EmpCode=:actor AND (:keyword IS NULL OR INSTR(UPPER(r.Name),UPPER(:keyword))>0 OR INSTR(UPPER(p.Name),UPPER(:keyword))>0)
      AND (:roleKeyword IS NULL OR INSTR(UPPER(r.Name),UPPER(:roleKeyword))>0)
      AND (:menuKeyword IS NULL OR INSTR(UPPER(p.Name),UPPER(:menuKeyword))>0)
      ORDER BY r.Code,p.Id,ur.Id,rp.Id`;
    filters = ["仅菜单/角色分配，不证明业务数据范围", "关键词按字面子串匹配"];
  } else if (name === "position_certificates") {
    const target = String(p.employeeNo ?? actor);
    authorization = await authorizeCertificates(db, owner, actor, target);
    if (authorization.status !== "authorized") return { authorization };
    binds.target = target; binds.permission = "shanggangzhengchaxun"; binds.keyword = String(p.keyword ?? "");
    binds.jobId = Number(p.jobId ?? 0); binds.kind = String(p.kind ?? "all");
    // 在业务SELECT内再次绑定请求者授权，不能依靠模型参数或先读再过滤。
    const gate = `(:actor=:target OR EXISTS (SELECT 1 FROM ${owner}.S2_AppMyMenu am WHERE am.EmpCode=:actor AND INSTR(am.MenuCodes,:permission)>0))`;
    sql = `SELECT * FROM (
      SELECT 'technical' AS KIND,t.Id AS RECORD_ID,t.EmpCode AS EMP_CODE,t.JobId AS JOB_ID,j.JobName AS JOB_NAME,t.CertBeginDate AS CERT_BEGIN_DATE,t.CertEndDate AS CERT_END_DATE
      FROM ${owner}.S2_E_TechnicalJobEmp t JOIN ${owner}.S2_E_TechnicalJob j ON j.Id=t.JobId
      WHERE t.EmpCode=:target AND t.State=1 AND t.IsDisabled=0 AND j.IsDisabled=0 AND ${gate}
      AND (:kind='all' OR :kind='technical') AND (:jobId=0 OR t.JobId=:jobId)
      UNION ALL
      SELECT 'general',t.Id,t.EmpCode,t.GeneralJobId,t.JobName,t.CertBeginDate,t.CertEndDate
      FROM ${owner}.S2_GeneralJobApply t JOIN ${owner}.S2_Employee e ON e.Code=t.EmpCode
      LEFT JOIN ${owner}.S2_E_Paper ep ON ep.Id=t.PaperId
      WHERE t.EmpCode=:target AND t.State=2 AND t.IsDisabled=0 AND ${gate} AND (:kind='all' OR :kind='general')
      AND (:jobId=0 OR t.GeneralJobId=:jobId))
      WHERE (:keyword IS NULL OR INSTR(UPPER(JOB_NAME),UPPER(:keyword))>0) ORDER BY KIND,RECORD_ID`;
    filters = ["来源：Elearning/GetCertInfo只读证书投影；不是后台管理/申请列表", "重点State=1且记录/岗位均未禁用；一般State=2且记录未禁用并关联Employee", "未添加当前日期有效期条件；空结果不证明所有岗位记录不存在", "jobId对各kind独立筛选，建议同时指定kind；不生成证书图片、不写查询日志"];
  } else if (name === "self_book_dinners_today") {
    sql = `SELECT Id,EmpCode,DinnerType,Location,NeedTime,BookStatus,Qty FROM ${owner}.S2_BookDinner
      WHERE EmpCode=:actor AND BookStatus<>2 AND NeedTime>=TRUNC(CAST(SYSTIMESTAMP AT TIME ZONE 'Asia/Shanghai' AS DATE))
      AND NeedTime<TRUNC(CAST(SYSTIMESTAMP AT TIME ZONE 'Asia/Shanghai' AS DATE))+1 ORDER BY NeedTime,Id`;
    filters = ["BookDinnerApi.GetComplitInfo本人分支；上海时区当天、未取消的客人订餐", "不覆盖其他报餐系统、他人记录或历史数据"];
  } else if (name === "dorm_room_residents") {
    const company = String(p.companyCode);
    authorization = await authorizeDormitory(db, owner, actor, company);
    if (authorization.status !== "authorized") return { authorization };
    binds.company = company; binds.roomId = Number(p.roomId);
    sql = `SELECT d.Id AS RECORD_ID,d.EmpCode,d.EmpName,c.CompanyCode,c.BuildNo,b.Id AS ROOM_ID,b.RoomNo,a.BedNo
      FROM ${owner}.S2_R_RoomDetail a JOIN ${owner}.S2_R_Room b ON b.Id=a.RoomId
      JOIN ${owner}.S2_R_Building c ON c.Id=b.BId JOIN ${owner}.S2_Company e ON e.Code=c.CompanyCode
      JOIN ${owner}.S2_R_RegAccom d ON d.RId=a.Id AND d.OutEmpCode IS NULL
      WHERE b.Id=:roomId AND c.CompanyCode=:company AND b.IsDisabled=0 AND c.IsDisabled=0 AND b.IsLocked=0
      AND EXISTS (SELECT 1 FROM ${owner}.S2_R_DataPermission dp WHERE dp.EmpCode=:actor AND dp.CompanyCode=c.CompanyCode AND BITAND(dp.PowerTypes,1)=1)
      ORDER BY a.BedNo,d.Id`;
    filters = ["Dorm/GetDormitory的在住人员投影；指定厂区/房间，仅显式DormAdmin范围", "未禁用、未锁定房间；OutEmpCode为空；不展示空床或跨库班次"];
  }
  else throw new Error("unsupported query");
  const result = await db.execute(`SELECT * FROM (${sql}) OFFSET :offset ROWS FETCH NEXT :take ROWS ONLY`, binds);
  return { authorization, result, filters };
}
