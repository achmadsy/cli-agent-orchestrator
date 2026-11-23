"""Conservative parser for Claude Code's single-question, single-choice picker.

This is presentation parsing, not permission detection. Anything other than the
complete supported picker is left to the live terminal. Never parse scrollback.
"""

import re
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class QuestionOption:
    number: int
    label: str
    description: str


@dataclass(frozen=True)
class ClaudeQuestion:
    header: str
    question: str
    options: tuple[QuestionOption, ...]
    custom_number: int
    selected: int
    custom_text: str

    def identity(self) -> tuple:
        # Cursor movement and an operator typing do not change the question.
        return (self.header, self.question, self.options, self.custom_number)


_OPTION = re.compile(r"^\s*([❯>])?\s*(\d+)\.\s+(.+?)\s*$")
_FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel"


def parse_question(screen: str) -> Optional[ClaudeQuestion]:
    """Return only a complete one-question radio picker, or None (fail closed)."""
    lines = screen.rstrip().splitlines()
    if not lines or lines[-1].strip() != _FOOTER or len(screen) > 65536:
        return None
    # A single header and no submit tab distinguishes the supported one-question
    # flow from multi-question review, approval, plan and multi-select dialogs.
    headers = [i for i, line in enumerate(lines) if "☐" in line or "☑" in line]
    if len(headers) != 1:
        return None
    header_index = headers[0]
    header = lines[header_index].strip()
    if not re.fullmatch(r"☐\s+[^☐☑]+", header) or "Submit" in header:
        return None
    content = lines[header_index + 1 : -1]
    matches = [(i, _OPTION.match(line)) for i, line in enumerate(content)]
    matches = [(i, m) for i, m in matches if m]
    if not matches or not 4 <= len(matches) <= 6:
        return None
    if [int(m[2]) for _, m in matches] != list(range(1, len(matches) + 1)):
        return None
    selected = [int(m[2]) for _, m in matches if m[1]]
    if len(selected) != 1:
        return None
    custom_index, custom = matches[-2]
    chat_index, chat = matches[-1]
    if chat[3] != "Chat about this":
        return None
    # The trailing period is significant: the multi-select placeholder has none.
    custom_label = custom[3]
    custom_text = "" if custom_label == "Type something." else custom_label
    if custom_text and selected[0] != int(custom[2]):
        return None
    # A non-empty custom row is recognized only during our revalidation, never
    # offered as an initially answerable question by the service.
    question = "\n".join(
        line.strip().lstrip("│").strip() for line in content[: matches[0][0]]
    ).strip()
    if not question or any("─" * 5 in line for line in question.splitlines()):
        return None
    options = []
    for n, (start, match) in enumerate(matches[:-2]):
        end = matches[n + 1][0]
        description = "\n".join(line.strip() for line in content[start + 1 : end]).strip()
        if any(mark in description for mark in ("☐", "☑", "─" * 5)):
            return None
        options.append(QuestionOption(int(match[2]), match[3], description))
    # Nothing hidden between the custom row and the chat separator, nor after it.
    extras = content[custom_index + 1 : chat_index] + content[chat_index + 1 :]
    if any(line.strip() and not re.fullmatch(r"─+", line.strip()) for line in extras):
        return None
    return ClaudeQuestion(
        header[1:].strip(), question, tuple(options), int(custom[2]), selected[0], custom_text
    )
