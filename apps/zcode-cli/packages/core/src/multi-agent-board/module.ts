/**
 * cli-multi-agent-board 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliMultiAgentBoardModule = {
  id: "cli-multi-agent-board",
  requires: ["cli-multi-agent", "cli-multi-agent-contracts", "zcode-cli"],
  provides: ["cli-multi-agent-board"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
