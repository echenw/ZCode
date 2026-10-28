/**
 * cli-multi-agent 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliMultiAgentModule = {
  id: "cli-multi-agent",
  requires: ["cli-multi-agent-contracts", "shared", "zcode-cli"],
  provides: ["cli-multi-agent"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
