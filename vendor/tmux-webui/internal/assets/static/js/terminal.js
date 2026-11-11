/**
 * terminal.js — ANSI-to-HTML parser (full SGR: 16/256/TrueColor)
 */

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ANSI16 = {
  30:'#555555',31:'#f87171',32:'#4ade80',33:'#fbbf24',34:'#60a5fa',35:'#c084fc',36:'#22d3ee',37:'#d4d4d4',
  90:'#737373',91:'#fca5a5',92:'#86efac',93:'#fde68a',94:'#93c5fd',95:'#d8b4fe',96:'#67e8f9',97:'#f5f5f5',
  40:'#555555',41:'#dc2626',42:'#16a34a',43:'#ca8a04',44:'#2563eb',45:'#9333ea',46:'#0891b2',47:'#d4d4d4',
  100:'#737373',101:'#fca5a5',102:'#86efac',103:'#fde68a',104:'#93c5fd',105:'#d8b4fe',106:'#67e8f9',107:'#f5f5f5',
};

const PAL256 = (() => {
  const p = [];
  const std = Array.from({length:8},(_,i)=>ANSI16[30+i]);
  const bri = Array.from({length:8},(_,i)=>ANSI16[90+i]);
  for (let i=0;i<8;i++) { ANSI16[40+i]=std[i]; ANSI16[100+i]=bri[i]; }
  for (let i = 0; i < 8; i++) p[i] = std[i];
  for (let i = 0; i < 8; i++) p[i+8] = bri[i];
  for (let i = 0; i < 216; i++) {
    const r = i/36|0, g = (i%36)/6|0, b = i%6;
    p[16+i] = '#' + (r?r*40+55:0).toString(16).padStart(2,'0')
                  + (g?g*40+55:0).toString(16).padStart(2,'0')
                  + (b?b*40+55:0).toString(16).padStart(2,'0');
  }
  for (let i = 0; i < 24; i++) {
    const v = (i*10+8).toString(16).padStart(2,'0');
    p[232+i] = '#' + v + v + v;
  }
  return p;
})();

function terminalTextHtml(text) {
  const escaped = escHtml(text);
  if (!window.__CAO_WORKSPACE__) return escaped;
  // CSS fixes each supported symbol to the base font cell without merging or
  // altering separately licensed font binaries. No terminal text becomes markup.
  return escaped.replace(/[---]/g, glyph => {
    const family = glyph.charCodeAt(0) < 0xED00 ? 'powerline' : 'awesome';
    return '<span class="cao-symbol-cell"><span class="cao-symbol-' + family + '">' + glyph + '</span></span>';
  });
}

function ansiToHtml(str) {
  // Consume protocols, never execute OSC clipboard/links or private modes.
  str = str.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  str = str.replace(/\x1b\[([0-9;:<=>?]*[ -/]*)([@-~])/g, (raw, params, final) => final === 'm' && /^[0-9;:]*$/.test(params) ? raw : '');
  str = str.replace(/\x1b(?!\[)[ -/]*[0-~]|\x1b$/g, '');
  // Normalize common ISO colon color forms, including omitted color space.
  str = str.replace(/\x1b\[([0-9;:]*)m/g, (_, params) => '\x1b[' + params.replace(/(38|48):2:(?:0:|:)?(\d+):(\d+):(\d+)/g, '$1;2;$2;$3;$4').replace(/(38|48):5:(\d+)/g, '$1;5;$2').replace(/4:[1-5]/g, '4') + 'm');

  let fg = '', bg = '', bold = false, dim = false, italic = false,
      underline = false, strike = false, inverse = false;
  let html = '', spanOpen = false, last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;

  function emitSpan() {
    if (spanOpen) { html += '</span>'; spanOpen = false; }
    const styles = [];
    let eFg = fg, eBg = bg;
    if (inverse) { eFg = bg || 'var(--bg)'; eBg = fg || 'var(--text)'; }
    if (eFg) styles.push('color:' + eFg);
    if (eBg) styles.push('background:' + eBg);
    if (bold) styles.push('font-weight:bold');
    if (dim) styles.push('opacity:.6');
    if (italic) styles.push('font-style:italic');
    if (underline) styles.push('text-decoration:underline');
    if (strike) styles.push('text-decoration:line-through');
    if (styles.length) { html += '<span style="' + styles.join(';') + '">'; spanOpen = true; }
  }

  while ((m = re.exec(str)) !== null) {
    html += terminalTextHtml(str.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = (m[1] || '0').split(';').map(Number);
    let i = 0;
    while (i < codes.length) {
      const c = codes[i];
      if (c === 0) { fg='';bg='';bold=false;dim=false;italic=false;underline=false;strike=false;inverse=false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 7) inverse = true;
      else if (c === 9) strike = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c === 27) inverse = false;
      else if (c === 29) strike = false;
      else if (c >= 30 && c <= 37) fg = ANSI16[c];
      else if (c === 38) {
        if (codes[i+1] === 5 && codes.length > i+2) { fg = PAL256[codes[i+2]] || ''; i += 2; }
        else if (codes[i+1] === 2 && codes.length > i+4) { fg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; }
      }
      else if (c === 39) fg = '';
      else if (c >= 40 && c <= 47) bg = ANSI16[c];
      else if (c === 48) {
        if (codes[i+1] === 5 && codes.length > i+2) { bg = PAL256[codes[i+2]] || ''; i += 2; }
        else if (codes[i+1] === 2 && codes.length > i+4) { bg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; }
      }
      else if (c === 49) bg = '';
      else if (c >= 90 && c <= 97) fg = ANSI16[c];
      else if (c >= 100 && c <= 107) bg = ANSI16[c];
      i++;
    }
    emitSpan();
  }
  html += terminalTextHtml(str.slice(last));
  if (spanOpen) html += '</span>';
  return html;
}

// Export for use in app.js
window.ansiToHtml = ansiToHtml;
window.escHtml = escHtml;
