/** Isolated, opt-in transport diagnosis. No production tools or database execution. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadEnvLocal } from '../src/dcs/env-local.ts';
import { createOpenAiStreamFn } from '../src/core/model/openai-compatible.ts';
import { Agent } from '../src/core/agent.ts';
import type { StreamFn, ToolDefinition } from '../src/core/types.ts';
import { dcsTools } from '../src/dcs/tools.ts';
import { createNavigateDcsMenuTool } from '../src/dcs/navigation-tool.ts';

loadEnvLocal();
const endpoint = `${process.env.LLM_BASE_URL?.replace(/\/+$/, '')}/chat/completions`;
if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) throw new Error('Model configuration missing');
const realFetch = globalThis.fetch;
const out = path.resolve('data/harness-v1/diagnostics',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const watched=['src/core/model/openai-compatible.ts','src/core/agent-loop.ts','src/dcs/prompt.ts','src/dcs/source-tools.ts','src/dcs/tools.ts','src/dcs/agent-factory.ts'];
const before=Object.fromEntries(await Promise.all(watched.map(async p=>[p,hash(await fs.readFile(p))])));
const tool:ToolDefinition<any,unknown>={name:'lookup',label:'隔离测试查询',description:'按编号只读查询本地隔离测试记录，不访问数据库。',
 parameters:{type:'object',properties:{id:{type:'integer'}},required:['id'],additionalProperties:false},
 async execute(a){return {output:JSON.stringify(a?.id===17?{id:17,value:'local-diagnostic-record-17'}:{status:'not_found'})};}};
const basic={systemPrompt:'你是隔离测试助手。需要查询时使用只读工具，不能猜测记录内容。',messages:[{role:'user' as const,content:'请调用 lookup 工具查询编号 17，不要猜测查询结果。'}],tools:[tool]};

// Capture actual production serialization without sending a request or changing its implementation.
async function serialize(req:Parameters<StreamFn>[0]) {
 let body:any;
 globalThis.fetch=async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});};
 try {for await(const _ of createOpenAiStreamFn()(req)) { /* consume */ }} finally {globalThis.fetch=realFetch;}
 return body;
}

// Feed captured REAL bytes through the unchanged Provider and AgentLoop; tool is only the local fixture.
async function replay(raw:string,body:any) {
 const providerEvents:any[]=[];const agentEvents:any[]=[];let executions=0;
 globalThis.fetch=async()=>new Response(raw,{headers:{'Content-Type':'text/event-stream'}});
 try {
  const provider=createOpenAiStreamFn();
  for await(const e of provider(basic))providerEvents.push(e);
  const agent=new Agent({systemPrompt:basic.systemPrompt,tools:[{...tool,async execute(a:any,c:unknown){executions++;return tool.execute(a,c);}}],
   streamFn:createOpenAiStreamFn(),toolContext:{},maxTurns:1});
  agent.subscribe(e=>agentEvents.push(e));await agent.prompt(basic.messages[0].content);
 } finally {globalThis.fetch=realFetch;}
 return {note:'Offline replay of real response, maxTurns=1 tests execution only; not a second model run',providerEvents,
  parsedByLoop:agentEvents.filter(e=>e.type==='model_call_end').map(e=>e.output),toolExecutions:executions,
  actualToolResults:agentEvents.filter(e=>e.type==='tool_execution_end'),requestChoice:body.tool_choice};
}

const summaries:any[]=[];
async function measure(id:string,body:any,replayLookup=false) {
 const started=performance.now(),timing:any={headersMs:null,firstByteMs:null,firstSseDataMs:null,firstReasoningMs:null,firstEffectiveMs:null,finishFrameMs:null,endMs:null};
 const frames:any[]=[],chunks:any[]=[];let raw='',pending='',content='',reasoningChars=0,usage:any=null,status:number|null=null,finish:any=null,serviceError:any=null;
 let responseModel:any=null,responseId:any=null,systemFingerprint:any=null;const calls=new Map<number,any>();const deltaKeys=new Set<string>();let malformedFrames=0;
 const now=()=>Math.round((performance.now()-started)*100)/100;
 const consume=(data:string,ms:number)=>{
  if(timing.firstSseDataMs===null)timing.firstSseDataMs=ms;
  frames.push({ms,data});if(!data||data==='[DONE]')return;
  let j:any;try{j=JSON.parse(data);}catch{malformedFrames++;return;}
  serviceError=j.error??serviceError;
  responseModel=j.model??responseModel;responseId=j.id??responseId;systemFingerprint=j.system_fingerprint??systemFingerprint;usage=j.usage??usage;
  const choice=j.choices?.[0],d=choice?.delta??choice?.message??{};
  Object.keys(d).forEach(k=>deltaKeys.add(k));
  if(d.reasoning||d.reasoning_content){timing.firstReasoningMs??=ms;reasoningChars+=String(d.reasoning||d.reasoning_content).length;}
  if(d.content||d.tool_calls?.length||d.function_call)timing.firstEffectiveMs??=ms;
  content+=d.content||'';
  for(const t of d.tool_calls||[]){const n=t.index??0;const call=calls.get(n)??{id:'',type:t.type??'function',function:{name:'',arguments:''}};
   if(t.id)call.id=t.id;if(t.function?.name)call.function.name+=t.function.name;if(t.function?.arguments)call.function.arguments+=t.function.arguments;calls.set(n,call);}
  if(choice?.finish_reason){finish=choice.finish_reason;timing.finishFrameMs=ms;}
 };
 await fs.writeFile(path.join(out,`${id}.request.json`),JSON.stringify(body,null,2));
 let error:any=null,headers:any={};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),150000);
 try {
  const response=await realFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.LLM_API_KEY}`},body:JSON.stringify(body),signal:controller.signal});
  timing.headersMs=now();status=response.status;
  for(const key of ['content-type','server','date','x-request-id','x-accel-buffering','transfer-encoding','content-length','via'])if(response.headers.has(key))headers[key]=response.headers.get(key);
  const decoder=new TextDecoder();
  for await(const chunk of response.body as AsyncIterable<Uint8Array>){const ms=now();timing.firstByteMs??=ms;chunks.push({ms,bytes:chunk.length});const text=decoder.decode(chunk,{stream:true});raw+=text;
   if(body.stream&&response.ok){pending+=text;let boundary:number;while((boundary=pending.search(/\r?\n\r?\n/))>=0){const block=pending.slice(0,boundary);pending=pending.slice(boundary+(pending[boundary]==='\r'?4:2));const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)consume(data,ms);}}
  }
  raw+=decoder.decode();
  if(!body.stream&&response.ok){consume(raw,now());timing.firstSseDataMs=null;}
  if(body.stream&&pending.trim())frames.push({ms:now(),unterminated:pending});
 } catch(e:any){error={name:e.name,message:e.message,cause:e.cause?.code};}
 finally {clearTimeout(timer);timing.endMs=now();}
 const values=[...calls.values()];const outputTokens=usage?.completion_tokens??null;
 const result={id,status,headers,timing,finish,responseModel,responseId,systemFingerprint,usage,content,reasoningChars,deltaKeys:[...deltaKeys],rawToolCalls:values,malformedFrames,error,serviceError,
  inputBytes:Buffer.byteLength(JSON.stringify(body)),outputBytes:Buffer.byteLength(raw),chunkCount:chunks.length,frameCount:frames.length,
  outputTokensPerWallSecond:outputTokens===null?null:outputTokens/(timing.endMs/1000),
  outputTokensPerObservedStreamSecond:body.stream&&outputTokens!==null&&timing.firstEffectiveMs!==null&&timing.endMs>timing.firstEffectiveMs?outputTokens/((timing.endMs-timing.firstEffectiveMs)/1000):null,
  speedNote:'Client-observed rates, not server decode speed; buffering/reasoning may distort stream rate.',
  frames,chunks};
 await fs.writeFile(path.join(out,`${id}.response.txt`),raw);
 await fs.writeFile(path.join(out,`${id}.detail.json`),JSON.stringify(result,null,2));
 let parsed:any=null;if(body.stream&&status===200&&replayLookup){parsed=await replay(raw,body);await fs.writeFile(path.join(out,`${id}.replay.json`),JSON.stringify(parsed,null,2));}
 const summary={id,status,timing,finish,responseModel,usage,reasoningChars,deltaKeys:[...deltaKeys],rawToolCalls:values,error,serviceError,malformedFrames,
  inputBytes:result.inputBytes,outputBytes:result.outputBytes,chunkCount:result.chunkCount,outputTokensPerWallSecond:result.outputTokensPerWallSecond,
  providerToolStarts:parsed?.providerEvents.filter((e:any)=>e.type==='tool_call_start').length??null,loopExecutions:parsed?.toolExecutions??null};
 summaries.push(summary);await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summaries,null,2));
 console.log(JSON.stringify(summary));return result;
}

const body=await serialize(basic);
const mode=process.argv[2]??'matrix';
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({mode,startedAt:new Date().toISOString(),endpoint,model:process.env.LLM_MODEL,productionHashes:before,productionSerializedRequest:body,timeoutMs:150000,note:'Only synthetic lookup executes. Raw request bodies omit Authorization header. No production Tool, identity or database calls.'},null,2));
console.log(JSON.stringify({out,mode}));
if(mode==='schema-required'||mode==='schema-required-original') {
 const tools=[...dcsTools,createNavigateDcsMenuTool(async()=>{throw new Error('Must not execute navigation');})];
 const original=JSON.stringify(tools.map(t=>t.parameters));
 const request=await serialize({systemPrompt:'这是隔离的工具选择测试。只生成工具调用，不编造查询结果。',messages:[{role:'user',content:'请使用 inspect_dcs_schema 搜索名称包含 SYNTHETIC_SCHEMA_PROBE 的表结构。'}],tools});
 if(mode==='schema-required-original')request.tools.forEach((t:any,i:number)=>{t.function.parameters=tools[i].parameters;});
 for(let repeat=1;repeat<=(mode==='schema-required-original'?1:2);repeat++)await measure(`r${repeat}-full-tools-required`,{...request,tool_choice:'required'});
 if(original!==JSON.stringify(tools.map(t=>t.parameters)))throw new Error('Original schemas mutated');
 await fs.writeFile(path.join(out,'schema-audit.json'),JSON.stringify({tools:tools.map(t=>({name:t.name,parameters:t.parameters})),originalSchemasUnchanged:true},null,2));
} else if(mode==='matrix') {
 const conditions=[['auto',true],['required',true],['forced',true],['auto',false],['required',false],['forced',false]] as const;
 for(let repeat=1;repeat<=2;repeat++)for(const [choice,stream] of repeat===1?conditions:[...conditions].reverse()){
  const request={...body,stream,tool_choice:choice==='forced'?{type:'function',function:{name:'lookup'}}:choice};
  if(!stream)delete request.stream_options;
  await measure(`r${repeat}-${choice}-${stream?'stream':'json'}`,request,true);
 }
} else if(mode==='recheck') {
 for(const [i,choice] of ['auto','required','auto'].entries())await measure(`r${i+1}-${choice}-stream`,{...body,tool_choice:choice},true);
} else if(mode==='trace-pair'||mode==='trace-required'||mode==='trace-cross') {
 const base='data/harness-v1/runs/2026-10-28T01-24-23-947Z';const metrics=JSON.parse(await fs.readFile(path.join(base,'metrics.json'),'utf8'));
 for(let repeat=1;repeat<=2;repeat++)for(const variant of mode==='trace-required'?['C']:(repeat===1?['A','C']:['C','A'])){
  const r=metrics.find((r:any)=>r.id===`contacts-${variant}-1`);const trace=(await fs.readdir(path.join(base,'traces'))).find(f=>f.includes(r.runId))!;
  const events=(await fs.readFile(path.join(base,'traces',trace),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  const start=events.find((e:any)=>e.event==='model_call_start');
  let schemas=start.toolSchemas;
  if(mode==='trace-cross') {
   const other=metrics.find((x:any)=>x.id===`contacts-${variant==='A'?'C':'A'}-1`);
   const otherFile=(await fs.readdir(path.join(base,'traces'))).find(f=>f.includes(other.runId))!;
   const otherEvents=(await fs.readFile(path.join(base,'traces',otherFile),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
   schemas=otherEvents.find((e:any)=>e.event==='model_call_start').toolSchemas;
  }
  const request=await serialize({systemPrompt:start.systemPromptText,messages:start.contextMessages,tools:schemas});
  if(mode==='trace-required')request.tool_choice='required';
  await measure(`r${repeat}-${variant}-first-call`,request);
 }
} else if(mode==='old-preflight') {
 const request={...body,messages:[{role:'user',content:'请调用 lookup 工具查询编号 17，不要猜测查询结果。'}],tools:[{type:'function',function:{name:'lookup',description:'按编号查询测试记录',parameters:{type:'object',properties:{id:{type:'integer'}},required:['id']}}}]};
 for(const thinking of [false,true]){
  const first=await measure(`thinking-${thinking}`,{...request,chat_template_kwargs:{enable_thinking:thinking}},true);
  const call=first.rawToolCalls[0];
  if(first.rawToolCalls.length===1&&call.function.name==='lookup'&&JSON.parse(call.function.arguments).id===17){
   await measure(`thinking-${thinking}-roundtrip`,{...request,chat_template_kwargs:{enable_thinking:thinking},messages:[...request.messages,{role:'assistant',content:first.content||null,tool_calls:first.rawToolCalls},{role:'tool',tool_call_id:call.id,content:JSON.stringify({id:17,status:'verified',label:'实验记录'})}]},true);
  }
 }
} else throw new Error('Unknown diagnostic mode');
const after=Object.fromEntries(await Promise.all(watched.map(async p=>[p,hash(await fs.readFile(p))])));
await fs.writeFile(path.join(out,'integrity.json'),JSON.stringify({productionUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after},null,2));
