// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
const code=readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/static/js/terminal.js',import.meta.url),'utf8')
function parser(){const d=new JSDOM('',{runScripts:'outside-only'});d.window.eval(code);return d.window.ansiToHtml}
describe('workspace captured ANSI',()=>{
 it('uses the same indexed and basic palette, foreground and background',()=>{const p=parser();expect(p('\x1b[31mX')).toBe(p('\x1b[38;5;1mX'));expect(p('\x1b[41mX')).toBe(p('\x1b[48;5;1mX'))})
 it('normalizes semicolon and colon truecolor including omitted color space',()=>{const p=parser();for(const x of ['38:2:1:2:3','38:2::1:2:3','38:2:0:1:2:3'])expect(p(`\x1b[${x}mX`)).toBe(p('\x1b[38;2;1;2;3mX'))})
 it('consumes private protocols and OSC clipboard without executing HTML',()=>{const p=parser();expect(p('\x1b(B\x1b[?2004h\x1b[>4;2m\x1b[<u\x1b]52;c;SECRET\x07<img>')).toBe('&lt;img&gt;')})
 it('preserves glyphs and selective resets',()=>{const p=parser();const out=p('\x1b[1;3;4;31m\x1b[22;23;24;39m plain');expect(out).toContain('');expect(out).toContain('font-style:italic');expect(out).toMatch(/<\/span> plain$/)})
 it('uses fixed-cell separately licensed symbols only in the workspace',()=>{const d=new JSDOM('',{runScripts:'outside-only'});d.window.__CAO_WORKSPACE__=true;d.window.eval(code);const out=d.window.ansiToHtml('<img>');const root=d.window.document.createElement('div');root.innerHTML=out;expect(root.textContent).toBe('<img>');expect(root.querySelectorAll('.cao-symbol-cell')).toHaveLength(2);expect(root.querySelector('img')).toBeNull();expect(root.querySelector('.cao-symbol-powerline').textContent).toBe('');expect(root.querySelector('.cao-symbol-awesome').textContent).toBe('');d.window.close()})
})
