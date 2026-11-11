// ANSI parser for terminal screen frames. Two sources feed this:
// capture-pane -e grids (mostly SGR) and the raw-stream fallback
// (/terminals/{id}/output), which contains the agent TUI's protocol-init
// burst — private modes (bracketed paste ?2004, mouse ?1000/?1002/?1003/
// ?1006), kitty/modifyOtherKeys (CSI < u, CSI > 5 u), charset (ESC(B) and
// OSC titles. All non-SGR sequences carry no text and are consumed.

// Full ECMA-48 CSI: parameter bytes 0-9;:<=>?, intermediate bytes space-/,
// final byte @-~. `m[1]` may span both parameter and intermediate bytes.
const CSI = /\x1b\[([0-9;:<=>?]*[ -/]*)([@-~])/g;
// OSC strings run to BEL or ST (ESC \); other non-CSI escapes are ESC +
// optional intermediate bytes (charset: ESC ( B) + one final byte; a lone
// trailing ESC byte is the start of a sequence the FIFO split across lines.
const NON_CSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]|\x1b/g;
// SGR state runs only on plain digit/semicolon params — private sequences
// like CSI > 4;2 m must be consumed silently, never parsed as colour.
const SGR_PARAMS = /^[0-9;]*$/;

function stripNonCsi(line) {
  return line.replace(NON_CSI, "");
}

export function parseAnsiLine(line) {
  const segs = [];
  let fg = null;
  let bold = false;
  let last = 0;
  const flush = (text) => {
    if (!text) return;
    const prev = segs[segs.length - 1];
    if (prev && prev.fg === fg && prev.bold === bold) prev.text += text;
    else segs.push({ text, fg, bold });
  };
  CSI.lastIndex = 0;
  let m;
  while ((m = CSI.exec(line))) {
    flush(stripNonCsi(line.slice(last, m.index)));
    last = CSI.lastIndex;
    if (m[2] === "m" && SGR_PARAMS.test(m[1])) {
      const codes = m[1] === "" ? [0] : m[1].split(";").map((n) => parseInt(n, 10));
      for (const code of codes) {
        if (code === 0) { fg = null; bold = false; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code >= 30 && code <= 37) fg = code - 30;
        else if (code >= 90 && code <= 97) fg = code - 90 + 8;
        else if (code === 39) fg = null;
      }
    }
    // non-SGR CSI (cursor moves, private modes, kitty) and private-param
    // 'm' (modifyOtherKeys >4;2m): consumed, emits no text and no style
  }
  flush(stripNonCsi(line.slice(last)));
  if (segs.length === 0) return [{ text: "", fg: null, bold: false }];
  return segs;
}
