// @vitest-environment node
import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {describe,expect,it,vi} from 'vitest'
const root='../../../vendor/tmux-webui/internal/assets/'
const template=readFileSync(new URL(root+'templates/index.html',import.meta.url),'utf8')
const code=readFileSync(new URL(root+'static/js/cao-clipboard.js',import.meta.url),'utf8')
function setup(){
 const dom=new JSDOM(template,{runScripts:'outside-only',url:'http://localhost/terminal/v/test/'}),w=dom.window
 w.TextEncoder=TextEncoder;w.document.getElementById('app').classList.add('cao-direct-active')
 w.tmuxState={focusedPane:'%1',paneEls:{'%1':{screenController:{snapshot:{bracket_paste:false}}}}}
 const send=vi.fn();w.tmuxWs={isConnected:()=>true,connectionId:()=>1,send}
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))}
 w.eval(code);return{w,send,dom}
}
describe('native clipboard transport',()=>{
 it('pastes Unicode once as one no-submit operation',()=>{const{w,send}=setup();w.caoPasteText('hi 文😀');expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toMatchObject({type:'paste',text:'hi 文😀',pane:'%1'});w.close()})
 it('blocks controls and too-large UTF8 without silent transformation',()=>{const{w,send}=setup();w.caoPasteText('bad\x1b[31m');w.caoPasteText('x\r\n');w.caoPasteText('文'.repeat(21000));expect(send).not.toHaveBeenCalled();w.close()})
 it('previews multiline and refuses unknown target paste mode',()=>{const{w,send}=setup();w.caoPasteText('line1\nline2');expect(send).not.toHaveBeenCalled();expect(w.document.querySelector('dialog textarea').value).toBe('line1\nline2');expect([...w.document.querySelectorAll('dialog button')].map(x=>x.textContent)).not.toContain('Paste text');w.close()})
 it('explicitly confirms multiline for supported target, no Enter',()=>{const{w,send}=setup();w.tmuxState.paneEls['%1'].screenController.snapshot.bracket_paste=true;w.caoPasteText('a\nb');const button=[...w.document.querySelectorAll('dialog button')].find(x=>x.textContent==='Paste text');button.click();expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].type).toBe('paste');w.close()})
 it('target switch while confirming cannot paste elsewhere',()=>{const{w,send}=setup();w.tmuxState.paneEls['%1'].screenController.snapshot.bracket_paste=true;w.caoPasteText('a\nb');w.tmuxState.focusedPane='%2';[...w.document.querySelectorAll('dialog button')].find(x=>x.textContent==='Paste text').click();expect(send).not.toHaveBeenCalled();w.close()})
 it('native paste cancels default funnel insertion and dispatches once',()=>{const{w,send}=setup();const funnel=w.document.createElement('input');funnel.id='cao-direct-funnel';w.document.body.append(funnel);const event=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:[],getData:()=> 'text'}});funnel.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(send).toHaveBeenCalledTimes(1);w.close()})
})
