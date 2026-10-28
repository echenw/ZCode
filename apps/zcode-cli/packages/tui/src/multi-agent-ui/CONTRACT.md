# Native multi-agent TUI

The sidebar and child detail pane render SubagentsController. Actions remain routed through the app-owned session and Runtime.

- Canonical task paths identify hierarchy; arrival order never invents parentage.
- The detail header shows the selected agent's canonical path and direct parent path when provided. It displays the authoritative provider/model, reasoning effort, and reported token total from the current controller read model; zero tokens is a reported value and missing metadata is omitted.
- Child transcripts remain read-only and separate from Main input. Returning preserves pending Main interactions.
- Rendering never creates or resumes agents. Status, errors and usage are shown only from authoritative data.

The public entrypoint exports SubagentsSection and SubagentView. Existing TUI modules supply layout and localized copy.
