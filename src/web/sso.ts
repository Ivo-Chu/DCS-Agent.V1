export type LoginCheck = {status:"valid";employeeNo:string} | {status:"invalid"|"unavailable"};
export interface LoginAuthority { verify(code:string, signal?:AbortSignal):Promise<LoginCheck>; }
/** Reuse DCS WebApi Account/CheckSSOCode; no Session inspection or logout tracking. */
export function createLoginAuthority(url=process.env.DCS_SSO_CHECK_URL ?? "http://localhost:19999/api/Account/CheckSSOCode", timeoutMs=Number(process.env.DCS_SSO_TIMEOUT_MS ?? 10000)):LoginAuthority {
 return {async verify(code,signal){
  const controller=new AbortController(),abort=()=>controller.abort();
  const timer=setTimeout(abort,Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:10000);
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  try{
   const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({Code:code}),signal:controller.signal});
   if(!response.ok)return {status:"unavailable"};
   const data=await response.json() as any;
   if(data?.IsSuccess===false)return {status:"invalid"};
   const employee=data?.Data?.EmpCode;
   return data?.IsSuccess===true&&typeof employee==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(employee)?{status:"valid",employeeNo:employee.toUpperCase()}:{status:"unavailable"};
  }catch{return {status:"unavailable"};}
  finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
 }};
}
