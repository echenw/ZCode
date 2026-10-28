# Agent message board

One optional board owner is shared by every agent in one root registry. The existing Runtime owns graph, permissions and active turns.

- Local writes commit through the root SessionStore before publish; memory mode performs no persistence I/O. Existing IDs are preserved.
- Caller membership is checked after graph hydration. Read-only profiles cannot create channels or posts; the Tool executor retains dynamic permission checks.
- Host supplied request IDs make identical posts idempotent. Conflicting reuse fails.
- Notifications target only the matching active turn, never wake an idle agent and never acknowledge reading.
- Remote transport is supplied by the Host. Missing transport disables the optional board without a memory fallback.

Behavior tests live in core/tests/multi-agent-message-board.test.ts. External service acceptance is a separate gate.
