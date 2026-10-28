/**
 * cli-agent-communication-display 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliAgentCommunicationDisplayModule = {
  id: "cli-agent-communication-display",
  requires: ["shared", "zcode-cli"],
  provides: ["cli-agent-communication-display"],
  publicEntrypoints: ["index.ts", "contract.ts", "materialize.ts"],
} as const;
