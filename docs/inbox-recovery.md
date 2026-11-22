# Inbox history after restart and conversation recovery

Inbox messages are persisted in CAO's SQLite database, keyed by the original
terminal ID. Restarting only `cao-server` does not clear them. Resuming a native
provider conversation in a **new CAO terminal** is different: native conversation
history does not contain the CAO inbox registry, so the new terminal otherwise
starts with an empty inbox view.

## Read-only recovery history

The Inbox panel requests `include_history=true` as well as the existing
`latest=true&include_sent=true` options. Historical messages are included only
when an operator has explicitly established a durable link in the server-owned
`inbox_history_links` table. No linkage is inferred from a reused session name,
editable terminal metadata, or native conversation ID alone.

After independently verifying the predecessor and successor belong to the same
recovered conversation, an operator can use the internal database helper
`link_inbox_history(successor_terminal_id, predecessor_terminal_id)` in the
correct node's installed CAO environment. This helper is deliberately not
exposed as an agent tool or public API. It validates both registry identities,
is idempotent for the same pair, rejects relinking and cycles, and commits the
link to the existing SQLite database. The link table is created additively by
normal `init_db()` startup; no existing message rows are rewritten or copied.
Back up the database and verify the exact pair before an operational repair.

The read result combines current and predecessor rows before applying status
filters, newest/oldest ordering, and the result limit. Original message IDs,
sender/receiver IDs, channels, timestamps, and statuses remain unchanged. A
historical row carries `history_terminal_id`, which the UI uses for direction
and an explicit “History from … (not requeued)” label.

**History is not delivery.** All queued-delivery queries continue to use the
exact current receiver ID with no history expansion. Old pending messages remain
pending for their original identity; linking history never delivers or transfers
them. Any decision to resend interrupted work requires separate review and user
approval. A plain server restart with the same terminal ID needs no link.

Native transcript recovery, terminal process recovery, and CAO inbox history are
separate concerns. Verify all three when recovering a lost process; success in
one does not establish success in the others.
