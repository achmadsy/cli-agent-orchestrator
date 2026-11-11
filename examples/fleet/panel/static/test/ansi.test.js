import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnsiLine } from "../ansi.js";

test("plain text → one default segment", () => {
  assert.deepEqual(parseAnsiLine("hello"), [{ text: "hello", fg: null, bold: false }]);
});

test("green then reset", () => {
  const segs = parseAnsiLine("\x1b[32mok\x1b[0mbye");
  assert.deepEqual(segs, [
    { text: "ok", fg: 2, bold: false },
    { text: "bye", fg: null, bold: false },
  ]);
});

test("bold + colour", () => {
  const segs = parseAnsiLine("\x1b[1;31mERR\x1b[0m");
  assert.deepEqual(segs, [{ text: "ERR", fg: 1, bold: true }]);
});

test("strips unknown CSI (cursor moves) without emitting text", () => {
  const segs = parseAnsiLine("a\x1b[2Kb");
  assert.deepEqual(segs, [{ text: "ab", fg: null, bold: false }]);
});

test("bright foreground (90-97) maps to palette 8-15", () => {
  const segs = parseAnsiLine("\x1b[90mgrey\x1b[97mwhite");
  assert.deepEqual(segs, [
    { text: "grey", fg: 8, bold: false },
    { text: "white", fg: 15, bold: false },
  ]);
});

test("bold-off (22) clears bold without touching colour", () => {
  const segs = parseAnsiLine("\x1b[1;33mhot\x1b[22mcool");
  assert.deepEqual(segs, [
    { text: "hot", fg: 3, bold: true },
    { text: "cool", fg: 3, bold: false },
  ]);
});

test("fg-reset (39) drops colour but keeps bold", () => {
  const segs = parseAnsiLine("\x1b[1;34mblue\x1b[39mplain");
  assert.deepEqual(segs, [
    { text: "blue", fg: 4, bold: true },
    { text: "plain", fg: null, bold: true },
  ]);
});

test("adjacent runs with identical style merge into one segment", () => {
  const segs = parseAnsiLine("\x1b[31ma\x1b[31mb");
  assert.deepEqual(segs, [{ text: "ab", fg: 1, bold: false }]);
});

// Raw-stream fallback content: the agent TUI's protocol-init burst.
test("private-mode set/reset sequences are consumed (bracketed paste, mouse)", () => {
  for (const seq of ["\x1b[?2004h", "\x1b[?2004l", "\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?1006h"]) {
    assert.deepEqual(parseAnsiLine(`${seq}ok`), [{ text: "ok", fg: null, bold: false }], seq);
  }
});

test("kitty/modifyOtherKeys sequences are consumed, never parsed as SGR", () => {
  for (const seq of ["\x1b[<u", "\x1b[>5u", "\x1b[>4;2m", "\x1b[=u"]) {
    assert.deepEqual(parseAnsiLine(`${seq}ok`), [{ text: "ok", fg: null, bold: false }], seq);
  }
  // >4;2m must not leak style: text after it stays default even mid-line.
  assert.deepEqual(
    parseAnsiLine("\x1b[>4;2m\x1b[32mok"),
    [{ text: "ok", fg: 2, bold: false }],
  );
});

test("charset selection ESC(B and single-char escapes are consumed", () => {
  assert.deepEqual(parseAnsiLine("\x1b(B❯ ls"), [{ text: "❯ ls", fg: null, bold: false }]);
  assert.deepEqual(parseAnsiLine("\x1bM\x1b7ok"), [{ text: "ok", fg: null, bold: false }]);
});

test("OSC title strings end at BEL or ST", () => {
  assert.deepEqual(
    parseAnsiLine("\x1b]0;title\x07ok"),
    [{ text: "ok", fg: null, bold: false }],
  );
  assert.deepEqual(
    parseAnsiLine("\x1b]2;tab\x1b\\ok"),
    [{ text: "ok", fg: null, bold: false }],
  );
});

test("a lone trailing ESC fragment from a cross-line split is dropped", () => {
  assert.deepEqual(parseAnsiLine("ok\x1b"), [{ text: "ok", fg: null, bold: false }]);
});

test("the reported fleet burst renders as clean prompt text", () => {
  const burst = "\x1b(B\x1b[?2004h\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h ❯ ls";
  assert.deepEqual(parseAnsiLine(burst), [{ text: " ❯ ls", fg: null, bold: false }]);
});

test("SGR still colours around consumed protocol sequences", () => {
  assert.deepEqual(
    parseAnsiLine("\x1b[32m\x1b[?2004hok\x1b[0m\x1b(Bbye"),
    [
      { text: "ok", fg: 2, bold: false },
      { text: "bye", fg: null, bold: false },
    ],
  );
});
