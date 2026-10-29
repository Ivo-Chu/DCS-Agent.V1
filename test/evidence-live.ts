/** Three opt-in real-model smoke runs; only readonly source Tools are registered. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Agent } from '../src/core/agent.ts';
import type { AgentEvent } from '../src/core/events.ts';
import { createOpenAiStreamFn } from '../src/core/model/openai-compatible.ts';
import { loadEnvLocal } from '../src/dcs/env-local.ts';
import { createMockSession } from '../src/dcs/session.ts';
import { buildSystemPrompt } from '../src/dcs/prompt.ts';
import { prepareEvidenceRun } from '../src/dcs/evidence.ts';
import { searchDcsCodeTool, readDcsCodeTool } from '../src/dcs/source-tools.ts';
import { createDcsToolHooks } from '../src/dcs/hooks.ts';
import { DEFAULT_MAX_TURNS, createDcsAgent } from '../src/dcs/agent-factory.ts';
import { attachRunObserver } from '../src/observability/observer.ts';
import { classifyRun } from './acceptance-harness.ts';

loadEnvLocal();
if(!process.env.LLM_BASE_URL||!process.env.LLM_API_KEY||!process.env.DCS_SOURCE_ROOT)throw new Error('Model/source configuration missing');
await fs.realpath(process.env.DCS_SOURCE_ROOT);
const base='data/harness-v1';
const v2=process.argv.includes('--v2');
const selected=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
const naturalQuestions:Record<string,string>={contacts:'通讯录怎么查不到其他厂区的人？',jobs:'重点岗位和一般岗位分别有哪些查询条件？',dorm:'宿舍床位统计选到今天，今天的数据算进去吗？'};
const bytes=await fs.readFile(path.join(base,'cases.json'));
const allCases=JSON.parse(bytes.toString()).filter((c:any)=>['contacts','jobs','dorm'].includes(c.id));
if(allCases.length!==3)throw new Error('Expected three existing business cases');
const cases=allCases.filter((c:any)=>!selected||selected===c.id).map((c:any)=>({...c,question:v2?naturalQuestions[c.id]:c.question}));
if(!cases.length)throw new Error('Unknown --case');
const out=path.join(base,v2?'v2/runs':'evidence-runs',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const fingerprint=async()=>Promise.all(cases.flatMap((c:any)=>c.evidence).map(async(r:any)=>({path:r.path,sha256:sha(await fs.readFile(path.resolve(process.env.DCS_SOURCE_ROOT!,r.path)))})));
const before=await fingerprint();
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({model:process.env.LLM_MODEL,variant:v2?'V2-natural-Web-source-isolated':'V1-explicit-source',caseHash:sha(bytes),sourceFiles:before,maxTurns:DEFAULT_MAX_TURNS,budgetMs:120000,
  questions:cases.map((c:any)=>({id:c.id,question:c.question})),
  codeHashes:await Promise.all(['src/dcs/evidence.ts','src/dcs/agent-factory.ts','src/dcs/prompt.ts','src/dcs/source-tools.ts','src/dcs/source-map.ts','src/core/agent-loop.ts','src/core/model/openai-compatible.ts'].map(async p=>({path:p,sha256:sha(await fs.readFile(p))}))),
  isolation:v2?'Web factory; server restricts offered/executable tools to source search/read and fixed clarification. Mock identity, no production DB, knowledge, navigation or result-file execution. Expected facts never in model context.':'Only source tools registered; mock identity, no production DB/knowledge/navigation. Expected facts never in model context.'},null,2));
const results:any[]=[];
console.log(JSON.stringify({out}));
for(const c of cases){
 const holder={controller:new AbortController()},session=createMockSession();
 const tools=[searchDcsCodeTool,readDcsCodeTool];
 if(v2)session.user.source='web';
 const agent=v2?createDcsAgent({session,holder,allowedToolNames:['search_dcs_code','read_dcs_code','request_clarification']}):new Agent({systemPrompt:buildSystemPrompt(session)+'\n【隔离源码烟测】本次只提供只读源码工具，不可调用数据库、知识库或导航，不代表线上身份与数据验证。',
  tools,toolContext:{session,holder},hooks:createDcsToolHooks(),maxTurns:DEFAULT_MAX_TURNS,
  streamFn:createOpenAiStreamFn({signalProvider:()=>holder.controller.signal}),signalProvider:()=>holder.controller.signal,
  prepareRun:text=>prepareEvidenceRun(text,tools)});
 const events:AgentEvent[]=[];agent.subscribe(e=>events.push(e));
 const observer=attachRunObserver(agent,{channel:'evidence-source-smoke',logsDir:path.join(out,'traces'),write:null});
 let timedOut=false,error:unknown,answer='';const started=Date.now();
 const timer=setTimeout(()=>{timedOut=true;holder.controller.abort();},120000);
 try{answer=await agent.prompt(v2?c.question:'/查源码 '+c.question);}catch(e){error=e;}
 finally{clearTimeout(timer);await observer.end(timedOut?'timeout':'detached');observer.detach();}
 const result=classifyRun({id:c.id,conversationId:c.id,employeeCode:'10086',question:c.question,expectedFacts:c.expectedFacts,maxDurationMs:120000},
  {answer,events,timedOut,error,durationMs:Date.now()-started});
 const end=[...events].reverse().find(e=>e.type==='run_end');
 const modelCalls=events.filter(e=>e.type==='model_call_end');
 results.push({id:c.id,domain:c.domain,question:c.question,answer,status:result.status,timedOut,durationMs:result.durationMs,
  runId:end?.runId,reason:end?.reason,completionReason:end?.completionReason,policyState:end?.policyState,
  modelCalls:modelCalls.length,toolCalls:events.filter(e=>e.type==='tool_execution_end').length,
  modelDurationMs:modelCalls.reduce((n,e)=>n+e.durationMs,0),
  inputTokens:modelCalls.every(e=>e.usage?.inputTokens!==undefined)?modelCalls.reduce((n,e)=>n+e.usage!.inputTokens!,0):null,
  outputTokens:modelCalls.every(e=>e.usage?.outputTokens!==undefined)?modelCalls.reduce((n,e)=>n+e.usage!.outputTokens!,0):null,
  toolResults:events.filter(e=>e.type==='tool_execution_end').map(e=>({toolCallId:e.toolCallId,name:e.toolName,isError:e.isError,result:e.contextText})),
  unnecessaryInvestigation:'PENDING_TRACE_REVIEW',unnecessaryClarification:'PENDING_TRACE_REVIEW',pointCoverage:'PENDING_SOURCE_TRACE_REVIEW',
  discardedDrafts:modelCalls.filter(e=>e.draftDisposition==='discarded'&&e.output?.content).map(e=>({turn:e.turn,content:e.output!.content})),
  leakedTextDeltas:events.filter(e=>e.type==='message_delta').length,context:agent.context,
  sourceRelevance:'PENDING_SOURCE_TRACE_REVIEW',unsupportedClaims:'PENDING_SOURCE_TRACE_REVIEW'});
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({id:c.id,status:result.status,seconds:Math.round((result.durationMs??0)/1000),modelCalls:modelCalls.length,toolCalls:end?.toolCalls,sourceContentObtained:end?.policyState?.sourceContentObtained,remediationUsed:end?.policyState?.remediationUsed}));
}
await fs.writeFile(path.join(out,'integrity.json'),JSON.stringify({sourceUnchanged:JSON.stringify(before)===JSON.stringify(await fingerprint())}));
