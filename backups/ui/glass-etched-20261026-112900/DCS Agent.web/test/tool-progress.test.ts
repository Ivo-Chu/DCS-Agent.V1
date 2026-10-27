import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyToolEvent, toolLabel} from '../src/tool-progress.ts';
test('progress stays with its reply, preserves order and exposes business labels',()=>{
 let tools=applyToolEvent([], 'first', {type:'tool_step',status:'start',name:'investigate_dcs_code',toolCallId:'same'});
 assert.equal(toolLabel(tools[0]),'DCS业务逻辑查询中');
 tools=applyToolEvent(tools,'second',{type:'tool_step',status:'start',name:'query_dcs_data',toolCallId:'same'});
 tools=applyToolEvent(tools,'first',{type:'tool_step',status:'end',name:'investigate_dcs_code',toolCallId:'same'});
 assert.deepEqual(tools.map(t=>t.messageId),['first:process','second:process']);
 assert.equal(toolLabel(tools[0]),'DCS业务逻辑查询完成');
 assert.equal(toolLabel({...tools[0],name:'internal_secret_tool'}),'业务处理完成');
});
test('selection retains exact structured paths without parsing model prose',()=>{
 const candidates=[{title:'通讯录',path:'人资 / 通讯录'},{title:'通讯录',path:'行政 / 通讯录'}];
 const tools=applyToolEvent([],'run',{type:'tool_step',status:'end',name:'navigate_dcs_menu',navigationStatus:'needs_selection',candidates});
 assert.equal(tools[0].status,'selection');assert.deepEqual(tools[0].candidates,candidates);
});
