import {test} from 'node:test';
import assert from 'node:assert/strict';
import {displayMessages, applyTextEvent, type StoreMessage} from '../src/messages.ts';
import type {Tool} from '../src/tool-progress.ts';
test('process notes and tools are ordered in one block; answer stays separate on reload',()=>{
 let messages:StoreMessage[]=[{id:'r:user',role:'user',content:'这个功能有什么用'}];
 messages=applyTextEvent(messages,'r',{type:'delta',messageId:'1',text:'先检索说明',kind:'answer'});
 messages=applyTextEvent(messages,'r',{type:'message_kind',messageId:'1',kind:'process'});
 messages=applyTextEvent(messages,'r',{type:'delta',messageId:'2',text:'换一个关键词',kind:'process'});
 messages=applyTextEvent(messages,'r',{type:'final',messageId:'3',text:'功能用于 **查询**',kind:'answer'});
 const tools:Tool[]=[{key:'a',name:'search_dcs_knowledge',messageId:'r:1',status:'success'},{key:'b',name:'investigate_dcs_code',messageId:'r:2',status:'success'}];
 const result=displayMessages(messages,tools);
 assert.deepEqual(result.map(m=>m.id),['r:user','r:process-view','r:3']);
 assert.deepEqual(result[1].steps?.map(s=>s.text ?? s.tool?.key),['先检索说明','a','换一个关键词','b']);
 assert.equal(result[2].content,'功能用于 **查询**');
 assert.deepEqual(displayMessages(JSON.parse(JSON.stringify(messages)),JSON.parse(JSON.stringify(tools))),result);
 assert.equal(messages[3].content,'功能用于 **查询**');
});
test('selection only removes explicitly classified selection text, preserving errors and other answers',()=>{
 const messages:StoreMessage[]=[{id:'r:user',role:'user',content:'通讯录'},
 {id:'r:1',role:'assistant',content:'请选择菜单',kind:'selection'},
 {id:'r:error',role:'assistant',content:'连接中断'},
 {id:'r:2',role:'assistant',content:'其他问题的有效答案',kind:'answer'},
 {id:'n:user',role:'user',content:'行政 / 通讯录'},
 {id:'n:1',role:'assistant',content:'已打开',kind:'answer'}];
 const tools:Tool[]=[{key:'nav',name:'navigate_dcs_menu',messageId:'r:1',status:'selection',candidates:[{title:'通讯录',path:'行政 / 通讯录'}]}];
 const result=displayMessages(messages,tools);
 assert.deepEqual(result.map(m=>m.id),['r:user','r:process-view','r:error','r:2','r:selection-view','n:user','n:1']);
 assert.equal(result[4].candidates?.[0].path,'行政 / 通讯录');
 assert.ok(displayMessages(messages,[]).some(m=>m.id==='r:1'));
});
test('ordinary streaming answer keeps its id and never creates process block',()=>{
 let m:StoreMessage[]=[{id:'r:user',role:'user',content:'你好'}];
 m=applyTextEvent(m,'r',{type:'delta',text:'你好',messageId:'1',kind:'answer'});
 assert.equal(displayMessages(m,[])[1].id,'r:1');
 m=applyTextEvent(m,'r',{type:'final',text:'你好！',messageId:'1',kind:'answer'});
 assert.deepEqual(displayMessages(m,[]).map(m=>m.id),['r:user','r:1']);
});
test('Markdown preserved for rendering without rewriting stored text or user input',()=>{
 const m:StoreMessage[]=[{id:'r:user',role:'user',content:'**原文**'},{id:'r:1',role:'assistant',content:'**查询**；2 * 3；未配对 **'}];
 assert.equal(displayMessages(m,[])[1].content,'**查询**；2 * 3；未配对 **');assert.equal(displayMessages(m,[])[0].content,'**原文**');
});
