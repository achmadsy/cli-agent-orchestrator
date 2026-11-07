package tmuxctl

import (
	"context"
	"fmt"
	"io"
)

// sendKeysLimit mirrors libs/tmux-lib/tmux_lib/primitives.py:_SEND_KEYS_LIMIT.
// Texts longer than this go through load-buffer + paste-buffer to avoid ARG_MAX
// and to preserve multi-line behavior identical to the Python implementation.
const sendKeysLimit = 512

// SendText delivers literal text to a pane.
// Default buffer name is "_webui_paste" (matches Python).
func (c *Client) SendText(ctx context.Context, target, text string) error {
	return c.SendTextWithBuf(ctx, target, text, "_webui_paste")
}

func (c *Client) SendTextWithBuf(ctx context.Context, target, text, buf string) error {
	if len(text) > sendKeysLimit {
		return c.pasteText(ctx, target, text, buf)
	}
	_, err := c.Run(ctx, "send-keys", "-t", target, "-l", "--", text)
	return err
}

// SendKey sends a non-literal key spec (e.g. "Enter", "C-c", "Up", "M-x").
func (c *Client) SendKey(ctx context.Context, target, key string) error {
	_, err := c.Run(ctx, "send-keys", "-t", target, key)
	return err
}

// sgrButtonCode maps a semantic button name to its SGR-1006 numeric code.
// Wheel up/down are 64/65 (bit 6 set). Unknown → (0,false).
func sgrButtonCode(button string) (int, bool) {
	switch button {
	case "left":
		return 0, true
	case "middle":
		return 1, true
	case "right":
		return 2, true
	case "wheelup":
		return 64, true
	case "wheeldown":
		return 65, true
	}
	return 0, false
}

// encodeSGRMouse builds an SGR-1006 mouse report: ESC [ < code ; col ; row (M|m),
// M = press/motion, m = release. col/row are 1-based (floored at 1). This is the
// exact byte sequence a real terminal emits for a mouse event, so any TUI in SGR
// mouse mode parses it identically — no per-app adaptation. Pure; unit-tested.
func encodeSGRMouse(code, col, row int, press bool) string {
	if col < 1 {
		col = 1
	}
	if row < 1 {
		row = 1
	}
	suffix := "m"
	if press {
		suffix = "M"
	}
	return fmt.Sprintf("\x1b[<%d;%d;%d%s", code, col, row, suffix)
}

// SendMouseSGR injects a mouse event into the pane's program via send-keys -H
// (raw hex bytes → the program's stdin, exactly like a real terminal's report),
// so yazi/lazygit/htop/less/leaf react with zero per-app code. phase is
// "press"|"release"; wheel events are always a press. Returns an error for an
// unknown button.
func (c *Client) SendMouseSGR(ctx context.Context, target, button string, col, row int, phase string) error {
	code, ok := sgrButtonCode(button)
	if !ok {
		return fmt.Errorf("unknown mouse button %q", button)
	}
	seq := encodeSGRMouse(code, col, row, phase != "release")
	args := []string{"send-keys", "-t", target, "-H"}
	for _, b := range []byte(seq) {
		args = append(args, fmt.Sprintf("%02x", b))
	}
	_, err := c.Run(ctx, args...)
	return err
}

// SendEnter is a convenience for the most common single-key send.
func (c *Client) SendEnter(ctx context.Context, target string) error {
	return c.SendKey(ctx, target, "Enter")
}

func (c *Client) pasteText(ctx context.Context, target, text, buf string) error {
	cmd := c.command(ctx, "load-buffer", "-b", buf, "-")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("load-buffer pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("load-buffer start: %w", err)
	}
	if _, err := io.WriteString(stdin, text); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return fmt.Errorf("load-buffer write: %w", err)
	}
	if err := stdin.Close(); err != nil {
		_ = cmd.Wait()
		return fmt.Errorf("load-buffer close: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("load-buffer wait: %w", err)
	}
	if _, err := c.Run(ctx, "paste-buffer", "-b", buf, "-t", target, "-d", "-p"); err != nil {
		_, _ = c.Run(ctx, "delete-buffer", "-b", buf)
		return fmt.Errorf("paste-buffer: %w", err)
	}
	return nil
}
