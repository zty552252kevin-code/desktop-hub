// Live regression: drive Calculator through the hub (background delivery, no focus steal).
// Usage: node test/live/calc.mjs "$PWD/server.mjs"
// Written on a zh-CN macOS: the AX labels below (加, 等于, 清除, 关于计算器…) are the localized ones — on another
// system language put that language's labels in their place. Compare the '=== ' lines of two runs; steps marked
// 'must be refused' are expected to print ERROR. Calculator restores its last expression on launch, and step 17/18
// depend on what the display holds, so compare runs that start from the same display.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t=new StdioClientTransport({command:'node',args:[process.argv[2]],env:{...process.env}});
const c=new Client({name:'live',version:'0'});
await c.connect(t);
const call=async(n,a)=>{const t0=Date.now();let r;try{r=await c.callTool({name:n,arguments:a},undefined,{timeout:90000});}catch(e){r={isError:true,content:[{type:'text',text:'THROW '+e.message}]};}
  return {err:!!r.isError,ms:Date.now()-t0,text:(r.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n'),imgs:(r.content||[]).filter(x=>x.type==='image').length,sc:r.structuredContent!==undefined};};
const show=(title,x,max=900)=>console.log(`\n=== ${title} [${x.ms}ms${x.err?' ERROR':''}${x.imgs?` +${x.imgs} image(s)`:''}${x.sc?' +structuredContent!':''} ${x.text.length} chars]\n${x.text.slice(0,max)}${x.text.length>max?'\n…':''}`);
await call('launch_app',{bundle_id:'com.apple.calculator'}); await new Promise(r=>setTimeout(r,1500));
const lw=await call('list_windows',{});
const m=/^(\d+) pid (\d+) (?:计算器|Calculator) /m.exec(lw.text); if(!m){console.log('Calculator window not found',lw.text);process.exit(1);}
const W={pid:Number(m[2]),window_id:Number(m[1])};
const ws=await call('window_state',{...W,include_screenshot:false}); show('1 window_state, whole tree',ws,1400);
if(!/snapshot (s[0-9a-f]+)/.test(ws.text)){console.log('\nCannot read the Calculator window (screen locked, or the window is on another desktop Space). Go to its Space and run again.');await c.close();process.exit(2);}
const sid=/snapshot (s[0-9a-f]+)/.exec(ws.text)[1];
const row=(label)=>Number(new RegExp('\\[(\\d+)\\] AXButton "'+label+'"').exec(ws.text)[1]);
const r1=await call('act',{action:'click',...W,element_token:`${sid}:${row('7')}`}); show('2 click 7 by token (the receipt should list the display change)',r1);
const r2=await call('act',{action:'click',...W,element_token:`${sid}:${row('8')}`}); show('3 click 8 with a token of the FIRST snapshot (the hub should carry it over)',r2);
const r3=await call('act',{action:'click',...W,find:{role:'AXButton',label:'加'}}); show('4 click 加 (plus) by find',r3);
const r4=await call('act_batch',{...W,steps:[{action:'click',find:{label:'1'}},{action:'click',find:{label:'2'}},{action:'click',find:{role:'AXButton',label:'等于'}}]}); show('5 batch: 1, 2, 等于 (equals) — expect 78+12=90',r4);
const r5=await call('act',{action:'click',...W,element_token:`${sid}:999`}); show('6 a row number that was never shown -> must be refused',r5);
const r6=await call('act',{action:'click',...W,element_token:`s0000dead:3`}); show('7 an unknown snapshot -> must be refused',r6);
const r7=await call('act',{action:'click',element_token:`${sid}:${row('7')}`}); show('8 no pid -> must be refused',r7);
const r8=await call('act',{action:'hotkey',...W,keys:['cmd','q'],key:'a'}); show('9 hotkey with a stray key field -> must be refused',r8);
const r9=await call('act',{action:'key',...W,key:'return',repeat:5}); show('10 return with repeat -> must be refused',r9);
const r10=await call('act',{action:'type',...W,text:'生僻字𪚥'}); show('11 a character outside the BMP -> must be refused',r10);
const q=await call('window_state',{...W,query:'清除|删除',include_screenshot:false}); show('12 query 清除|删除 (clear|delete)',q);
const q0=await call('window_state',{...W,query:'不存在的词',include_screenshot:false}); show('13 query with no match',q0,700);
const d=await call('window_state',{...W,diff:true}); show('14 diff:true',d);
const shot=await call('window_state',{...W,tree:false}); show('15 tree:false, picture only',shot);
const s2=await call('window_state',{...W}); show('16 whole tree with a picture (the hub learns the screenshot scale)',s2,300);
const sid2=/snapshot (s[0-9a-f]+)/.exec(s2.text)[1];
const px=await call('act',{action:'click',...W,x:230,y:160}); show('17 pixel click on the display (not pressable) -> the receipt should name what was hit',px);
const px2=await call('act',{action:'click',...W,x:230,y:160}); show('18 the same point again (goes if the last press changed something; a press that changes nothing gets the look-first note)',px2);
const px2b=await call('act',{action:'click',...W,x:230,y:160,observe:false}); show('18b a third time at once, without again -> must be refused',px2b);
const px3=await call('act',{action:'click',...W,x:230,y:160,again:true,observe:false}); show('19 with again:true, observe:false -> goes',px3);
const mb=await call('act',{action:'click',...W,find:{role:'AXMenuItem',label:'关于计算器'}}); show('20 a menu-bar item by find -> must be refused, with the menu path to use',mb);
const nav=await call('act',{action:'key',...W,key:'escape'}); show('21 key escape (clears the display)',nav);
const fr=await call('window_state',{...W,query:'AXButton',frames:true,include_screenshot:false,max_elements:6}); show('22 frames:true (element centres in screenshot px)',fr);
// —— token rule: a change the model was not shown makes an old token refuse once, listing the change ——
const v1=await call('window_state',{...W,include_screenshot:false}); const vs=/snapshot (s[0-9a-f]+)/.exec(v1.text)[1];
const vrow=(label)=>Number(new RegExp('\\[(\\d+)\\] AXButton "'+label+'"').exec(v1.text)[1]);
const u1=await call('act',{action:'key',...W,key:'5',observe:false}); show('23 key 5 with observe:false (the display changes, the hub does not walk)',u1);
const u2=await call('window_state',{...W,query:'等于',include_screenshot:false}); show('24 a query look (few changes: the reply should list the display change too)',u2);
const u3=await call('act',{action:'click',...W,element_token:`${vs}:${vrow('9')}`}); show('25 click 9 with a token from before step 23 -> step 24 told the model the change: goes',u3);
const u4=await call('act',{action:'click',...W,element_token:`${vs}:${vrow('9')}`}); show('26 the same old token again -> goes, one more 9 on the display',u4);
const u5=await call('act',{action:'hotkey',...W,keys:['cmd+a','x']}); show('27 "cmd+a" written as one element -> must be refused',u5);
const u6=await call('act',{action:'click',...W,x:230,y:160,delivery_mode:' foreground'}); show('28 delivery_mode with a leading space -> must be refused',u6);
await call('act',{action:'key',...W,key:'escape',observe:false});
await c.close();
