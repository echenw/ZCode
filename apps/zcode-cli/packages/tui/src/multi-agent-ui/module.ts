/**
 * cli-multi-agent-ui 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliMultiAgentUiModule = {
  id: "cli-multi-agent-ui",
  requires: ["zcode-cli"],
  provides: ["cli-multi-agent-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
