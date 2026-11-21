"""Bounded, passive replay of the append-only terminal recording for every CLI.

This is rendered terminal history, not a provider's original conversation store.
Historical resizes and text never emitted by a CLI cannot be reconstructed.
"""

import re
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import NamedTuple, Optional

import pyte
from pyte import charsets, modes

MAX_RECORDING_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_CHARS = 1024 * 1024
MAX_HISTORY_ROWS = 12000
REPLAY_TIMEOUT_SECONDS = 4.0
REPLAY_TAIL_BYTES = 256 * 1024
_REPLAY_CHUNK_CHARS = 8192
_CACHE_SIZE = 8
_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = Lock()
_SGR = re.compile(r"\x1b\[[0-9;]*m")
# Retention hints only: these echoed prompts never establish public/private
# ownership. Provider filtering still runs after replay. A changed echo must
# outrank an unchanged banner; a bare/editable prompt is not an echo.
_ECHO = re.compile(r"^\s*(?:User:[ \t]+|You[ \t]+|[❯›»>💫✨][ \t]+|┃[ \t]{2,})(\S.*)$")


def _echo_hint(rows: list[tuple[str, bool]]) -> Optional[str]:
    lines = []
    logical = ""
    for text, wrapped in rows:
        logical += _SGR.sub("", text)
        if not wrapped:
            lines.append(logical.strip())
            logical = ""
    # A trailing prompt has no response beneath it and may still be editable.
    candidates = [
        line
        for index, line in enumerate(lines[:-1])
        if _ECHO.match(line)
        # OpenCode's bottom composer is a bar followed by its heavy lower
        # border, not a submitted echo. Ignore it even if a footer follows.
        and not (
            line.startswith("┃")
            and any(next_line.startswith("╹") for next_line in lines[index + 1 : index + 3])
        )
    ]
    return candidates[-1] if candidates else None


class ReplayLimitExceeded(Exception):
    """Replay exhausted its cooperative time budget; no prefix is publishable."""


class _Char(NamedTuple):
    data: str = " "
    fg: str = "default"
    bg: str = "default"
    bold: bool = False
    italics: bool = False
    underscore: bool = False
    strikethrough: bool = False
    reverse: bool = False
    blink: bool = False
    sgr: str = ""
    dim: bool = False
    fg_code: str = ""
    bg_code: str = ""


class _RecordingScreen(pyte.Screen):
    def __init__(self, columns: int, rows: int, *, ansi: bool = False):
        self._history: list[tuple[str, bool]] = []
        # Keep the row itself: object ids are reused after a screen scroll.
        self._wrapped: dict[int, dict] = {}
        self._drawing = False
        self._alternate = False
        self._repainting = False
        self._scrolled: list[tuple[str, bool]] = []
        self._settled: list[tuple[str, bool]] = []
        self._row_cache: dict[int, tuple[dict, tuple[str, bool]]] = {}
        self._ansi = ansi
        self._ascii_attrs = None
        self._ascii_cells: dict[str, _Char] = {}
        self.truncated = False
        super().__init__(columns, rows)

    @property
    def default_char(self):
        return _Char(reverse=modes.DECSCNM in self.mode)

    def select_graphic_rendition(self, *attrs: int) -> None:
        # Preserve effective styling, including dim (which pyte drops), not
        # the unbounded sequence of every historical SGR. Canonical separate
        # codes retain the markers used by provider ownership classifiers.
        previous = self.cursor.attrs
        dim, fg, bg = previous.dim, previous.fg_code, previous.bg_code
        values = list(attrs or (0,))
        index = 0
        while index < len(values):
            value = values[index]
            if value == 0:
                dim, fg, bg = False, "", ""
            elif value == 2:
                dim = True
            elif value == 22:
                dim = False
            elif value in (38, 48):
                count = 3 if values[index + 1 : index + 2] == [5] else 5
                group = values[index : index + count]
                if len(group) == count:
                    code = "\x1b[" + ";".join(map(str, group)) + "m"
                    if value == 38:
                        fg = code
                    else:
                        bg = code
                    index += count - 1
            elif 30 <= value <= 37 or 90 <= value <= 97:
                fg = f"\x1b[{value}m"
            elif value == 39:
                fg = ""
            elif 40 <= value <= 47 or 100 <= value <= 107:
                bg = f"\x1b[{value}m"
            elif value == 49:
                bg = ""
            index += 1
        super().select_graphic_rendition(*attrs)
        current = self.cursor.attrs
        style = (
            "".join(
                f"\x1b[{code}m"
                for code, active in (
                    (1, current.bold),
                    (2, dim),
                    (3, current.italics),
                    (4, current.underscore),
                    (7, current.reverse),
                    (9, current.strikethrough),
                )
                if active
            )
            + fg
            + bg
        )
        self.cursor.attrs = current._replace(sgr=style, dim=dim, fg_code=fg, bg_code=bg)

    def _row(self, row) -> tuple[str, bool]:
        wrapped = id(row) in self._wrapped
        # pyte rows are sparse; do not materialize hundreds of blank cells
        # for every cursor show/hide redraw.
        width = self.columns if wrapped else min(max(row, default=-1) + 1, self.columns)
        cells = [row[x] for x in range(width)]
        if not wrapped:
            while cells and cells[-1].data.isspace():
                cells.pop()
        parts = []
        style = None
        for cell in cells:
            if self._ansi and cell.sgr != style:
                parts.append("\x1b[0m" + cell.sgr)
                style = cell.sgr
            parts.append(cell.data)
        if self._ansi and parts:
            parts.append("\x1b[0m")
        return "".join(parts), wrapped

    def _append(self, rows: list[tuple[str, bool]], *, frame: bool = False) -> None:
        while rows and not rows[-1][0]:
            rows.pop()
        if not rows:
            return
        overlap = 0
        if frame:
            for length in range(min(len(rows), len(self._history)), 0, -1):
                if self._history[-length:] == rows[:length]:
                    overlap = length
                    break
        self._history.extend(rows[overlap:])
        if len(self._history) > MAX_HISTORY_ROWS:
            del self._history[:-MAX_HISTORY_ROWS]
            self.truncated = True

    def _frame(self) -> list[tuple[str, bool]]:
        frame = list(self._scrolled)
        current_cache = {}
        for y in range(self.lines):
            row = self.buffer[y]
            cached = self._row_cache.get(id(row))
            rendered = cached[1] if cached is not None and y not in self.dirty else self._row(row)
            current_cache[id(row)] = (row, rendered)
            frame.append(rendered)
        self._row_cache = current_cache
        self.dirty.clear()
        while frame and not re.sub(r"\x1b\[[0-9;]*m", "", frame[0][0]).strip():
            frame.pop(0)
        return frame

    def _settle_frame(self) -> None:
        frame = self._frame()
        while frame and not frame[-1][0]:
            frame.pop()
        if not frame:
            return
        # A changed echoed user prompt retains the previous screen even when
        # its banner is unchanged. With no echo evidence, keep the conservative
        # overlap heuristic. Neither hint establishes publication ownership.
        if self._settled:
            # Colour/spinner changes do not make a new conversation screen.
            previous = re.sub(r"\x1b\[[0-9;]*m", "", self._settled[0][0])
            current = re.sub(r"\x1b\[[0-9;]*m", "", frame[0][0])
            same_leading_row = previous.startswith(current) or current.startswith(previous)
            # Echo hints only resolve the ambiguous fixed-banner case. In a
            # scrolling/reflowing capture an echo can become a fragment of
            # itself; treating that as a new turn archives every partial redraw.
            fixed_banner = previous == current and not _ECHO.match(previous)
            retain_previous = False
            if fixed_banner:
                previous_echo, current_echo = _echo_hint(self._settled), _echo_hint(frame)
                retain_previous = (
                    previous_echo is not None
                    and current_echo is not None
                    and previous_echo != current_echo
                    and not previous_echo.startswith(current_echo)
                    and not current_echo.startswith(previous_echo)
                )
            elif not same_leading_row:
                previous_rows = {
                    _SGR.sub("", text).strip() for text, _ in self._settled if text.strip()
                }
                current_rows = {_SGR.sub("", text).strip() for text, _ in frame if text.strip()}
                overlap = len(previous_rows & current_rows) / max(
                    1, min(len(previous_rows), len(current_rows))
                )
                retain_previous = overlap < 0.15
            if retain_previous:
                self._append(self._settled, frame=True)
        self._settled = frame

    def _archive_frame(self) -> None:
        self._settle_frame()
        self._append(self._settled, frame=True)
        self._settled = []
        self._scrolled.clear()

    def draw(self, data: str) -> None:
        self._drawing = True
        try:
            charset = self.g1_charset if self.charset else self.g0_charset
            if (
                not data
                or not data.isascii()
                or not data.isprintable()
                or modes.IRM in self.mode
                or charset != charsets.LAT1_MAP
            ):
                super().draw(data)
                return
            # ASCII cells are immutable. Reuse at most 95 cells for the current
            # style instead of allocating one namedtuple per painted character.
            # Non-ASCII, insert mode and translated charsets stay with pyte.
            attrs = self.cursor.attrs
            if attrs != self._ascii_attrs:
                self._ascii_attrs = attrs
                self._ascii_cells = {}
            cells = self._ascii_cells
            for character in data:
                if self.cursor.x == self.columns:
                    if modes.DECAWM in self.mode:
                        self.dirty.add(self.cursor.y)
                        self.carriage_return()
                        self.linefeed()
                    else:
                        self.cursor.x -= 1
                cell = cells.get(character)
                if cell is None:
                    cell = cells[character] = attrs._replace(data=character)
                self.buffer[self.cursor.y][self.cursor.x] = cell
                self.cursor.x += 1
            self.dirty.add(self.cursor.y)
        finally:
            self._drawing = False

    def linefeed(self) -> None:
        if self._drawing and modes.DECAWM in self.mode:
            row = self.buffer[self.cursor.y]
            self._wrapped[id(row)] = row
        super().linefeed()

    def index(self) -> None:
        top, bottom = self.margins or (0, self.lines - 1)
        if self.cursor.y == bottom:
            row = self.buffer[top]
            rendered = self._row(row)
            if self._alternate:
                # Scrolling inside a TUI repaint is not append-only history.
                # Retain it only as part of this frame, not on every redraw.
                self._scrolled.append(rendered)
                if len(self._scrolled) > MAX_HISTORY_ROWS:
                    del self._scrolled[:-MAX_HISTORY_ROWS]
                    self.truncated = True
            else:
                self._append([rendered])
            self._wrapped.pop(id(row), None)
        super().index()

    def erase_in_display(self, how: int = 0, *args, **kwargs) -> None:
        if how in (2, 3):
            self._archive_frame()
            self._wrapped.clear()
        else:
            affected = range(self.cursor.y, self.lines) if how == 0 else range(self.cursor.y + 1)
            for y in affected:
                self._wrapped.pop(id(self.buffer[y]), None)
        super().erase_in_display(how, *args, **kwargs)

    def erase_in_line(self, how: int = 0, *args, **kwargs) -> None:
        self._wrapped.pop(id(self.buffer[self.cursor.y]), None)
        super().erase_in_line(how, *args, **kwargs)

    def reset(self) -> None:
        if hasattr(self, "mode"):
            self._archive_frame()
        self._wrapped.clear()
        super().reset()
        self.cursor.attrs = self.default_char

    def set_mode(self, *values: int, **kwargs) -> None:
        if kwargs.get("private"):
            if any(value in (47, 1047, 1049) for value in values):
                self._archive_frame()
                self._alternate = True
                self.buffer.clear()
                self._wrapped.clear()
                self.cursor_position()
            if 25 in values:
                if self._alternate and self._repainting:
                    self._settle_frame()
                self._repainting = False
            if 2026 in values and self._alternate:
                self._scrolled.clear()
        super().set_mode(*values, **kwargs)

    def reset_mode(self, *values: int, **kwargs) -> None:
        if kwargs.get("private"):
            if any(value in (47, 1047, 1049) for value in values):
                self._archive_frame()
                self._alternate = False
                self.buffer.clear()
                self._wrapped.clear()
                self.cursor_position()
            if 2026 in values and self._alternate:
                self._settle_frame()
            if 25 in values and self._alternate and not self._repainting:
                # A hide/show bracket is one atomic redraw. Only the newest
                # frame's scrolled prefix belongs to the resulting viewport.
                self._scrolled.clear()
                self._repainting = True
        super().reset_mode(*values, **kwargs)

    def report_device_status(self, *args, **kwargs) -> None:
        pass  # Passive: no reply or key is sent to the live pane.

    def report_device_attributes(self, *args, **kwargs) -> None:
        pass

    def text(self) -> str:
        self._archive_frame()
        return "".join(text + ("" if wrapped else "\n") for text, wrapped in self._history).rstrip()


def render_recording(raw: str, *, columns: int = 220, rows: int = 50, ansi: bool = False) -> dict:
    """Replay a bounded tail using the supplied (not historical) geometry."""
    columns = max(20, min(int(columns), 500))
    rows = max(3, min(int(rows), 200))
    screen = _RecordingScreen(columns, rows, ansi=ansi)
    stream = pyte.Stream(screen)
    deadline = monotonic() + REPLAY_TIMEOUT_SECONDS
    for offset in range(0, len(raw), _REPLAY_CHUNK_CHARS):
        if monotonic() >= deadline:
            raise ReplayLimitExceeded()
        stream.feed(raw[offset : offset + _REPLAY_CHUNK_CHARS])
    if monotonic() >= deadline:
        raise ReplayLimitExceeded()
    output = screen.text()
    if monotonic() >= deadline:
        raise ReplayLimitExceeded()
    return {
        "output": output[-MAX_OUTPUT_CHARS:],
        "truncated": screen.truncated or len(output) > MAX_OUTPUT_CHARS,
    }


def read_recording(
    path: Path, *, columns: int = 220, rows: int = 50, ansi: bool = False
) -> Optional[dict]:
    """Read a bounded tail; cache unchanged files, never an active screen object."""
    try:
        stat = path.stat()
        key = (
            str(path.resolve()),
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            columns,
            rows,
            ansi,
            MAX_RECORDING_BYTES,
            MAX_OUTPUT_CHARS,
            REPLAY_TIMEOUT_SECONDS,
            REPLAY_TAIL_BYTES,
        )
        with _cache_lock:
            if key in _cache:
                _cache.move_to_end(key)
                return dict(_cache[key])
        with path.open("rb") as handle:
            size = stat.st_size
            offset = max(0, size - MAX_RECORDING_BYTES)
            handle.seek(offset)
            payload = handle.read(min(size, MAX_RECORDING_BYTES))
    except OSError:
        return None
    if not payload:
        return None
    try:
        result = render_recording(
            payload.decode("utf-8", errors="replace"), columns=columns, rows=rows, ansi=ansi
        )
    except ReplayLimitExceeded:
        # Discard the partially replayed prefix; it does not contain the latest
        # output. Retry once from a smaller *tail* using a fresh screen/parser.
        tail = payload[-REPLAY_TAIL_BYTES:]
        if len(tail) >= len(payload):
            raise
        result = render_recording(
            tail.decode("utf-8", errors="replace"), columns=columns, rows=rows, ansi=ansi
        )
        result["truncated"] = True
        result["limited_reason"] = "replay_budget"
    result["truncated"] |= offset > 0
    with _cache_lock:
        _cache[key] = dict(result)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return result
