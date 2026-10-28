# Multi-agent observation

The app reads the authoritative SessionStore and event log into a tree projection. It never creates a second task owner.

- Traversal follows persisted relations and retains real parent and root IDs.
- Transcript requests must prove ancestry and project membership before reading child data.
- Complete live streams replace matching persisted messages instead of duplicating text.
- Cold and live paths use the same projection. The CLI cannot use renderer state to authorize reads or change agent lifetime.
