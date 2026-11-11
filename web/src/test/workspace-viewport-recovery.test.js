// @vitest-environment node
// A real elapsed clock, not an immediate drain of the keyboard's first timers.
import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {describe,expect,it} from 'vitest'
const root='../../../vendor/tmux-webui/internal/assets/'
const template=readFileSync(new URL(root+'templates/index.html',import.meta.url),'utf8')
const gestures=readFileSync(new URL(root+'static/js/gestures.js',import.meta.url),'utf8')
const autofit=readFileSync(new URL(root+'static/js/cao-autofit.js',import.meta.url),'utf8')
const deviceTrace=JSON.parse(readFileSync(new URL('./fixtures/ios-chrome-resize-content.json',import.meta.url),'utf8'))
function setup({iframe=false,safe={},localSafe={}}={}){
 const outer=new JSDOM(iframe?'<iframe></iframe>':template,{url:'http://localhost/terminal/v/test/',runScripts:'outside-only',pretendToBeVisual:true})
 const host=outer.window,w=iframe?host.document.querySelector('iframe').contentWindow:host
 if(iframe){w.document.open();w.document.write(template);w.document.close()}
 let now=0,id=0;const timers=new Map()
 w.setTimeout=(fn,delay=0)=>{timers.set(++id,{fn,at:now+delay});return id}
 w.clearTimeout=id=>timers.delete(id)
 w.setInterval=()=>0;w.clearInterval=()=>{}
 w.Date.now=()=>now
 const advance=ms=>{const end=now+ms;let steps=0;while(true){const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;if(++steps>200)throw Error('timer fan-out');now=entry[1].at;timers.delete(entry[0]);entry[1].fn()}now=end}
 w.matchMedia=()=>({matches:true,addEventListener:()=>{}})
 host.document.hasFocus=()=>true
 const viewport=new host.EventTarget();Object.assign(viewport,{width:390,height:844,offsetTop:0,offsetLeft:0,scale:1})
 for(const [win,key,value] of [[host,'visualViewport',viewport],[host,'innerHeight',844],[host,'innerWidth',390],[w,'visualViewport',iframe?new w.EventTarget():viewport]])Object.defineProperty(win,key,{configurable:true,value})
 if(iframe){Object.defineProperty(w,'innerHeight',{configurable:true,value:792});w.frameElement.getBoundingClientRect=()=>({top:52,bottom:844,left:0,right:390,width:390,height:792})}
 // Browser-env stub: nonzero top-level safe area, zero child safe area.
 const computed=host.getComputedStyle.bind(host)
 host.getComputedStyle=el=>el.dataset.caoSafeProbe!==undefined?{paddingTop:String(safe.top||0),paddingRight:String(safe.right||0),paddingBottom:String(safe.bottom||0),paddingLeft:String(safe.left||0)}:computed(el)
 if(iframe){const localComputed=w.getComputedStyle.bind(w);w.getComputedStyle=el=>el.dataset.caoSafeProbe!==undefined?{paddingRight:String(localSafe.right||0),paddingBottom:String(localSafe.bottom||0),paddingLeft:String(localSafe.left||0)}:localComputed(el)}
 w.__CAO_WORKSPACE__=true
 const fired=[];w.addEventListener('cao:viewport',()=>fired.push({...w.__caoViewport}))
 w.eval(gestures)
 const input=w.document.getElementById('input');input.disabled=false
 const kb=()=>parseFloat(w.document.documentElement.style.getPropertyValue('--kb-height'))
 const focus=()=>input.focus()
 const fire=()=>viewport.dispatchEvent(new host.Event('resize'))
 const sends=[]
 function addFit(){
  w.ResizeObserver=class{observe(){}disconnect(){}}
  w.tmuxState={focusedPane:'%1',paneInfo:{'%1':{window_panes:1}}}
  w.tmuxWs={isConnected:()=>true,send:data=>sends.push(data)}
  w.eval(autofit)
  return w.createCaoAutoFit({measure:()=>({cols:Math.floor(viewport.width/10),rows:Math.floor((host.innerHeight-100-kb())/21)}),report:()=>{}})
 }
 const close=()=>{w.dispatchEvent(new w.Event('pagehide'));outer.window.close()}
 return {w,host,viewport,advance,timers,fired,kb,focus,fire,sends,addFit,close}
}
describe('long-lived mobile keyboard recovery',()=>{
 it('raises the panel when innerHeight shrinks before its containing iframe',()=>{
  const s=setup({iframe:true});s.focus()
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:504});s.viewport.height=504;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(340);expect(s.kb()).toBe(340)
  // Parent iframe layout catches up: no second subtraction.
  s.w.frameElement.getBoundingClientRect=()=>({top:52,bottom:504,left:0,right:390,width:390,height:452})
  s.fire();expect(s.kb()).toBe(0);s.close()
 })
 it.each([1,8,16,24,25,26])('compensates measured residual occlusion of %ipx after resize-content shrink',n=>{
  const s=setup({iframe:true});s.focus()
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:504+n});s.viewport.height=504
  s.w.frameElement.getBoundingClientRect=()=>({top:52,bottom:504+n,left:0,right:390,width:390,height:452+n})
  s.fire();expect(s.w.__caoViewport.keyboardHeight).toBeGreaterThan(0);expect(s.kb()).toBe(n);s.close()
 })
 it('clamps presentation to the measured iframe even without semantic keyboard classification',()=>{
  const s=setup({iframe:true});s.focus();s.viewport.height=828;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(0);expect(s.kb()).toBe(16);s.close()
 })
 it('propagates top-level safe area while not charging an already-inset iframe twice',()=>{
  const s=setup({iframe:true,safe:{bottom:34,left:20,right:28}})
  const value=edge=>parseFloat(s.w.document.documentElement.style.getPropertyValue('--cao-safe-'+edge))
  expect(value('bottom')).toBe(34);expect(value('left')).toBe(20);expect(value('right')).toBe(28)
  s.w.frameElement.getBoundingClientRect=()=>({top:52,bottom:810,left:20,right:362,width:342,height:758})
  s.fire();expect(value('bottom')).toBe(0);expect(value('left')).toBe(0);expect(value('right')).toBe(0)
  const doc=s.host.document;s.close();expect(doc.querySelector('[data-cao-safe-probe]')).toBeNull()
 })
 it('does not add a physical bottom safe area above the keyboard and restores it on dismissal',()=>{
  const s=setup({iframe:true,safe:{bottom:34,left:20,right:28}});s.focus();s.viewport.height=504;s.fire()
  const value=()=>parseFloat(s.w.document.documentElement.style.getPropertyValue('--cao-safe-bottom'))
  expect(s.kb()).toBe(340);expect(value()).toBe(0)
  s.viewport.height=844;s.fire();expect(s.kb()).toBe(0);expect(value()).toBe(34);s.close()
 })
 it('falls back to local iframe safe-area env when the host reports zero',()=>{
  const s=setup({iframe:true,localSafe:{bottom:21,left:12,right:17}})
  const value=edge=>parseFloat(s.w.document.documentElement.style.getPropertyValue('--cao-safe-'+edge))
  expect(value('bottom')).toBe(21);expect(value('left')).toBe(12);expect(value('right')).toBe(17);s.close()
 })
 it('does not reinterpret zoom as presentation keyboard clipping',()=>{
  const s=setup({iframe:true});s.focus();s.viewport.scale=1.5;s.viewport.height=504;s.fire()
  expect(s.kb()).toBe(0);expect(s.w.__caoViewport.keyboardHeight).toBe(0);s.close()
 })
 it('detects silent dismissal after the initial settle timers expired, without blur or header tap',()=>{
  const s=setup();s.focus();s.viewport.height=504;s.fire();expect(s.kb()).toBe(340)
  s.advance(6000);expect(s.kb()).toBe(340)
  s.viewport.height=844 // no resize, blur, focus or header gesture
  s.advance(600);expect(s.kb()).toBe(0)
  expect(s.w.document.activeElement.id).toBe('input');s.close()
 })
 it('recovers actual sizing through the viewport producer, not directly injected state',()=>{
  const s=setup();const fit=s.addFit();s.advance(250)
  s.focus();s.viewport.height=504;s.fire();s.advance(6000)
  const count=s.sends.length;s.viewport.width=430;s.viewport.height=844;s.advance(1000)
  expect(s.kb()).toBe(0);expect(s.sends.length).toBeGreaterThan(count)
  expect(s.sends.at(-1)).toMatchObject({cols:43,rows:35,auto:true})
  fit.destroy();s.close()
 })
 it('publishes usable viewport changes even when keyboard height stays zero',()=>{
  const s=setup();const count=s.fired.length;s.viewport.width=430;s.viewport.offsetLeft=3;s.fire()
  expect(s.fired.length).toBeGreaterThan(count);s.close()
 })
 it('does not double-subtract an iframe already shortened by parent layout',()=>{
  const s=setup({iframe:true});s.focus()
  s.w.frameElement.getBoundingClientRect=()=>({top:52,bottom:504,left:0,right:390,width:390,height:452})
  s.viewport.height=504;s.fire();expect(s.kb()).toBe(0)
  // Keyboard is still semantically open, even with no local inset to apply.
  expect(s.w.__caoViewport.keyboardHeight).toBe(340);s.close()
 })
 it('does not age an open keyboard into a false dismissal or keep background polling',()=>{
  const s=setup();s.focus();s.viewport.height=504;s.fire();s.advance(10000)
  expect(s.kb()).toBe(340)
  Object.defineProperty(s.w.document,'hidden',{configurable:true,value:true})
  s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));s.advance(1000)
  expect(s.timers.size).toBe(0)
  Object.defineProperty(s.w.document,'hidden',{configurable:true,value:false})
  s.viewport.height=844;s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));s.advance(500)
  expect(s.kb()).toBe(0);s.close();expect(s.timers.size).toBe(0)
 })
 it('samples without event fan-out and stops once no editor remains',()=>{
  const s=setup();s.focus();s.viewport.height=504;s.fire();s.advance(6000)
  const count=s.fired.length;s.advance(20000)
  expect(s.fired.length).toBe(count);expect(s.timers.size).toBe(1)
  s.w.document.activeElement.blur();s.advance(1600)
  expect(s.timers.size).toBe(0);s.close()
 })
 it('does not poll or resize a visible but genuinely unfocused browser viewer',()=>{
  const s=setup();const fit=s.addFit();s.advance(250)
  s.focus();s.viewport.height=504;s.fire();s.advance(2000)
  s.host.document.hasFocus=()=>false;s.host.dispatchEvent(new s.host.Event('blur'));s.advance(1600)
  const count=s.sends.length;s.viewport.height=844;s.advance(1600)
  expect(s.timers.size).toBe(0);expect(s.sends.length).toBe(count)
  s.host.document.hasFocus=()=>true;s.host.dispatchEvent(new s.host.Event('focus'));s.advance(500)
  expect(s.kb()).toBe(0);expect(s.sends.at(-1)).toMatchObject({cols:39,rows:35})
  fit.destroy();s.close()
 })
 it('detects resize-content keyboards from the pre-edit height without adding a second inset',()=>{
  const s=setup();s.focus();s.advance(100)
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:504});s.viewport.height=504;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(340);expect(s.kb()).toBe(0)
  s.advance(6000);expect(s.w.__caoViewport.keyboardHeight).toBe(340)
  s.host.document.hasFocus=()=>false;s.host.dispatchEvent(new s.host.Event('blur'))
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:844});s.viewport.height=844;s.fire();s.advance(1500)
  expect(s.w.__caoViewport.keyboardHeight).toBe(0);expect(s.kb()).toBe(0)
  expect(s.host.document.hasFocus()).toBe(false);expect(s.w.document.activeElement.id).toBe('input')
  s.close()
 })
 it('replays the reduced native report without shrinking grid or resizing during false focus',()=>{
  const s=setup();let focused=true;s.host.document.hasFocus=()=>focused
  Object.defineProperty(s.host,'innerWidth',{configurable:true,value:430});s.viewport.width=430
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:742});s.viewport.height=742;s.fire()
  const fit=s.addFit();s.advance(250)
  s.focus();s.w.dispatchEvent(new s.w.Event('cao:terminal-layout'))
  const before=s.sends.filter(m=>m.cols).length
  const open=deviceTrace.samples.find(x=>x.innerHeight===430)
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:open.innerHeight});s.viewport.height=open.visualHeight;s.fire();s.advance(1000)
  expect(s.w.__caoViewport.keyboardHeight).toBe(312)
  expect(s.sends.filter(m=>m.cols)).toHaveLength(before)
  focused=false;s.host.dispatchEvent(new s.host.Event('blur'))
  const closed=deviceTrace.samples.find(x=>x.ms===15079)
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:closed.innerHeight});s.viewport.height=closed.visualHeight;s.fire();s.advance(25000)
  expect(s.w.__caoViewport.keyboardHeight).toBe(0);expect(s.sends.filter(m=>m.cols)).toHaveLength(before)
  const paused=s.sends.length;s.w.dispatchEvent(new s.w.Event('cao:terminal-layout'));s.advance(300)
  expect(s.sends.length).toBe(paused);fit.destroy();s.close()
 })
 it('does not classify toolbar noise or changed-width rotation as resize-content keyboard',()=>{
  const s=setup();s.focus()
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:790});s.viewport.height=790;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(0)
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:390});Object.defineProperty(s.host,'innerWidth',{configurable:true,value:844})
  s.viewport.height=390;s.viewport.width=844;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(0);s.close()
 })
 it('supports repeated resize-content cycles without automatic blur or input',()=>{
  const s=setup();s.focus()
  for(let i=0;i<3;i++){
   Object.defineProperty(s.host,'innerHeight',{configurable:true,value:504});s.viewport.height=504;s.fire();s.advance(1200)
   expect(s.w.__caoViewport.keyboardHeight).toBe(340);expect(s.kb()).toBe(0)
   Object.defineProperty(s.host,'innerHeight',{configurable:true,value:844});s.viewport.height=844;s.fire();s.advance(1200)
   expect(s.w.__caoViewport.keyboardHeight).toBe(0);expect(s.w.document.activeElement.id).toBe('input')
  }
  expect(s.sends).toEqual([]);s.close()
 })
 it('does not infer resize-content keyboard from a desktop window resize',()=>{
  const s=setup();s.w.matchMedia=()=>({matches:false});s.focus()
  Object.defineProperty(s.host,'innerHeight',{configurable:true,value:504});s.viewport.height=504;s.fire()
  expect(s.w.__caoViewport.keyboardHeight).toBe(0);s.close()
 })
 it('cleans all sampling/listeners even if a focused editor remains at teardown',()=>{
  const s=setup();s.focus();s.viewport.height=504;s.fire();s.advance(2000)
  const count=s.fired.length;s.w.dispatchEvent(new s.w.Event('pagehide'))
  expect(s.timers.size).toBe(0);s.viewport.height=844;s.fire();s.advance(1000)
  expect(s.fired.length).toBe(count);expect(s.timers.size).toBe(0);s.close()
 })
 it('retains zoom and IME pauses while real viewport geometry recovers',()=>{
  const s=setup();const fit=s.addFit();s.advance(250)
  s.focus();s.viewport.height=504;s.fire();s.advance(2000)
  s.w.document.dispatchEvent(new s.w.Event('compositionstart'))
  s.viewport.height=844;s.viewport.scale=1.5;s.fire();s.advance(1500)
  const count=s.sends.length;s.viewport.scale=1;s.fire();s.advance(500)
  expect(s.sends.length).toBe(count)
  s.w.document.dispatchEvent(new s.w.Event('compositionend'));s.advance(250)
  expect(s.sends.at(-1)).toMatchObject({cols:39,rows:35})
  fit.destroy();s.close()
 })
 it('does not override manual-off or shared-window sizing after a silent close',()=>{
  for(const mode of ['off','shared']){
   const s=setup();const fit=s.addFit();s.advance(250)
   if(mode==='off')fit.setEnabled(false)
   else{s.w.tmuxState.paneInfo['%1'].window_panes=2;s.w.dispatchEvent(new s.w.Event('cao:panes'))}
   s.focus();s.viewport.height=504;s.fire();s.advance(6000)
   const count=s.sends.length;s.viewport.height=844;s.advance(1500)
   expect(s.kb()).toBe(0);expect(s.sends.length).toBe(count)
   fit.destroy();s.close()
  }
 })
 it('restores an iframe inset only for its actually occluded bottom',()=>{
  const s=setup({iframe:true});s.focus();s.viewport.height=504;s.viewport.offsetTop=20;s.fire()
  expect(s.kb()).toBe(320);s.advance(6000)
  s.viewport.height=824 // same nonzero pan, zero overlap; no event
  s.advance(600);expect(s.kb()).toBe(0);s.close()
 })
})
