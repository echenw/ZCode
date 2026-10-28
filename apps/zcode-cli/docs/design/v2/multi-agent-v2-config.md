# Multi-Agent V2 配置入口

`RuntimeConfig.multiAgentV2` 是用户/项目配置进入 Core 的唯一配置入口。默认 `enabled=false`，开启后仍受已有 `features.subagent`、会话 `subagents.enabled`、工具权限和父级权限限制。配置对象通过既有 ConfigPort 分层合并；仅覆盖指定字段，不丢失较低优先级层的 namespace、容量或预算。

字段与 Core `MultiAgentV2Config` 一致：`enabled`、`toolNamespace`、`maxConcurrentThreadsPerSession`、`maxResidentAgents`、`disableNativeTools`、`disableDirectMessage`、`waitAgentEnabled`、`exposeSpawnAgentModelOverrides`、`hideSpawnAgentMetadata`、`preserveForkPrefix`、`delegationMode`、`tokenBudget`。容量是正整数，namespace 按固定上游允许 1–64 个 ASCII 字母、数字、下划线或连字符；不允许无效字段静默进入运行时。具体 Provider wire 名称由共享合同映射，Prompt 只列实际授予的 wire 名称。

Bootstrap 合并文件配置和会话显式覆盖，然后将同一对象传给 Runtime。关闭已有 subagent 总开关时不能由新 V2 配置重新打开子代理。配置不能改变已有 approval/sandbox/cwd 的权威来源。

验收包含文件解析及诊断、用户/项目/会话的字段级覆盖、总开关压制、长 namespace 的真实工具提示匹配。模型行为、冷恢复和外部 Provider 验收另在总体执行报告逐项记录，配置测试不代替它们。

## 等待和角色提示配置

`minWaitTimeoutMs` / `maxWaitTimeoutMs` / `defaultWaitTimeoutMs` 使用整数毫秒，允许0，上限3600000，必须 min <= default <= max；未配置分别使用10000/3600000/30000。文件解析与Runtime共用验证函数；工具描述、执行等待和工具超时使用同一结果。

`usageHintText` 仅追加到 spawn 工具描述。`rootAgentUsageHintText` 与 `subagentUsageHintText` 分别替换默认角色指导，显式空字符串抑制该默认段；身份、真实工具和权限边界仍由Runtime提供。`multiAgentModeHintText` 替换模式指导文案，不能改变 `delegationMode` 的真实授权策略。`usageHintEnabled` 是固定上游保留但忽略的兼容字段，不控制是否注入。`subagentDeveloperInstructions` 是子代理默认开发者指导覆盖，空字符串可明确清空继承值，专门角色指令继续优先。默认子代理在首次派发时冻结实际父级开发者指导，热续接和冷恢复不会被Root的新指导覆盖。
