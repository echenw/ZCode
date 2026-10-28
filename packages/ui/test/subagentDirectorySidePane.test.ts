import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubagentDirectorySidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/hooks/useSessionSubagents.js", () => ({
  useSessionSubagents: () => ({
    error: null,
    loading: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    revision: 2,
    ended: {
      total: 21,
      nextCursor: "cursor",
      items: [
        {
          childSessionId: "child-failed",
          agentPath: "/root/a/b/c",
          parentAgentPath: "/root/a/b",
          parentSessionId: "grandchild-session",
          rootSessionId: "root-session",
          providerId: "provider-c",
          modelId: "model-c",
          reasoningEffort: "high",
          totalTokens: 0,
          subagentType: "general-purpose",
          title: "Run verification",
          summary: "Provider request failed",
          status: "failed",
          endedAt: Date.now() - 60_000,
        },
        {
          childSessionId: "grandchild-session",
          agentPath: "/root/a/b",
          parentAgentPath: "/root/a",
          parentSessionId: "child-running",
          rootSessionId: "root-session",
          subagentType: "general-purpose",
          title: "Prepare verification",
          status: "success",
          endedAt: Date.now() - 30_000,
        },
      ],
    },
  }),
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({
    layer: { acquire: vi.fn(() => ({ release: vi.fn() })) },
  }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({
    snapshot: {
      subagents: {
        revision: 2,
        childSessionIds: ["child-running", "child-failed"],
        running: [
          {
            childSessionId: "child-running",
            agentPath: "/root/a",
            parentAgentPath: "/root",
            parentSessionId: "root-session",
            rootSessionId: "root-session",
            providerId: "provider-a",
            modelId: "model-a",
            reasoningEffort: "medium",
            totalTokens: 128,
            subagentType: "Explore",
            title: "Inspect source tree",
            status: "blocked",
            startedAt: Date.now() - 5_000,
          },
        ],
        endedTotal: 21,
      },
    },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string>) =>
        values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id,
    },
  }),
}));

const tab: SubagentDirectorySidePaneTab = {
  id: "subagent-directory:workspace:root:parent",
  type: "subagent-directory",
  workspaceKey: "ssh://host/workspace",
  workspacePath: "/workspace",
  workspaceIdentity: "ssh://host/workspace",
  remoteSessionId: "remote-session",
  rootSessionId: "root-session",
  parentSessionId: "parent-session",
};

describe("SubagentDirectorySidePane", () => {
  it("renders unpaged running and paged ended sections with status and summary", async () => {
    const { SubagentDirectorySidePane } = await import("@/app-shell/SubagentDirectorySidePane.js");
    const html = renderToStaticMarkup(
      createElement(SubagentDirectorySidePane, {
        tab,
        onOpenSubagentSession: vi.fn(),
      }),
    );

    expect(html).toContain("subagentDirectory.running · 1");
    expect(html).toContain("subagentDirectory.ended · 21");
    expect(html).toContain("Inspect source tree");
    expect(html).toContain("subagentDirectory.status.blocked");
    expect(html).toContain("Provider request failed");
    expect(html).toContain("subagentDirectory.status.failed");
    expect(html).toContain("subagentDirectory.showMore");
  });

  it("shows fourth-level identity and authoritative model/usage while ordering parents before children", async () => {
    const { SubagentDirectorySidePane } = await import("@/app-shell/SubagentDirectorySidePane.js");
    const html = renderToStaticMarkup(
      createElement(SubagentDirectorySidePane, { tab, onOpenSubagentSession: vi.fn() }),
    );

    expect(html).toContain('data-agent-path="/root/a/b/c"');
    expect(html).toContain('data-agent-depth="3"');
    expect(html).toContain('data-parent-agent-path="/root/a/b"');
    expect(html).toContain('data-parent-session-id="grandchild-session"');
    expect(html).toContain("provider-c/model-c");
    expect(html).toContain("high");
    expect(html).toContain("0 tokens");
    expect(html).toContain("provider-a/model-a");
    expect(html).toContain("128 tokens");
    expect(html.indexOf('data-agent-path="/root/a/b"'))
      .toBeLessThan(html.indexOf('data-agent-path="/root/a/b/c"'));
  });

  it("builds a scoped detail request that preserves remote workspace identity", async () => {
    const { buildSubagentDirectoryOpenRequest } =
      await import("@/app-shell/SubagentDirectorySidePane.js");
    expect(
      buildSubagentDirectoryOpenRequest(tab, {
        childSessionId: "child-failed",
        subagentType: "Explore",
        title: "Inspect source tree",
        status: "failed",
      }),
    ).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-session",
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      childSessionId: "child-failed",
      subagentType: "Explore",
      title: "Inspect source tree",
    });
  });

  it("opens a fourth-level item through its actual parent instead of the root directory parent", async () => {
    const { buildSubagentDirectoryOpenRequest } =
      await import("@/app-shell/SubagentDirectorySidePane.js");
    expect(buildSubagentDirectoryOpenRequest(tab, {
      childSessionId: "fourth-level-session",
      parentSessionId: "grandchild-session",
      rootSessionId: "root-session",
      agentPath: "/root/a/b/c",
      parentAgentPath: "/root/a/b",
      subagentType: "general-purpose",
      title: "Fourth-level verification",
      status: "success",
    })).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-session",
      rootSessionId: "root-session",
      parentSessionId: "grandchild-session",
      childSessionId: "fourth-level-session",
      subagentType: "general-purpose",
      title: "Fourth-level verification",
    });
  });
});
