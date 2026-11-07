package ws

import "testing"

// TestDecideKey pins the pure prefix FSM core (prefix_fsm.go). It covers all
// five cases of Py server.py:697-734's state machine plus the prefixWaiting
// reset and the named-key default fall-through — no live tmux (the tx/pc side
// effects live in handleKeyWithFSM, which just dispatches on this decision).
func TestDecideKey(t *testing.T) {
	const prefix = "C-b"

	cases := []struct {
		name          string
		key           string
		hasMods       bool
		combo         string
		prefixWaiting bool
		wantAct       fsmAction
		wantWaiting   bool
	}{
		// Case 0: empty key is ignored and leaves the FSM state untouched.
		{"empty key while idle", "", false, "", false, fsmNoop, false},
		{"empty key while waiting keeps waiting", "", false, "", true, fsmNoop, true},

		// Case 1: prefix-waiting consumes the next key and exits prefix mode.
		{"waiting consumes bound key", "c", false, "c", true, fsmConsumePrefix, false},
		{"waiting consumes even the prefix key itself", "C-b", true, "C-b", true, fsmConsumePrefix, false},
		{"waiting resets after a modifier combo", "x", true, "C-x", true, fsmConsumePrefix, false},

		// Case 2: the prefix key press arms prefix mode.
		{"prefix key arms waiting", "b", true, "C-b", false, fsmEnterPrefix, true},

		// Case 3: modifiers present → interpreted combo.
		{"ctrl combo sends combo", "a", true, "C-a", false, fsmSendCombo, false},

		// Case 4: single rune, no modifiers → literal text.
		{"bare symbol sends literal", "$", false, "$", false, fsmSendLiteral, false},
		{"single letter sends literal", "z", false, "z", false, fsmSendLiteral, false},
		{"multibyte single rune sends literal", "字", false, "字", false, fsmSendLiteral, false},

		// Case 5: named multi-rune key, no modifiers → send by name (default).
		{"named key falls through to send-named", "Up", false, "Up", false, fsmSendNamed, false},
		{"tab falls through to send-named", "Tab", false, "Tab", false, fsmSendNamed, false},
	}

	for _, tc := range cases {
		act, next := decideKey(tc.key, tc.hasMods, tc.combo, prefix, tc.prefixWaiting)
		if act != tc.wantAct {
			t.Errorf("%s: decideKey action = %d, want %d", tc.name, act, tc.wantAct)
		}
		if next != tc.wantWaiting {
			t.Errorf("%s: decideKey nextWaiting = %v, want %v", tc.name, next, tc.wantWaiting)
		}
	}
}

// TestDecideKeyPrefixWaitingResets makes the reset invariant explicit: whatever
// the second keystroke is, prefix-waiting must clear (a stuck prefixWaiting
// would swallow every subsequent keystroke as a binding lookup).
func TestDecideKeyPrefixWaitingResets(t *testing.T) {
	for _, key := range []string{"c", "$", "Up", "C-b", ""} {
		combo := key
		_, next := decideKey(key, false, combo, "C-b", true)
		if key == "" {
			if !next {
				t.Errorf("empty key must not disturb prefixWaiting; got reset")
			}
			continue
		}
		if next {
			t.Errorf("key %q: prefixWaiting did not reset", key)
		}
	}
}
