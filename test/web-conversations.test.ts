import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";import path from "node:path";import type {AddressInfo} from "node:net";
import { createWebServer, type AgentLike, type WebServerDeps } from "../src/web/server.ts";
import { ConversationStore, validContext } from "../src/web/conversation-store.ts";
import type { LoginCheck, LoginAuthority } from "../src/web/sso.ts";
import type {AgentEvent} from "../src/core/events.ts";import type {AgentMessage} from "../src/core/types.ts";
import {createNavigateDcsMenuTool,parseNavigationResult} from "../src/dcs/navigation-tool.ts";
const aid="a".repeat(32),bid="b".repeat(32),cid="c".repeat(32);
function authority(){
 const states=new Map<string,"valid"|"invalid"|"unavailable">([[aid,"valid"],[bid,"valid"],[cid,"valid"]]);
 const status=async(id:string):Promise<LoginCheck>=>states.get(id)==="valid"?{status:"valid",employeeNo:id===cid?"B":"A"}:{status:states.get(id)==="unavailable"?"unavailable":"invalid"};
 return {states,verify:status} satisfies LoginAuthority&{states:typeof states};
}
class Fake implements AgentLike {
 context:AgentMessage[]=[];listeners=new Set<(e:AgentEvent)=>void>();
 constructor(private slow?:Promise<void>){}
 subscribe(fn:(e:AgentEvent)=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 emit(e:AgentEvent){this.listeners.forEach(fn=>fn(e));}
 async prompt(q:string){
  this.emit({type:"run_start",runId:"fixture",startedAt:new Date().toISOString()});
  const answer=`${this.context.filter(m=>m.role==="user").map(m=>m.content).join("|")}->${q}`;
  this.emit({type:"message_delta",text:answer});
  if(this.slow)await this.slow;
  this.context.push({role:"user",content:q},{role:"assistant",content:answer,stopReason:"stop"});
  this.emit({type:"run_end",runId:"fixture",status:"completed",reason:"completed",elapsedMs:1,modelCalls:1,toolCalls:0});return answer;
 }
}
async function setup(overrides:WebServerDeps={},auth=authority()){
 const dir=mkdtempSync(path.join(os.tmpdir(),"dcs-conversations-"));
 const server=createWebServer({authority:auth,dataFile:path.join(dir,"state.sqlite"),logsDir:dir,logger:()=>{},resolveIdentity:async employeeNo=>({employeeNo,name:"fixture"}),createAgent:()=>new Fake(),...overrides});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const request=(route:string,token="",method="GET",data?:unknown)=>fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const login=async(id=aid)=>(await (await request("/api/session/sso","","POST",{code:id})).json() as any).token as string;
 const create=async(token:string)=>(await(await request("/api/conversations",token,"POST",{})).json() as any).conversation.id as string;
 const get=async(token:string,id:string)=>(await(await request(`/api/conversation?conversationId=${id}`,token)).json() as any).conversation;
 const chat=(token:string,id:string,q:string)=>request("/api/chat",token,"POST",{conversationId:id,question:q});
 const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await new Promise(r=>setImmediate(r));};
 return {dir,server,auth,request,login,create,get,chat,close,base};
}
test("SQLite checkpoint restores independent A/B conversations after server restart; history never executes Tools",async()=>{
 const auth=authority();let calls=0;const a=await setup({createAgent:()=>{calls++;return new Fake();}},auth);
 const file=path.join(a.dir,"state.sqlite");let b:Awaited<ReturnType<typeof setup>>|undefined;
 try{
  const token=await a.login(),x=await a.create(token),y=await a.create(token);
  assert.match(await(await a.chat(token,x,"alpha")).text(),/final/);assert.match(await(await a.chat(token,y,"beta")).text(),/final/);
  assert.match(await(await a.chat(token,x,"again")).text(),/alpha->again/);
  assert.equal((await a.get(token,y)).messages[1].content,"->beta");
  const token2=await a.login();assert.equal((await a.get(token2,x)).messages.length,4);
  await a.close();
  b=await setup({dataFile:file,createAgent:()=>{calls++;return new Fake();}},auth);
  assert.equal((await b.request("/api/conversations",token)).status,401);
  const fresh=await b.login(),before=calls;
  assert.equal((await b.get(fresh,x)).messages.length,4);assert.equal(calls,before);
  assert.match(await(await b.chat(fresh,x,"restart")).text(),/alpha\|again->restart/);
  assert.equal((await b.request("/api/conversation",fresh,"DELETE",{conversationId:x})).status,200);
  assert.equal((await b.request(`/api/conversation?conversationId=${x}`,fresh)).status,404);
  assert.equal((await b.get(fresh,y)).messages[1].content,"->beta");
 }finally{if(b)await b.close();else await a.close();rmSync(a.dir,{recursive:true,force:true});if(b)rmSync(b.dir,{recursive:true,force:true});}
});



test("stop saves partial display, rolls context back; delete then late completion cannot recreate conversation",async()=>{
 let release!:()=>void;const slow=new Promise<void>(r=>release=r);let count=0;const s=await setup({createAgent:()=>new Fake(++count===1?slow:undefined)});
 try{
  const token=await s.login(),id=await s.create(token);const response=await s.chat(token,id,"unfinished");await response.body!.getReader().read();
  assert.equal((await s.request("/api/chat/stop",token,"POST",{conversationId:id})).status,200);
  const c=await s.get(token,id);assert.match(c.messages.at(-1).content,/停止/);
  assert.match(await(await s.chat(token,id,"next")).text(),/->next/);
  const db=new ConversationStore(path.join(s.dir,"state.sqlite"));assert.equal(db.get(db.find("A")!,id)?.context[0].content,"next");db.close();
  await s.request("/api/conversation",token,"DELETE",{conversationId:id});release();await new Promise(r=>setTimeout(r,25));
  assert.equal((await s.request(`/api/conversation?conversationId=${id}`,token)).status,404);
 }finally{release();await s.close();rmSync(s.dir,{recursive:true,force:true});}
});
test("SQLite restart marks unfinished run, keeps last complete checkpoint, rejects orphan tool results and resurrection",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"dcs-store-")),file=path.join(dir,"test.sqlite");
 try{let db=new ConversationStore(file);db.bind(aid,"A");const c=db.create(aid);db.begin(c,"one","question");c.messages.push({id:"partial",role:"assistant",content:"partial"});db.save(c,"one");db.close();
  db=new ConversationStore(file);const recovered=db.get(aid,c.id)!;assert.equal(recovered.runId,null);assert.match(recovered.messages.at(-1)!.content,/重启/);assert.deepEqual(recovered.context,[]);
  db.delete(aid,c.id);assert.equal(db.finish(c,"one",false),false);db.revoke(aid);assert.equal(db.bind(aid,"A"),false);db.close();
  assert.equal(validContext([{role:"assistant",content:"",stopReason:"toolCalls",toolCalls:[{id:"t",name:"x",arguments:"{}"}]}]),false);
  assert.equal(validContext([{role:"toolResult",toolCallId:"t",toolName:"x",content:"",isError:false}]),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("navigation selection is not failure; contradictory status is rejected",async()=>{
 const result={ok:false,status:"needs_selection" as const,message:"请选择",candidates:[{title:"查询",path:"部门 / 查询"}]};
 assert.deepEqual(parseNavigationResult(result),result);assert.equal(parseNavigationResult({...result,ok:true}),null);
 const tool=createNavigateDcsMenuTool(async()=>result);
 const output=await tool.execute({menuName:"查询"},{session:{user:{source:"web",userId:"A",employeeNo:"A",name:"A",roles:[],authMethod:"dcs_sso"}}});
 assert.equal(output.isError,false);assert.equal(JSON.parse(output.output).status,"needs_selection");
});

test("save failure emits no final success and retains the previous checkpoint",async()=>{
 const db=new ConversationStore(":memory:");const original=db.finish.bind(db);
 db.finish=(c,r,complete)=>{if(complete)throw new Error("simulated disk full");return original(c,r,false);};
 const s=await setup({store:db});try{const token=await s.login(),id=await s.create(token);const output=await(await s.chat(token,id,"write failure")).text();assert.doesNotMatch(output,/"type":"final"/);assert.match(output,/保存失败/);assert.deepEqual(db.get(db.find("A")!,id)?.context,[]);assert.match(db.get(db.find("A")!,id)!.messages.at(-1)!.content,/保存失败/);}finally{await s.close();db.close();rmSync(s.dir,{recursive:true,force:true});}
});

test("question persistence failure prevents model execution and reports explicit save error",async()=>{
 const db=new ConversationStore(":memory:");db.begin=()=>{throw new Error("disk full");};let calls=0;
 const s=await setup({store:db,createAgent:()=>({subscribe:()=>()=>{},prompt:async()=>{calls++;return "bad";}})});
 try{const token=await s.login(),id=await s.create(token);const output=await(await s.chat(token,id,"not persisted")).text();assert.match(output,/save_failed/);assert.doesNotMatch(output,/"type":"final"/);assert.equal(calls,0);assert.deepEqual(db.get(db.find("A")!,id)?.messages,[]);}finally{await s.close();db.close();rmSync(s.dir,{recursive:true,force:true});}
});






const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test("local expiry clears all conversations and logs without any client request; another user remains",async()=>{
 const s=await setup({idleMs:350});try{
  const a=await s.login(),a2=await s.login(bid),id=await s.create(a),second=await s.create(a2);
  await(await s.chat(a,id,"private")).text();
  const db=new ConversationStore(path.join(s.dir,"state.sqlite")),scope=db.find("A")!;
  assert.equal((await s.get(a2,id)).id,id); // same verified employee resumes the local scope
  const other=await s.login(cid),keep=await s.create(other);
  await delay(220);assert.equal((await s.request("/api/conversations",other)).status,200);
  await delay(220);
  assert.equal(db.get(scope,id),null);assert.equal(db.get(scope,second),null);assert.equal(db.active(scope),false);
  assert.equal(readdirSync(s.dir,{recursive:true}).map(String).filter(f=>f.endsWith(".jsonl")).length,0);
  for(const token of [a,a2])assert.equal((await s.request("/api/conversations",token)).status,401);
  assert.ok(await s.get(other,keep));assert.equal((await s.request('/api/conversation?conversationId='+keep,await s.login())).status,404);
  const fresh=await s.login();assert.deepEqual((await(await s.request("/api/conversations",fresh)).json() as any).conversations,[]);db.close();
 }finally{await s.close();rmSync(s.dir,{recursive:true,force:true});}
});
test("active generation outlives idle deadline; a full idle period starts when it ends",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const s=await setup({idleMs:160,createAgent:()=>new Fake(gate)});
 try{const token=await s.login(),id=await s.create(token),response=await s.chat(token,id,"slow");
 const output=response.text();await delay(250);release();assert.match(await output,/final/);
 const db=new ConversationStore(path.join(s.dir,"state.sqlite"));assert.ok(db.get(db.find("A")!,id));await delay(220);assert.equal(db.find("A"),undefined);db.close();
 }finally{release();await s.close();rmSync(s.dir,{recursive:true,force:true});}
});
test("restart cleans locally expired scope without calling SSO",async()=>{
 const a=await setup({idleMs:120});let b:Awaited<ReturnType<typeof setup>>|undefined;
 try{const token=await a.login(),id=await a.create(token),file=path.join(a.dir,"state.sqlite");await a.close();await delay(180);
 let checks=0;b=await setup({dataFile:file,idleMs:120,authority:{verify:async()=>{checks++;return {status:"valid",employeeNo:"A"};}}});
 await delay(25);assert.equal(checks,0);const db=new ConversationStore(file);assert.equal(db.find("A"),undefined);assert.equal(db.logins().length,0);db.close();
 assert.ok(await b.login());
 }finally{if(b){await b.close();rmSync(b.dir,{recursive:true,force:true});}else await a.close();rmSync(a.dir,{recursive:true,force:true});}
});
test("activity extends the local expiry",async()=>{
 const s=await setup({idleMs:220});try{const token=await s.login(),id=await s.create(token);await delay(140);assert.ok(await s.get(token,id));await delay(140);assert.equal((await s.request("/api/conversations",token)).status,200);await delay(280);assert.equal((await s.request("/api/conversations",token)).status,401);}
 finally{await s.close();rmSync(s.dir,{recursive:true,force:true});}
});

test("tool progress and structured menu choices stream and survive conversation reload",async()=>{
 const candidates=[{title:"通讯录",path:"人资 / 通讯录"},{title:"通讯录",path:"行政 / 通讯录"}];
 const s=await setup({createAgent:(identity,_holder,_auth,nav)=>{
  const fake=new Fake();
  fake.prompt=async q=>{
   const event={runId:"test",toolCallId:"same",toolName:"navigate_dcs_menu",turn:1,step:1};
   fake.emit({type:"message_delta",text:"正在查找菜单"});
   fake.emit({type:"tool_execution_start",...event,args:{menuName:q}});
   await nav(identity.employeeNo,q);
   fake.emit({type:"tool_execution_end",...event,isError:false,summary:"choice",durationMs:1});
   fake.context.push({role:"user",content:q},{role:"assistant",content:"请选择",stopReason:"stop"});
   return "请选择";
  };return fake;
 }});
 try {
  const token=await s.login(),id=await s.create(token);
  for(let i=0;i<2;i++){
   const response=await s.chat(token,id,"通讯录"),reader=response.body!.getReader();
   let buffer="",end:any;
   while(true){const part=await reader.read();if(part.done)break;buffer+=new TextDecoder().decode(part.value);
    let n;while((n=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,n);buffer=buffer.slice(n+2);const e=JSON.parse(frame.slice(6));
     if(e.type==="ui_action")assert.equal((await s.request("/api/ui-action/result",token,"POST",{conversationId:id,requestId:e.requestId,result:{ok:false,status:"needs_selection",message:"请选择",candidates}})).status,200);
     if(e.type==="tool_step"&&e.status==="end")end=e;
    }
   }
   assert.deepEqual(end.candidates,candidates);assert.equal(end.messageId,"1");
  }
  const c=await s.get(token,id);assert.equal(c.tools.length,2);
  for(const tool of c.tools){assert.equal(tool.status,"selection");assert.deepEqual(tool.candidates,candidates);assert.ok(c.messages.some((m:any)=>m.id===tool.messageId));}
  assert.notEqual(c.tools[0].messageId,c.tools[1].messageId);
  assert.equal(c.messages.filter((m:any)=>m.kind==="process").length,2);
  assert.equal(c.messages.filter((m:any)=>m.kind==="selection").length,2);
  assert.ok(c.messages.every((m:any)=>!m.id.endsWith(":process")));
  const db=new ConversationStore(path.join(s.dir,"state.sqlite"));assert.deepEqual(db.get(db.find("A")!,id)!.tools,c.tools);db.close();
 }finally{await s.close();rmSync(s.dir,{recursive:true,force:true});}
});

test("real Agent loop separates two tool preambles from final answer without changing context",async()=>{
 const {Agent}=await import('../src/core/agent.ts');
 const s=await setup({createAgent:()=>{
  let turn=0;
  return new Agent({systemPrompt:'fixture',toolContext:{},tools:[{name:'lookup',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>({output:'found'})}],streamFn:async function*(){
   turn++;yield {type:'text_delta',text:turn===1?'先查询':turn===2?'继续查询':'最终答案'};
   if(turn<3){yield {type:'tool_call_start',index:0,toolCallId:'t'+turn,name:'lookup'};yield {type:'tool_call_delta',index:0,argumentsDelta:'{}'};yield {type:'message_end',stopReason:'toolCalls'};}
   else yield {type:'message_end',stopReason:'stop'};
  }});
 }});
 try {
  const token=await s.login(),id=await s.create(token);
  const stream=await(await s.chat(token,id,'question')).text();
  const events=stream.split('\n\n').filter(Boolean).map(line=>JSON.parse(line.slice(6)));
  assert.ok(events.some(e=>e.type==='message_kind'&&e.messageId==='1'&&e.kind==='process'));
  assert.ok(events.some(e=>e.type==='message_kind'&&e.messageId==='2'&&e.kind==='process'));
  assert.equal(events.find(e=>e.type==='final').kind,'answer');
  const c=await s.get(token,id);
  assert.deepEqual(c.messages.filter((m:any)=>m.role==='assistant').map((m:any)=>[m.content,m.kind]),[['先查询','process'],['继续查询','process'],['最终答案','answer']]);
  assert.equal(c.tools.length,2);
  const db=new ConversationStore(path.join(s.dir,'state.sqlite'));
  assert.equal(db.get(db.find('A')!,id)!.context.filter(m=>m.role==='toolResult').length,2);db.close();
 }finally{await s.close();rmSync(s.dir,{recursive:true,force:true});}
});
test("checkpoints follow completed messages/tools, not elapsed time or streaming deltas",async()=>{
 const db=new ConversationStore(":memory:");
 let release!:()=>void;
 const gate=new Promise<void>(r=>release=r),fake=new Fake(gate);
 const s=await setup({store:db,createAgent:()=>fake});
 try{
  const token=await s.login(),id=await s.create(token);
  const response=await s.chat(token,id,"checkpoint"),output=response.text();
  const login=db.find("A")!;
  assert.equal(db.get(login,id)!.messages.length,1);
  await delay(650);
  assert.equal(db.get(login,id)!.messages.length,1,"partial deltas must not be periodically saved");
  fake.emit({type:"assistant_message",message:{role:"assistant",content:"->checkpoint",stopReason:"toolCalls"}});
  assert.equal(db.get(login,id)!.messages[1].content,"->checkpoint");
  const event={runId:"fixture",toolCallId:"t",toolName:"lookup",turn:1,step:1};
  fake.emit({type:"tool_execution_start",...event,args:{}});
  assert.equal(db.get(login,id)!.tools.length,0);
  fake.emit({type:"tool_execution_end",...event,isError:false,summary:"found",durationMs:1});
  assert.equal(db.get(login,id)!.tools[0].status,"success");
  release();assert.match(await output,/"type":"final"/);
  assert.equal(db.get(login,id)!.runId,null);
  assert.equal(db.get(login,id)!.context.length,2);
 }finally{release();await s.close();db.close();rmSync(s.dir,{recursive:true,force:true});}
});

test("event checkpoint failure stops the run without reporting final success",async()=>{
 const db=new ConversationStore(":memory:");
 db.save=()=>{throw new Error("disk full");};
 let release!:()=>void;
 const gate=new Promise<void>(r=>release=r),fake=new Fake(gate);
 const s=await setup({store:db,createAgent:()=>fake});
 try{
  const token=await s.login(),id=await s.create(token);
  const response=await s.chat(token,id,"failure"),output=response.text();
  fake.emit({type:"assistant_message",message:{role:"assistant",content:"partial",stopReason:"stop"}});
  const events=await output;
  assert.match(events,/记录保存失败/);assert.doesNotMatch(events,/"type":"final"/);
  assert.equal(db.get(db.find("A")!,id)!.runId,null);
 }finally{release();await s.close();db.close();rmSync(s.dir,{recursive:true,force:true});}
});
test("a running conversation does not block viewing, creating or deleting other conversations",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const s=await setup({createAgent:()=>new Fake(gate)});
 try{
  const token=await s.login(),a=await s.create(token),b=await s.create(token);
  const response=await s.chat(token,a,"background"),output=response.text();
  assert.equal((await s.get(token,b)).id,b);
  const c=await s.create(token);assert.ok(c);assert.notEqual(c,a);
  assert.equal((await s.request("/api/conversation",token,"DELETE",{conversationId:b})).status,200);
  assert.equal((await s.request("/api/conversation",token,"DELETE",{conversationId:a})).status,409);
  assert.match(await(await s.chat(token,c,"second")).text(),/"type":"busy"/);
  assert.equal((await s.get(token,c)).messages.length,0);
  release();assert.match(await output,/"type":"final"/);
  assert.equal((await s.get(token,a)).messages[1].content,"->background");
  assert.equal((await s.get(token,c)).messages.length,0);
  assert.equal((await s.request("/api/conversation",token,"DELETE",{conversationId:a})).status,200);
 }finally{release();await s.close();rmSync(s.dir,{recursive:true,force:true});}
});