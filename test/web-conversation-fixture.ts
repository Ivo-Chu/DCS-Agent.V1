/** Test-only migration helpers. Production still REQUIRES explicit conversationId and trusted login scope. */
import type { LoginAuthority } from "../src/web/sso.ts";
export function fixtureAuthority(resolve:(code:string)=>Promise<string|null>):LoginAuthority {
 return {verify:async(code)=>{const employeeNo=await resolve(code);return employeeNo?{status:"valid",employeeNo}:{status:"invalid"};}};
}
const ids=new Map<string,string>();
export async function conversationFetch(input:string|URL|Request,init?:RequestInit):Promise<Response> {
  const url=String(input),route=new URL(url).pathname,headers=new Headers(init?.headers),token=headers.get("Authorization")??"";
  if(token&&["/api/chat","/api/ui-action/result"].includes(route)){
    if(!ids.has(token)){
      const base=new URL(url).origin;
      const listed=await (await globalThis.fetch(base+"/api/conversations",{headers})).json() as any;
      let id=listed.recentConversationId??listed.conversations?.[0]?.id;
      if(!id){const created=await (await globalThis.fetch(base+"/api/conversations",{method:"POST",headers,body:"{}"})).json() as any;id=created.conversation?.id;}
      if(id)ids.set(token,id);
    }
    const b=JSON.parse(String(init?.body??"{}"));init={...init,body:JSON.stringify({...b,conversationId:ids.get(token)})};
  }
  if(route==="/api/conversations"&&init?.method==="POST")init={...init,body:init.body??"{}"};
  const response=await globalThis.fetch(input,init);
  if(route==="/api/conversations"&&init?.method==="POST"&&response.ok){const c=await response.clone().json() as any;ids.set(token,c.conversation.id);}
  return response;
}
