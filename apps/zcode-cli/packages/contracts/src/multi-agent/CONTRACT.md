# Multi-Agent V2 wire contract

The public contract comprises six operations, strict input/output schemas and a shared provider-safe name mapping. Logical namespaces retain the upstream 1-64 character range; wire encoding does not change path identity or grant permissions. All consumers use the same mapping function.

This module owns no running state and performs no tool execution. Unknown input fields are rejected by runtime validation. Registration gates remove disabled tools; prompts cannot grant them back. Core owns lifecycle, persistence and usage accounting.

Legacy Agent/SendMessage/TaskOutput/TaskStop compatibility belongs to the same Core owner, not a second task registry here.

Core's root registry assigns a unique, stable display nickname to each identity. Nicknames are optional in old stored graphs and are populated on restoration; paths and IDs remain the addressing authority. Message display metadata is additive and cannot change mailbox admission, wake-up or cancellation semantics.
