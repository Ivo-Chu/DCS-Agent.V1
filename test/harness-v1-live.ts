/** Source-only controlled experiment. No identity resolution, DB or knowledge network access. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Agent } from '../src/core/agent.ts';
import type { AgentEvent } from '../src/core/events.ts';
import { createOpenAiStreamFn } from '../src/core/model/openai-compatible.ts';
import { loadEnvLocal } from '../src/dcs/env-local.ts';
import { createMockSession } from '../src/dcs/session.ts';
import { dcsTools } from '../src/dcs/tools.ts';
import { createDcsToolHooks } from '../src/dcs/hooks.ts';
import { DEFAULT_MAX_TURNS } from '../src/dcs/agent-factory.ts';
import { attachRunObserver } from '../src/observability/observer.ts';
import { classifyRun, writeReports, type CaseResult } from './acceptance-harness.ts';
import { failure } from '../src/dcs/db/result.ts';
import { validateSourceEntry, type SourceMap } from '../src/dcs/source-map.ts';

loadEnvLocal();
const base = path.resolve('data/harness-v1');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const casesBytes = await fs.readFile(path.join(base,'cases.json'));
const cases = JSON.parse(casesBytes.toString('utf8'));
if (cases.length < 3 || new Set(cases.map((c: any)=>c.domain)).size < 3) throw new Error('Need at least three domains');
const map: SourceMap = JSON.parse(await fs.readFile(path.join(base,'source-map.json'),'utf8'));
for (const entry of map.entries) {
  const issues = await validateSourceEntry(entry);
  if (issues.length) throw new Error(JSON.stringify(issues));
}
const baseline = await import(pathToFileURL(path.join(base,'baseline/source-tools.ts')).href);
const originalPrompt = await fs.readFile(path.join(base,'baseline/prompt.txt'),'utf8');
const guidance = '\n【按需调查】\n文档类问题按需检索知识库；实现逻辑按需调查源码；实时数据按需使用授权查询。业务入口不清楚时先定位。证据必须对应用户的业务对象，注意分页、截断与未查证部分。证据不足明确说明无法确认，区分事实与推断。不需要工具的问题可直接回答。\n';
const candidatePrompt = originalPrompt.replace(/【问题必须先调用tools】[\s\S]*?(?=【硬性边界】)/, guidance);
const candidateWithGuidance = candidatePrompt.includes('【按需调查】') ? candidatePrompt : candidatePrompt.replace('【硬性边界】',guidance+'【硬性边界】');
const isolation = '\n【隔离实验环境】当前为模拟身份的源码调查测试；数据库、实时员工数据和知识库在本实验不可用。可以根据源码说明实现，不能声称完成实时查询或验证线上菜单。';
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const out = path.join(base,'runs',stamp); await fs.mkdir(out,{recursive:true});
process.env.DCS_SOURCE_MAP_FILE = path.join(base,'source-map.json');
const fingerprint = async () => {
  const refs = [...map.entries.flatMap(e=>e.references), ...cases.flatMap((c:any)=>c.evidence)];
  return sha(JSON.stringify(await Promise.all(refs.map(async (r:any)=>[r.path,sha(await fs.readFile(path.resolve(process.env.DCS_SOURCE_ROOT!,r.path)))]))));
};
const sourceFingerprint = await fingerprint();
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({model:process.env.LLM_MODEL,repeats:3,casesSha256:sha(casesBytes),sourceFingerprint,mapSha256:sha(await fs.readFile(process.env.DCS_SOURCE_MAP_FILE)),
  baselineToolsSha256:sha(await fs.readFile(path.join(base,'baseline/source-tools.ts'))),candidateToolsSha256:sha(await fs.readFile('src/dcs/source-tools.ts')),
  prompts:{A:originalPrompt+isolation,B:originalPrompt+isolation,C:candidateWithGuidance+isolation},
  isolation:'All configurations use same six tool schemas; non-source tools return unavailable without execution. Mock identity; no production DB. Expected facts never sent to model.',maxTurns:DEFAULT_MAX_TURNS,maxDurationMs:120000,humanFactsReview:'PENDING'},null,2));
console.log(JSON.stringify({out}));
if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) {
  await fs.writeFile(path.join(out,'unverified.json'),JSON.stringify({status:'SKIPPED',reason:'Model not configured'}));
  process.exit(0);
}
const results: CaseResult[] = [], metrics: any[] = [];
for (let repeat=1;repeat<=3;repeat++) for (const c of cases) for (const variant of (repeat===2?['B','C','A']:repeat===3?['C','A','B']:['A','B','C'])) {
  if (await fingerprint() !== sourceFingerprint) throw new Error('Source changed during comparison');
  const holder = {controller:new AbortController()};
  const tools = dcsTools.map(t=>{
    if (!['search_dcs_code','read_dcs_code'].includes(t.name)) return {...t,execute:async()=>failure('unavailable','隔离源码实验不提供数据库、知识库或查询结果文件。')};
    if (variant==='A') return t.name==='search_dcs_code'?baseline.searchDcsCodeTool:baseline.readDcsCodeTool;
    if (variant==='B' && t.name==='search_dcs_code') {
      const parameters = structuredClone(t.parameters) as any;
      parameters.properties.mode.enum = ['files','text'];
      return {...t,parameters,description:t.description.replace(/feature按业务名称.*?files\/text。/,''),execute:async(a:any,ctx:any)=>a?.mode==='feature'?failure('invalid_args','B配置仅支持files/text'):t.execute(a,ctx)};
    }
    return t;
  });
  const agent = new Agent({systemPrompt:(variant==='C'?candidateWithGuidance:originalPrompt)+isolation,tools,
    streamFn:createOpenAiStreamFn({signalProvider:()=>holder.controller.signal}),toolContext:{session:createMockSession(),holder},hooks:createDcsToolHooks(),maxTurns:DEFAULT_MAX_TURNS});
  const events:AgentEvent[]=[];
  const observer = attachRunObserver(agent,{channel:'harness-v1-source-only',logsDir:path.join(out,'traces'),write:null});
  const unsubscribe=agent.subscribe(e=>events.push(e));
  let timedOut=false; const started=Date.now();
  const timer=setTimeout(()=>{timedOut=true;holder.controller.abort();},120000);
  const ac={id:`${c.id}-${variant}-${repeat}`,conversationId:`${c.id}-${variant}-${repeat}`,employeeCode:'10086',question:c.question,expectedFacts:c.expectedFacts,maxDurationMs:120000};
  let answer=''; let error:unknown;
  try { answer=await agent.prompt(c.question); } catch(e) {error=e;}
  finally {clearTimeout(timer);await observer.end(timedOut?'timeout':'detached');observer.detach();unsubscribe();}
  const result=classifyRun(ac,{answer,events,timedOut,durationMs:Date.now()-started,error}); results.push(result);
  const ends=events.filter(e=>e.type==='tool_execution_end');
  const calls=events.filter(e=>e.type==='model_call_end');
  const argumentErrors=ends.filter(e=>{try{return JSON.parse(e.contextText||'{}').status==='invalid_args';}catch{return /参数不是合法 JSON/.test(e.contextText||'');}});
  metrics.push({id:ac.id,variant,repeat,domain:c.domain,runId:events.find(e=>e.type==='run_start')?.runId,status:result.status,
    durationMs:result.durationMs,modelCalls:calls.length,toolCalls:ends.length,argumentErrors:argumentErrors.length,
    parameterErrorRate:ends.length?argumentErrors.length/ends.length:0,
    inputTokens:calls.every(e=>e.usage?.inputTokens!==undefined)?calls.reduce((n,e)=>n+e.usage!.inputTokens!,0):null,
    outputTokens:calls.every(e=>e.usage?.outputTokens!==undefined)?calls.reduce((n,e)=>n+e.usage!.outputTokens!,0):null,
    corrections:ends.flatMap(e=>{try{return JSON.parse(e.contextText||'{}').corrections||[];}catch{return [];}}),
    businessAccuracy:null,localizationAccuracy:null,errorRecovery:null,unsupportedFacts:null,review:'PENDING_HUMAN_REVIEW'});
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(metrics,null,2));
  writeReports(out,results,[],[]);
  console.log(JSON.stringify({id:ac.id,status:result.status,seconds:Math.round((Date.now()-started)/1000),modelCalls:calls.length,toolCalls:ends.length,argumentErrors:argumentErrors.length}));
}
if(await fingerprint()!==sourceFingerprint) throw new Error('Source changed at end');
