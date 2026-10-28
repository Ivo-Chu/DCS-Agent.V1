/** Synthetic sources only; real rg and filesystem. No model, Oracle or private map. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { searchDcsCodeTool as search, readDcsCodeTool as read } from '../src/dcs/source-tools.ts';
import { validateSourceEntry, type SourceEntry } from '../src/dcs/source-map.ts';
import { createMockSession } from '../src/dcs/session.ts';

const parent = path.resolve('data/harness-v1');
await fs.mkdir(parent,{recursive:true});
const root=await fs.mkdtemp(path.join(parent,'synthetic-'));
const saved={...process.env};
process.env.DCS_SOURCE_ROOT=root;
process.env.DCS_SOURCE_MAP_FILE=path.join(root,'map.json');
const ctx={session:createMockSession()};
const decode=(r:{output:string})=>JSON.parse(r.output);
let passed=0;
async function test(name:string,fn:()=>Promise<void>) {await fn();passed++;console.log(`✓ ${name}`);}
const code='// 示例功能\nclass ExampleController {}\n// 模拟结束\n';
const hash=createHash('sha256').update(code).digest('hex');
const entry:SourceEntry={name:'示例功能',aliases:['测试入口'],page:'/Example/Index',controller:'ExampleController',action:'Index',
 verification:{status:'verified',basis:'合成路由、控制器及视图，仅测试契约',checkedAt:'2026-10-28T00:00:00Z'},
 references:(['route','controller','view'] as const).map((role,i)=>({path:['route.cs','ExampleController.cs','Index.cshtml'][i],startLine:1,endLine:3,sha256:hash,role}))};
const save=async(e:SourceEntry[]= [entry])=>fs.writeFile(process.env.DCS_SOURCE_MAP_FILE!,JSON.stringify({version:1,entries:e}));
try {
 for(const r of entry.references) await fs.writeFile(path.join(root,r.path),code);
 await fs.writeFile(path.join(root,'UI.Designer.cs'),code);
 await save();
 await test('feature返回有来源校验的候选，别名及分页可用',async()=>{
   const r=decode(await search.execute({mode:'feature',pattern:'测试入口'},ctx));
   assert.equal(r.items.length,1);assert.equal(r.items[0].references[0].sha256,hash);assert.equal(r.indexVersion,1);
   await save([entry,{...entry,name:'示例功能二'}]);
   const first=decode(await search.execute({mode:'feature',pattern:'示例',limit:1},ctx));
   const second=decode(await search.execute({mode:'feature',pattern:'示例',offset:first.nextOffset,limit:1},ctx));
   assert.equal(first.hasMore,true);assert.equal(second.items[0].name,'示例功能二');assert.equal(second.hasMore,false);await save();
 });
 await test('索引无匹配/缺失/损坏均不阻断普通搜索',async()=>{
   assert.equal(decode(await search.execute({mode:'feature',pattern:'未知'},ctx)).status,'empty');
   await fs.unlink(process.env.DCS_SOURCE_MAP_FILE!);
   assert.equal(decode(await search.execute({mode:'feature',pattern:'示例'},ctx)).reason,'index_not_configured');
   await fs.writeFile(process.env.DCS_SOURCE_MAP_FILE!,'broken');
   assert.equal((await search.execute({mode:'feature',pattern:'示例'},ctx)).isError,true);
   assert.ok(decode(await search.execute({mode:'files',pattern:'*Controller.cs'},ctx)).items.length);await save();
 });
 await test('修改源码、缺失路径、失效行号、未验证映射不冒充确认',async()=>{
   await fs.writeFile(path.join(root,'route.cs'),code+'// drift');
   let r=decode(await search.execute({mode:'feature',pattern:'示例'},ctx));assert.equal(r.items.length,0);assert.match(JSON.stringify(r.rejected),/source_changed/);
   await fs.writeFile(path.join(root,'route.cs'),code);
   for(const changed of [
     {...entry,verification:{...entry.verification,status:'unverified' as const}},
     {...entry,references:entry.references.map(r=>({...r,endLine:1000}))},
     {...entry,references:entry.references.map(r=>({...r,path:'missing.cs'}))},
     {...entry,references:entry.references.filter(r=>r.role!=='route')},
   ]) {assert.ok((await validateSourceEntry(changed)).length);await save([changed]);r=decode(await search.execute({mode:'feature',pattern:'示例'},ctx));assert.equal(r.items.length,0);}
   await save();
 });
 await test('索引引用拒绝目录穿越及根目录外链接',async()=>{
   const outside=await fs.mkdtemp(path.join(parent,'outside-'));
   const link=path.join(root,'link');
   try {
     await fs.writeFile(path.join(outside,'external.cs'),code);
     await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
     for(const p of [path.relative(root,path.join(outside,'external.cs')),'link/external.cs',path.join(outside,'external.cs')]) {
       assert.ok((await validateSourceEntry({...entry,references:entry.references.map(r=>({...r,path:p}))})).length);
     }
   } finally {
     await fs.unlink(link).catch(()=>{});
     if(path.dirname(outside)!==parent || !path.basename(outside).startsWith('outside-'))throw new Error('Unexpected cleanup path');
     await fs.rm(outside,{recursive:true,force:true});
   }
 });
 await test('contextLines只规范化非负整数上限，保留输入并记录修正',async()=>{
   const args={mode:'text' as const,pattern:'示例',glob:'*Controller.cs',contextLines:20};
   const r=decode(await search.execute(args,ctx));assert.equal(r.status,'success');assert.equal(args.contextLines,20);
   assert.deepEqual(r.corrections,[{field:'contextLines',from:20,to:5}]);
   for(const v of [-1,1.5,'20']) {
     const bad=decode(await search.execute({...args,contextLines:v} as any,ctx));assert.equal(bad.status,'invalid_args');assert.equal(bad.field,'contextLines');assert.equal(bad.actual,v);assert.ok(bad.example);
   }
 });
 await test('mode不混用字段，错误明确指向字段，路径/分页不被擅自改写',async()=>{
   for(const [args,field] of [
     [{mode:'feature',pattern:'示例',directory:'x'},'directory'],
     [{mode:'files',pattern:'*',contextLines:20},'contextLines'],
     [{mode:'text',pattern:'x',offset:-1},'offset'],
     [{mode:'text',pattern:'x',limit:101},'limit'],
     [{mode:'text'},'pattern'],[null,'arguments'],
   ] as const){const r=decode(await search.execute(args as any,ctx));assert.equal(r.field,field);assert.equal(r.status,'invalid_args');}
   assert.equal((await search.execute({mode:'files',pattern:'*',directory:'..'},ctx)).isError,true);
   const bad=decode(await read.execute({files:[{path:'Index.cshtml',lineCount:201}]},ctx));assert.equal(bad.field,'files[0].lineCount');assert.equal(bad.actual,201);
 });
 await test('资源与源码可区分，分页保留上下文与实际行号',async()=>{
   const all=decode(await search.execute({mode:'text',pattern:'示例',contextLines:0,glob:'*.cs',limit:100},ctx));
   assert.ok(all.items.some((r:any)=>r.kind==='resource'));assert.ok(all.items.some((r:any)=>r.kind==='source'));
   let offset=0;const collected:any[]=[];
   do {const r=decode(await search.execute({mode:'text',pattern:'示例',contextLines:0,glob:'*.cs',limit:1,offset},ctx));collected.push(...r.items);if(!r.hasMore)break;offset=r.nextOffset;}while(true);
   assert.deepEqual(collected,all.items);assert.ok(collected.every(r=>r.match&&r.line===1));
 });
 await test('索引可定位后读取实际代码，取消不继续读取',async()=>{
   const r=decode(await search.execute({mode:'feature',pattern:'示例'},ctx));
   const ref=r.items[0].references[1];
   const readResult=decode(await read.execute({files:[{path:ref.path,startLine:ref.startLine,lineCount:3}]},ctx));assert.equal(readResult.files[0].lines[1].text,'class ExampleController {}');
   const holder={controller:new AbortController()};holder.controller.abort();
   assert.equal(decode(await search.execute({mode:'feature',pattern:'示例'},{...ctx,holder})).status,'cancelled');
 });
 console.log(`Harness V1: ${passed} passed (synthetic offline; no business success claim)`);
} finally {
 process.env=saved;
 if(path.dirname(root)!==parent||!path.basename(root).startsWith('synthetic-'))throw new Error('Unexpected cleanup path');
 await fs.rm(root,{recursive:true,force:true});
}
