// @vitest-environment node
import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {describe, expect, it, vi} from 'vitest'
const root='../../../vendor/tmux-webui/internal/assets/'
const template=readFileSync(new URL(root+'templates/index.html',import.meta.url),'utf8')
const code=readFileSync(new URL(root+'static/js/cao-attachments.js',import.meta.url),'utf8')
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
function setup(responses){
 const dom=new JSDOM(template,{runScripts:'outside-only',url:'http://localhost/terminal/v/test/'}),w=dom.window
 w.document.getElementById('app').classList.add('cao-direct-active')
 w.tmuxState={focusedPane:'%1'};w.tmuxWs={isConnected:()=>true,connectionId:()=>1}
 w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=vi.fn()
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true}
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))}
 w.fetch=vi.fn();for(const response of responses)w.fetch.mockResolvedValueOnce(response)
 w.caoPasteText=vi.fn(()=>true);w.eval(code)
 const buttons=()=>[...w.document.querySelectorAll('dialog button')]
 const button=name=>buttons().find(x=>x.textContent===name)
 const attach=()=>w.caoAttachImages([new w.File(['fixture'],'test.png',{type:'image/png'})])
 return {w,attach,button,note:()=>w.document.querySelector('dialog p')?.textContent}
}
const error=(status,detail,type='application/json')=>new Response(type==='application/json'?JSON.stringify({detail}):detail,{status,headers:{'content-type':type}})
const ok=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
describe('attachment upload failures',()=>{
 it('preserves safe CAO JSON 413 and never inserts a path',async()=>{
  const t=setup([error(413,'Image exceeds 10 MiB')]);t.attach();await flush()
  expect(t.note()).toBe('Image exceeds 10 MiB');expect(t.button('Insert path').disabled).toBe(true)
  expect(t.w.caoPasteText).not.toHaveBeenCalled();t.w.close()
 })
 it('explains proxy HTML 413 without rendering or displaying its body',async()=>{
  const t=setup([error(413,'<h1>private proxy detail</h1>','text/html')]);t.attach();await flush()
  expect(t.note()).toContain('server request limit');expect(t.note()).toContain('10 MiB')
  expect(t.note()).not.toContain('private proxy');expect(t.w.document.querySelector('dialog h1')).toBeNull();t.w.close()
 })
 for(const detail of ['Terminal process belongs to a different user; image upload is unavailable.','Cannot verify terminal image directory permissions. Image upload is unavailable for this process.']){
  it('preserves actionable filesystem error: '+detail,async()=>{
   const t=setup([error(409,detail)]);t.attach();await flush();expect(t.note()).toBe(detail)
   expect(t.w.caoPasteText).not.toHaveBeenCalled();t.w.close()
  })
 }
 it('bounds and type-checks error details',async()=>{
  const t=setup([error(409,{unexpected:'object'})]);t.attach();await flush()
  expect(t.note()).toContain('Image request failed (409)');t.w.close()
 })
 it('retry is explicit, confirm is explicit, insertion never submits',async()=>{
  const t=setup([error(413,'limit','text/html'),ok({id:'a'}),ok({path:'/private/a.png'})]);t.attach();await flush()
  expect(t.w.fetch).toHaveBeenCalledTimes(1);expect(t.button('Retry upload').hidden).toBe(false)
  t.button('Retry upload').click();await flush();expect(t.w.fetch).toHaveBeenCalledTimes(2)
  expect(t.w.caoPasteText).not.toHaveBeenCalled();t.button('Insert path').click();await flush()
  expect(t.w.caoPasteText).toHaveBeenCalledExactlyOnceWith('/private/a.png ',{pane:'%1',socket:1})
  expect(t.w.document.querySelector('dialog')).toBeNull();t.w.close()
 })
 it('cancel after failure sends no path and no replay',async()=>{
  const t=setup([error(413,'limit','text/html')]);t.attach();await flush();t.button('Cancel').click();await flush()
  expect(t.w.fetch).toHaveBeenCalledTimes(1);expect(t.w.caoPasteText).not.toHaveBeenCalled();t.w.close()
 })
 it('target change prevents retry after failure',async()=>{
  const t=setup([error(413,'limit','text/html')]);t.attach();await flush();t.w.tmuxState.focusedPane='%2'
  t.button('Retry upload').click();await flush();expect(t.w.fetch).toHaveBeenCalledTimes(1)
  expect(t.note()).toBe('Target changed. Nothing was inserted.');expect(t.w.caoPasteText).not.toHaveBeenCalled();t.w.close()
 })
})
