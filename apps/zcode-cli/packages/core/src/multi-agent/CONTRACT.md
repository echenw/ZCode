# Multi-Agent V2 controller

This module implements collaboration commands over the existing RuntimeTaskRegistry. The registry is the single owner of agent identities, execution/residency state, mailboxes and reported usage. Session-scoped views isolate ordinary task enumeration and branch generations.

Admission reserves path and capacity before creating a child. Setup failure releases its reservation. Accepted children own their cancellation lifecycle. QueueOnly does not wake idle agents; TriggerTurn restores the existing identity. Wait subscribes before checking activity and does not return mailbox bodies. Every target is checked against the caller's root session.

Callers use index.ts or contract.ts. Runtime binds models, roles, permissions and the existing Store. Host/CLI/Desktop consume durable events and projections; continuous desktop delivery and replayable mobile delivery share the same facts. A process restart cannot treat a historical running row as a live Runtime.

Reported provider usage drives budget accounting; unreported and in-flight tokens are not presented as a known absolute cost bound. Runtime tests and the tool change chain define the detailed ordering and recovery contract.

The existing Runtime cancellation API also accepts explicit task/subtree/tree scopes. It validates membership in this root, selects existing Registry entries and calls their original task controls. Only Root may stop the whole tree, including its current execution. Ordinary Main Stop keeps its original scope. Batch outcomes preserve identities and report partial failures; no second task owner or seventh model collaboration tool is introduced. The Host captures the original Root controller so a late cancellation cannot abort its replacement. Public wire contracts live in the existing session cancellation schema and V4 cancelBackgroundWork payload.

Closing the root session stops all its live descendants through their original controls before shared execution resources close, and settles their state and durable mailbox before closing the session store. A child finishing or stopping does not close its descendants; ordinary Main Stop does not close the root session.

## User control and mailbox completion boundaries

User controls are a separate Root capability addressed by the original childSessionId. Busy input is genuine user guidance at a safe boundary; idle/stopped input uses the original runner, model, permissions, agentId, childSessionId and actual parentSessionId. Stop affects only that task. Ordinary child App input remains read-only.

Queue-only MESSAGE and FINAL_ANSWER stay in the durable mailbox until an already-required model request. Final text completion does not force another model step solely for mail. Legacy RespondToCoordinator shares that same V2 mailbox; it cannot create a second parent wake path. Interrupted tasks publish state activity, not a fabricated final answer. User guidance and explicit followup remain separate from ordinary mail.

The Registry's optional hasStartedTurn fact is monotonic and projected into the existing graph: only an explicitly false value plus the Registry's original child Session ID and parent binding permits the first turn (an existing Session must also match its project/directory and must not be deleted); true or an absent legacy value never authorizes missing-history recovery, and superseded setup cannot bind a sink, publish Spawn or remove the retained identity.
