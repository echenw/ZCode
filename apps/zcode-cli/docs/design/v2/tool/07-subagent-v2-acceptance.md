# Multi-Agent V2：集成验收总账

## 当前复审结论（2026-10-28）

上一轮按用户明确授权，先修复已证实问题、清理确定废弃项，再撤销原 7 个本地提交并按类别重提；不 push。
以 `3c5b227649371507ddc4eb46ac5133afe6db1cab` 为原始基线，原分支提交与未提交文件已分别由
`backup/multi-agent-v2-before-regroup-20261028-085811`、Git bundle、完整二进制 diff 和文件归档保留。
新提交按路径测试、流恢复、V2 Runtime/Host/TUI、可选讨论板、UI、桌面回归、文档划分；
共用文件按相关改动拆分。运行产物保留但不入库，原 `main` 不改写。

**代码复审问题已修复；总体交付继续为 PARTIAL。** 原 Codex B0、跨 Provider 和真实模型自主行为
不因本轮本地回放而关闭。本轮没有外部模型调用；桌面交互仅在用户指定的 Docker 虚拟桌面进行。
E15–E43 是当时的历史证据；E44 记录七类提交当时的复核，E45 记录随后继续审查的四项修复，不能相互替代。

### E45：继续复审发现的四项生命周期与递归展示修复

对象为 `feat/multi-agent-v2-main@033afd31` 之后的集成工作树。本轮修复获用户明确授权；没有新增提交或 push。

- Runner 的 sink 注册、初始化失败清理与异步准备后的发布均验证原 generation 与非终态；Stop/新代次优先。旧准备流程不能覆盖新 sink、删除保留身份或迟发 Spawn。
- 首轮开始前停止仍保留原身份。Registry 用单调 `hasStartedTurn` 保存“是否开始过首轮”的事实并投影到原图；仅明确 false 可用原 childSessionId 完成首次初始化。已有 Session 校验项目、父链、目录和未删除状态；true 或旧图未知时空历史继续报错，不做损坏历史 fallback。JSON 冷恢复与单调性另有回归。
- Host 从同一经过有效分支、项目、实际父链校验的全树查询恢复全部后代 lifecycle 行，在本进程事件之前合并；不经 ended 分页丢失后代，也不保留第二份 manifest。无 backing record 的冷打开走同一事实与资格 seed。child outcome/model 读取也使用该 child 的有效分支。
- Root 全树 manifest 回收同工作区、同 Root 下所有失效后代标签；子级局部同步仍限定直接父级。切换时正确回落同作用域目录，保留其他 Root、远程工作区、兄弟与有效后代。

本轮实际验证：Core 3 文件 **43 PASS**；原前后台/边界/guard/通知路径 5 文件 **86 PASS**；Host 6 文件 **66 PASS**；UI 3 文件 **133 PASS**；Contracts 43 文件 **336 PASS**。Root typecheck exit 0，新增桌面脚本另经 E2E typecheck；最终 CLI 容器 typecheck **32/32 PASS**，Core/Bootstrap 类型检查与 Core build 另经最终复核。Root lint 0 error / 96 warnings，CLI lint 0 error / 70 warnings及 11 项原样上游行数诊断；变更架构 0 违规。没有重跑全仓测试，不用本轮局部通过覆盖 E44 的基线/环境失败与整体 PARTIAL。

桌面最终容器回放 **1/1 PASS / 0 FAIL / 0 skipped，exit 0**，无自动重试；用例 `65,771ms`，含构建准备共 `173,455ms`。31 条本地 fixture 请求全部 complete/200，`externalLlmVerified=false`。沿用四层树、Main Stop 隔离、原身份多次续接和真实进程冷重开；新增普通请求后仍保留三层后代目录、从真实目录打开孙/曾孙顶层标签、行内编辑 Root 派发输入后移除两标签并回落同 Root 空目录的实际交互。复看最终目录与回退截图。运行于 Docker/Xvfb、network none，未操作 Mac 桌面。用例入口与末尾断言曾命中收起的工具行/forceMount 隐藏页，现限定正式侧栏入口和当前激活面板，并等待异步目录刷新；原有断言保留。最终 runId `four-fixes-scope-20261028`；原始结果在 `/tmp/zcode-four-fixes-build-context.txt` 指向目录下，最终桌面产物为 `desktop-scope-artifacts/`。失败尝试分别保留，不以失败退出码冒充通过。

无界面检查在 Mac Node `24.18.0` / pnpm `10.33.2` 执行；CLI 全包类型检查及桌面使用容器 Node `24.14.0`。Mac 的 CLI 全包 typecheck 入口缺少 turbo，改用完整容器依赖；容器 lint 的 Git 索引检查因镜像不含 .git 未进入检查，改用原工作树正式 CLI lint 成功。所有模型响应为本地 fixture，无外部模型调用。原 11 个未跟踪运行产物哈希不变，原 main 保持干净；不涉及发布，无需新增发布记录。

### E44：源码复审、废弃清理与分类提交

- 原生 V2 默认/自定义/缩短 wire name 的冷目录，从 Root 持久图恢复真实身份；当前分支创建调用、项目和真实父链共同决定可见性。冷物化补齐正式生命周期行，下一条普通事件不再清空目录。进程退出未完成执行为 lost。
- V2 child 的模型轮结束早于 Runner 结算，不能提前宣布执行完成；目录等待原执行器 stop 和已排队父级结果。非 V2 原行为保留。真实 SQLite 阅读用例继续验证 Main 在后续输入中读到两个 child 的证据卡。
- Root 重绑孙代理执行后，RespondToCoordinator 沿真实 parentPath 进入父级邮箱，普通回复不唤醒 idle Root。旧 SendMessage、原生 followup 和用户续接在 Runner 共用容量/预算准入与同步槽预留。
- 可信 operation 从注册工具经事件/持久元数据进入 V4，执行与审计保留 wire name，UI 复用原 Agent / SendMessage 和真实 child 配对；普通 MCP 同名后缀仍为 generic。姓名、颜色与 Workflow 头像沿 Registry 身份；无 summary 的原生消息使用正文作预览。
- 去掉 Agent 已不可展开的内联内容、专属 Prompt 组件和无消费者 helper，去掉讨论板未读取的 byWire 反向 Map。保留原 Agent/Task/SendMessage、Workflow 正式问答、旧图名字读取和非 V2 路径。V4 的共用图读取归 App，未添加到旧协议目录的依赖。

| 验证 | 本轮证据与边界 |
| --- | --- |
| 类型与门禁 | Root typecheck exit 0；CLI 全量 typecheck 32/32（0 cached），最后 Host 改动后再做 Bootstrap typecheck/build；Root lint 0 error / 96 warnings，CLI lint 0 error / 70 warnings及 11 项上游行数诊断；changed 架构 0 违规、架构测试 36/36、Schema exit 0 |
| Core / Contracts / TUI | 容器正式 package scripts：Core 4,331 PASS / 22 skipped，Contracts 336 PASS，TUI 217 PASS；Core 最后未再改动。工作流 runtime 98 PASS |
| Host | 全包首跑 3,093 PASS / 14 FAIL / 16 skipped；12 项由缺少 Office viewer 构建产物引起，另有 V4 跨旧协议 import 和完成状态过早问题。补构建产物并修复后，8 文件 131 PASS；最后目录精确限制 V2 后，6 文件 52 PASS，覆盖旧模式、SQLite 阅读、冷恢复及原生边界 |
| CLI | 首跑 516 PASS / 2 FAIL，随后一次 515 PASS / 3 FAIL；缺少 SEA Root workspace 编译产物及旧模式目录的判断已收口。构建完整 runtime 闭包并限制新规则到 V2 后，正式全包 518/518 PASS |
| UI / 根受影响测试 | 最后相关 11 文件 254 PASS。根 affected 选中 1,376 文件，首跑 15,575 PASS / 6 FAIL / 3 skipped；4 项由新共享按钮 mock 和旧头像断言未同步导致，修复后相关 63 项 PASS。其余 2 项网络退避失败在独立 `3c5b2276` archive 和同一 Node 环境复现，本轮保留，不把根回归称为全绿 |
| Adapter | 容器全包 2,301 PASS / 3 FAIL / 4 skipped；分别表现为 root 下权限断言、60ms 子进程窗口和 100ms OAuth 快照失配，支持环境相关性判断。Mac 无界面定向三项均 PASS / 143 未选中；额外三文件完整复跑 142 PASS / 1 既有输出时序 FAIL / 3 skipped，保留该限制，不称 Adapter 全量全绿 |
| 总测试入口 | `pnpm --dir apps/zcode-cli test` 在 Turbo 的跨根 glob 路径计算阶段报错，未进入测试；后续使用各包正式 scripts 并补齐其构建前置，不将总入口报告为通过 |
| Desktop | 最终集成代码在 Docker 虚拟桌面回放 1/1 PASS / 0 FAIL / 0 skipped，exit 0，无重试；用例 65,137ms，含构建准备共 222,404ms。覆盖四层代理、Main Stop 隔离、原身份暖续接、真实进程冷重开和邮箱恢复；23 条本地 fixture 请求，`externalLlmVerified=false`。复看递归目录、原 Workflow 来信及冷恢复截图；390 宽度为共享 renderer emulation，不等同手机 `/remote` 完整验收。产物 `validation/e2e-shipping/`，runId `regroup-shipping-20261028` |

本轮完整日志、源文件哈希、失败与复跑记录、桌面产物及分组预览保存在项目上级的
`.git-regroup-backups/20261028-085811/`。13 份共用文件的 Core/讨论板分组通过语法检查；
每组创建提交前检查 staged diff，最终提交树须与已审查工作文件完全一致。独立中间提交不声称各自执行了完整回归。


## 2026-10-27 集成结论与验证范围（历史记录）

**总判定：PARTIAL，尚未完整交付。** 验证时的对象是 Mac `feat/multi-agent-v2-main@3c5b227649371507ddc4eb46ac5133afe6db1cab` 上的集成工作树；此后用户授权分类提交，源码及桌面交互已提交至 `8f04090d`，保留 A/C、Main 提示词与用户确认的 T17 范围扩展。以[原计划](../../../../../../../计划.md)及[原差距审计](../../../../../../../Multi-Agent-V2-功能对齐差距审计.md)为要求；固定 Codex 参考为 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。不根据旧交接中的 PASS 直接关闭本轮验收。

用户明确授权修复失败项并完成验收，随后限定为**本地验收，外部模型验收记为受阻**，并确认 `scope=task/subtree/tree` 的公开取消契约。后续针对普通桌面 Main Stop 连停子代理，用户另行授权主、子孙代理使用 `glm-5.3-flash`（本机选择 `magpie/zcode/GLM-5.3-flash`）真实验证，并选择以现有用户级配置为所有项目默认启用 V2。该授权不覆盖其他模型、跨 Provider 或 B0；代码默认关闭及显式项目/会话覆盖契约保留。最初不提交；随后用户明确授权分类提交，未授权 push，不清理原有未跟踪文件。HTML 能力产物按原要求未预览、未测试。

在 E31 之后，用户将本次实机调用限定为 **`workbuddy/glm-5.3-flash`**；E32–E33 的主、子、孙代理均使用该模型，桌面显示供应商为 `magpie`。其他模型及跨 Provider 测试仍不在本次授权内；B0 的官方服务端明文可行性未因这些实测改变。

E15–E31 的测试记录使用 Node `24.14.0`、pnpm `10.33.2`、macOS；E32 的构建环境见下文。E16 全 CLI 回归限制两个并发任务和每套两个测试 worker，E25 使用单任务与单 worker。模型替身只提供时序与模型响应，Registry、原 Runner、App/V4、Read 文件读取及 SQLite 在各注明的集成用例中真实执行。**脚本化 tool call 不能证明模型自主委派、选工具或跨 Provider 兼容。**

### 本轮证据索引

| 证据 | 本轮结果 | 实际范围与限制 |
| --- | --- | --- |
| E15 | 最后一批失败用例定向重跑由 61 PASS / 4 FAIL 修至 65/65 PASS；Core 网络边界登记遗漏另行修复并回归 | 中文/空格文件 URL 使用 `fileURLToPath`；恢复测试按正式错误字段断言；MessageBoard HTTP 仅精确登记 adapter 文件，仍走原代理/CA 网络入口 |
| E16 | 最终全 CLI 42/42 个构建/测试任务成功，exit 0，0 cached，耗时 5m21.379s | 强制执行实际 package scripts，覆盖 Core、Adapter、Bootstrap、TUI、CLI 及工作流；各包数目见下表，跳过不算通过。此前一批 Core 4310 PASS / 1 FAIL 的 Main 取消回执缺陷修复后，39 项定向及本次完整回归均通过；中断或失败批次保留 |
| E17 | 根共享协议/UI 10 个文件 234/234 PASS，0 skipped | legacy/V4 wire、命令/query/display/usage、目录/详情/状态面板；组件测试不替代原生屏幕交互 |
| E18 | scoped stop 定向 Core 39/39 PASS；生产 App → V4 → Runtime → Runner → SQLite 的 subtree/tree 两项集成 PASS，均已包含于 E16 | 单任务、子树、整树、Main 真实请求 signal、兄弟和跨根隔离、迟到结果 fence、原身份续接；Main-only 回执与自然完成竞态另有回归。缺省取消和普通 Main Stop 原范围保留；尚未增加/验收原生 UI 的范围选择控件 |
| E19 | 隔离阅读集成 1/1 PASS，已包含于 E16 | 两个真实 Child 分别调用 Read 读取指定行区间，检查未请求内容不泄漏、trace/会话、真实 SQLite tool parts 与证据卡收集；模型为 fixture，T30 的真实模型理解与自主汇总仍未证明 |
| E20 | 根 typecheck PASS；CLI typecheck 32/32 成功（24 cached）；根 lint 0 error / 96 warnings；CLI lint 0 error / 70 warnings，另有 12 项原样上游行数诊断；架构 0 违规、架构测试 36/36、Schema 检查 exit 0 | CLI 类型检查及两层 lint/架构门禁在 E20 当时的最后产品代码改动后通过；后续门禁见 E26。Lint 告警未归零；Schema 验证含 8 项测试及两套 SQLite baseline 兼容检查，不是迁移生产数据 |
| E21 | Desktop `build:no-runtime-assets` exit 0；原生 E2E **BLOCKED**，0 PASS / 1 启动失败 | ChromeDriver 派生 Electron 读取独立 `.e2e-cache` 入口 `app/main/index.js` 遭 `EPERM`，没有进入实际场景。外层 runner 曾返回 0 且未产 summary，不能据此报成功；当时直接 shell 探针只能确认启动链差异，后续根因证据见 E23 |
| E22 | B0/B1/B2/B3 与真实外部模型/跨 Provider 验收 **BLOCKED** | 固定 B 树未提交明文补丁；旧 B0 原始日志与当前 wire 源码共同指向必需字段 `code_mode_host_duration_ns` 不兼容。本轮未重发真实请求；历史失败不能替代当前端到端证明 |
| E23 | 用户明确确认后，Electron“桌面”访问已开启；新 ChromeDriver/Electron 进程三个文件 3/3 可读，原入口 EPERM 已解除 | 开启前同一 Electron 直接启动 3/3 可读、ChromeDriver 启动 3/3 EPERM；系统 TCC 与设置 off 相互印证。开启后同启动链验证通过，未授予完全磁盘访问；真实应用启动及后续场景结果见 E24 |
| E24 | 启动链 **RESOLVED**；修复两处 E2E 准备问题后，定向 70/70 PASS；原生完整用例仍为 **0 PASS / 1 FAIL，exit 1** | Electron service、renderer、Host、bundled Agent 均已启动，原生 DOM 断言已通过三层后代路径/层级/session/running；随后在孙代理详情触发按钮的可见性检查失败，尚未进入 Main Stop/暖续接/冷恢复。失败根因未判定，不把前置断言算成额外完整用例 PASS |
| E25 | 子详情控制、QueueOnly 回报和旧 Agent 等待取消说明已接入；全 CLI 42/42 任务成功，exit 0、0 cached | Core 4,316 PASS / 21 skipped，Adapter 2,304 / 4，Bootstrap 3,085 / 15，TUI 217 / 0，CLI 518 / 0；此批发生在 E26 的退出收尾修复前。相关 UI 8 文件 219 PASS，随后受影响 UI/helper 3 文件 75 PASS，存在重叠 |
| E26 | Root 会话退出时先停止已接受子孙；完整 Core 4,317 PASS / 21 skipped，另有最终定向 6/6 PASS | 定向包含流式及非流式旧 Agent 等待取消后的模型历史和持久记录、后代独立性、用户控制及退出时邮箱保留；最后仅追加测试，产品源码与完整 Core 运行一致。根/CLI 类型、Lint、架构及 Schema 检查通过，具体限制见下文 |
| E27 | 隔离原生 Desktop 回放场景 1/1 PASS，进程与 summary exit 0 | 实际 Electron/Host/CLI/Bash/SQLite 链路；孙代理详情暂停并原身份续接、Main Stop 后子孙继续、暖续接、真实旧进程退出与冷续接/邮箱恢复均到达；23 条场景请求全部匹配并为 200。模型回复为本地 fixture，不能证明真实模型自主行为或跨 Provider |
| E28 | 前台 A、后台 B、A 的孙代理 C 组合在实际 Core Runtime 中通过 | Main Stop 后三个原任务信号仍存活并完成；Main 新 turn 实际调用 list/wait，随后原 A 以相同 agent/session 身份续接。模型为 fixture；同一 legacy 组合尚未在原生桌面单独重放，范围取消与竞态另由 E18 覆盖 |
| E29 | 原生 Desktop 运行中刷新并重新订阅，再完整执行 E27 场景，1/1 PASS、exit 0 | 同一 Electron 进程下三层子孙身份、generation、原生运行行和工具单次启动保持；随后真实完成、暂停/续接及冷重启均通过。23 条场景请求全部匹配且为 200；远端 Host 独立断线重连与真实模型不在此验证范围 |
| E30 | 原生 Desktop 前台 A、后台 B、A 的孙代理 C 组合 1/1 PASS、exit 0 | 前台 A 由旧 Agent 工具派出，后台 B 为 V2 spawn；Main Stop 后三者继续并各执行一次，Main 新轮实际 list/wait/followup 原 B。模型可见取消记录明确等待结束不代表子代理停止。13 条场景请求均命中并为 200；模型为本地回放 |
| E31 | 分类提交后全仓架构检查 **FAIL**，变更范围检查 0 违规 | 全仓报告 `packages/services/src/gen-ui` 缺少 `contract.test.ts`；基线 `3c5b2276` 已缺该文件，`gen-ui-service` 当时已登记为 managed，本次未修改该模块。E20/E26 的 0 违规均是 `--changed` 范围结果，不代表全仓通过 |
| E32 | `workbuddy/glm-5.3-flash` 真实模型、开发版 Desktop 单子代理控制与消息场景通过；两个子代理和一个孙代理完成 | Main Stop 后单子代理继续、子窗口引导/暂停/原身份续接，以及停止和运行中的邮箱边界均有实机证据。多级场景期间桌面控制无法读取窗口，未执行三代理同时运行时的 Main Stop；详见下文 |
| E33 | 同一指定模型的多级 Main Stop 实机补测通过 | 两子一孙及 Main 的 Bash 同时运行后，从桌面停止 Main；仅 Main 命令取消，三个后代正常完成并发信，主邮箱排队且 Main 未自动续跑。桌面读取随后再次报错，未在本轮原生界面消费这批邮件 |
| E34 | 子代理输入区复用 Main 外壳、单一发送/暂停按钮和自身上下文；原生回放 1/1 PASS | 66 项 UI、398 项 CLI 定向回归通过；原生确认上下文指示器可见及按钮互斥，并通过暂停/原身份续接/冷重启。未新增外部模型调用；完整手机与主题视觉矩阵未覆盖 |
| E35 | 修复已完成 child 首订阅用量归零/误用父容量及手机回车误发送；定向回归通过 | 19 项 UI、466 项 CLI、原生桌面回放 1/1 PASS。桌面与手机两种订阅模式均通过 SQLite 恢复验证；手机输入通过组件交互回归，未做手机实机验收，无外部模型调用 |
| E36 | 代理接收消息、稳定名称、递归详情与新标签页代理列表本地验收通过 | 635 项 CLI、83 项 UI、3 项通信契约通过；原生 Desktop 四层流程 1/1 PASS、23 次本地回放请求均为 200。修复祖先状态投影和首次打开的转录过滤遗漏；没有新增真实模型调用，详见下文 |

E16 的主要包结果如下；同一批次还覆盖 Dynamic Workflow 1,983 项、Dynamic Workflow Runtime 98 项等包，完整 17 个测试包汇总见机器摘要。定向测试、根测试与全套存在重叠，不相加为独立能力总数。

| 包 | PASS | FAIL | skipped |
| --- | ---: | ---: | ---: |
| Core | 4,313 | 0 | 21 |
| Adapter | 2,304 | 0 | 4 |
| Bootstrap | 3,084 | 0 | 15 |
| TUI | 217 | 0 | 0 |
| CLI | 518 | 0 | 0 |

目录投影修复还覆盖：异步 spawn 的初始化 idle 不冒充完成，完成后 idle 不重新冒充运行，新一轮清除旧终态，明确停止事实不被旧运行投影覆盖。回归见 `bootstrap/tests/subagent-session-query.test.ts` 与真实 App scoped-stop 用例。

正式[机器摘要](../../../../../../docs/testing/multi-agent-v2-local-results-2026-10-27.json)已保存：147 个已改/新增源码、配置和测试文件的 SHA-256 聚合为 `776eb6540c3c1a9163fd6237191dcaa7d6f45406ad7a43710a3c407aa459804b`，最终回归前后逐文件一致；文档、历史产物和结果 JSON 不在此源码指纹内。摘要保留命令、执行/跳过范围、退出状态、日志哈希与受阻原因，不保存模型凭据或完整私有上下文。原始本地日志仍位于 `/tmp/zcode-v2-acceptance-20261027-2fHdgg/`，临时目录不承诺永久保留。

### E23：桌面启动阻塞的后续诊断

- 用户随后授权处理桌面启动阻塞。源码与原回归对象一致，基线检查和架构检查仍通过；本次诊断没有修改产品源码。
- 使用同一 Electron、同一读取脚本，分别直接启动与由 ChromeDriver 启动。读取对象为仓库 `package.json`、`out/main/index.js`、原失败的 `.e2e-cache/.../app/main/index.js`。直接启动三项均可读；ChromeDriver 创建最小本地窗口成功，但三项读取均返回 `EPERM`。这排除了仅隔离副本损坏或普通文件读权限不足的解释。
- `2026-10-27 05:55:09` 的系统 TCC 日志：直接启动归因到宿主 `com.openai.codex`；ChromeDriver 派生的 Electron 以 `com.github.Electron` 为权限主体。对 `kTCCServiceSystemPolicyDesktopFolder` 的请求 `410.7270` 返回 `authValue=0 / authReason=2`，对应本次实际拒绝。
- 原生系统设置初查：`隐私与安全 → 文件与文件夹 → Electron.app → 桌面` 的开关为 **off**。用户随后明确回答“允许开启‘桌面’访问并继续验证”；仅该开关已改为 **on** 并从 UI 回读确认，未修改完全磁盘访问。此权限覆盖 Electron 对整个桌面文件夹的访问，不仅限于本项目。
- 证据目录：`/tmp/zcode-desktop-startup-20261027-Bu0OS3/`，包含 `diagnosis-before-permission.json`、两种启动的读取结果与 ChromeDriver 日志。最小探针只打开本地空白测试窗口、读取上述文件的字节数，不调用外部模型；本次创建的探针与 Driver 进程已结束。
- 授权后使用新 ChromeDriver/Electron 进程对照复测，三个文件均可读，证明原入口 EPERM 已解除；结果见 `driver-after-permission.json` 与 `diagnosis-after-permission.json`。独立测试 HOME 的原生 V2 用例已真正进入应用，完整结果见 E24。

### E24：恢复启动后的实际原生场景

- 初次恢复启动后，Electron 窗口、Host 与 bundled CLI Agent 均正常就绪；用例在准备窗口时失败。实际显示器可用工作区为 `1728×998`，原 `1440×1000` 会被系统裁至 `1440×998`，等待 resize 后也不改变。改为可精确应用的 `1440×900`，保留共享内容区/renderer 尺寸断言。
- 第二个准备问题来自测试帮助函数：面板实际有 3 个运行代理行、分组已展开且路径/层级/会话完整，但 helper 还要求传统后台任务控制 ID。V2 展示行可以没有该 ID。新增两个入口的回归先取得 6 PASS / 2 FAIL，修正展开门禁后，8 项帮助函数 + 2 项窗口 helper + 60 项状态面板组件回归共 **70/70 PASS，0 skipped**。停止控件的控制 ID 校验未改。
- 最新原生执行 `v2-native-20261027-panel-fixed` 已通过四层身份图、三层后代原生 DOM 行的路径/深度/session/running 校验；共发生 7 次本地模型 replay 请求。随后 `openNativeChild` 对孙代理详情按钮的 `waitForDisplayed` 在 30 秒内未通过。尚未区分选择器、布局可见性或产品接线问题；不能据此认定按钮不存在。
- 原生完整用例 **0 PASS / 1 FAIL / 0 skipped**；进程退出码 **1**，实际 `summary.json` 已生成并记录失败。Main Stop、暖续接、真实进程冷重启与队列邮件恢复尚未进入本次原生执行；E16 的本地控制器/Runtime 证据不能代替这些步骤。
- 当前新增代码仅在 Desktop E2E spec、共享测试 helper 和新增回归测试，产品/CLI 源码与先前全回归对象一致。根 typecheck PASS、lint 0 error / 96 warnings、架构 0 违规、`git diff --check` PASS。当前 149 个已改/新增源码/配置/测试文件的指纹为 `f7c8b5d803bb018dc61430354b7ca1118c02119157cef9a2781405276cd2994c`；完整明细和各次失败保存在[桌面补充摘要](../../../../../../docs/testing/multi-agent-v2-desktop-results-2026-10-27.json)。原本地回归 JSON 保留当时快照，不覆盖历史。
- 本轮“桌面启动阻塞”已解除；全项目判定保持 PARTIAL。下一处原生断点是孙代理详情入口可见性，需在入口检查前保全当前 pane、按钮 DOM/布局与截图，核对正式消费者后再决定修复测试还是产品链路。没有进一步改动系统权限、提交或推送。

### E25–E31：用户控制、邮箱与原生冷恢复的后续结果

- 详情面板通过原 Root 控制指定子代理：暂停只影响目标；忙时用户输入在安全边界指导，闲置或停止后复用原身份、会话、真实父级、模型与权限续接。普通消息与最终答复留在原邮箱，已有模型请求边界再投递，不为邮件强行续跑已收口的 Main。V2 停止发布真实状态，不伪造最终答复。
- 正式测试发现窄窗口 `auto` 状态面板可能记录展开但内容由 CSS 隐藏；helper 改为操作真实可见的展开控件，保留代理行和状态断言。E24、后续失败及其日志保留，不能把失败前的阶段算成通过。
- 冷重启严格请求核对曾发现退出时多一次子代理模型请求：共享执行工具取消后，子代理还未收到停止信号。Root 会话关闭现在先通过每个子孙的原控制器中断，再关闭共享执行；状态与邮箱结算后关闭 Session Store。普通 Main Stop 及单个子代理结束不走此整树退出路径。修复后原生 E27 场景严格请求清单为 23/23，全部本地 200；无缺失 fixture 或额外场景请求。
- E28 在独立 Core 测试中实际派出 legacy 前台 A、后台 B，再由 A 派出孙代理 C；Main Stop 后检查三个 AbortSignal 和 Registry 均仍运行，再由 Main 新一轮调用 list/wait、释放任务并核对结果和原身份续接。此项与 E27 的原生场景互补，尚不是同一个原生 legacy 组合用例。
- E29 在三层子孙和 Main 实际工具仍运行时刷新 renderer，验证原 session 重新订阅、同一 Electron PID、子孙身份/generation、运行行与工具计数；随后继续执行原生完整场景，23/23 场景请求匹配并返回 200。该刷新覆盖本地客户端重连，不等同于远端 Host 的断线重连。测试与 summary exit 均为 0；Desktop E2E 类型检查、根 lint 和 `git diff --check` 通过。证据位于 `/tmp/zcode-v2-child-controls-20261027/native-artifacts-07/` 和 `native-07.log`。
- E30 在隔离桌面运行用户计划的前台 A、后台 B 与孙 C 组合：A 为前台旧 Agent，B 由 V2 spawn 后台准入，C 由 A 派出；点击 Main Stop 后三个任务继续且完成计数均为一次。新 Main turn 的真实回放请求包含明确的等待取消说明，并执行 list/wait/followup，B 保持原 agent/session 身份。两次原生运行均 1/1 PASS；最终 13/13 场景请求匹配且返回 200。fixture 检查、Desktop E2E 类型检查和根 lint（0 errors / 96 warnings）通过。证据位于 `/tmp/zcode-v2-child-controls-20261027/a4-artifacts-02/` 和 `a4-02.log`。
- 远端 Host 独立断线重连仍未执行：本机 Docker CLI 可用但 daemon 未运行；现有 Docker 专项用例依赖真实 `GLM-5.3`，不属于用户授权的 `GLM-5.3-flash`。不能把 E29 的本地 renderer 刷新视为远端断线证据，也未为此启动额外服务或调用其他模型。
- 分类提交后补跑全仓架构检查发现 E31 的既有缺项，已确认基线缺文件且本次未改相关模块；本次变更范围检查仍为 0 违规。未把局部检查当作全仓通过，也未借分类提交修改无关模块。
- 最终门禁：根 typecheck PASS；CLI typecheck 32/32 成功（18 cached）；根 lint 0 errors / 96 warnings；CLI lint 0 errors / 70 warnings，另有 12 项原样上游行数诊断；架构 0 违规、架构测试 36/36、Schema 测试 8/8 和两套基线兼容检查通过。`git diff --check` 通过。定向与完整测试有重叠，skip 不算 PASS。
- 原生 E27 使用独立源码/构建与 HOME，未使用真实模型凭据。报告和运行日志位于 `/tmp/zcode-v2-child-controls-20261027/native-artifacts-06/` 与 `native-06.log`；临时目录不保证长期保留。[桌面补充摘要](../../../../../../docs/testing/multi-agent-v2-desktop-results-2026-10-27.json)追加本轮结果，保留 E24 的历史失败。E27 当时的 Dev Host/CLI 未重启；已验证的新 bundle 准备给后续新进程，旧 bundle 在工作树 `.zcode-runtime/desktop-dev/bundle-backups/` 留存。

### E32：指定模型的桌面实机验证

- 2026-10-27，使用 `feat/multi-agent-v2-main@69494d27` 在改名后的工作树启动 ZCode Dev，界面选择 `magpie/workbuddy/glm-5.3-flash`。桌面项目显示为“Main Stop GLM 验收”，实际工作目录为 `/Users/aizou/Desktop/工作台`；测试提示禁止读取或修改项目文件，记录到的工具调用仅为等待命令和协作工具。开发构建使用 Node `24.18.0`，与仓库指定的 `24.14.0` 不同，构建输出提示版本告警。
- 测试根会话为 `session_0cce514ce947219a8c4c4d216a0682d5`。只读查询本机 SQLite 中该会话及全部后代的 `model_usage`：截至 E32 结束共 30 条完成记录，主轮 10 条、标题 1 条、子代理 19 条；全部记录的 provider ID 为 `new-provider`，model ID 为 `workbuddy/glm-5.3-flash`。记录的输入、输出、缓存读取字段分别合计 744,082、6,345、532,352 tokens；这些字段可能重叠，不能相加推导账单或缓存节省。该记录证明客户端请求的模型选择，不推断网关内部路由，也不代表机器上其他会话的调用。
- 单子代理场景中，主代理已进入 `collaboration_wait_agent` 后从桌面点击 Main Stop；主代理显示停止，`/root/live_probe` 仍运行并完成等待命令。子窗口在运行中接收的新提示词先显示等待处理，子代理之后的实际答复包含该提示词要求的标记。
- 同一子窗口续接代理并在其执行第二次等待命令时点击“暂停子代理”：界面显示已停止，SQLite 记录该 Bash 调用由用户取消，操作后未发现该测试的 `sleep 60` 进程。再次从子窗口输入新任务后，原任务 ID 和子会话 ID 保持一致，代理完成并发送新的测试消息。
- 主代理停止时，两条子代理消息与两次完成回报没有强制启动主代理；从主窗口发送下一轮输入后，界面依次显示两条 `MESSAGE` 和两条 `FINAL_ANSWER`，主代理也列出了相应标记。在主代理运行中的另一轮，SQLite 记录主代理 Bash 从 `1793082382829` 至 `1793082442890` 正常完成，子代理 `send_message` 在其间的 `1793082414527` 执行；桌面显示主命令输出 `V2_MAIN_FINISHED`，随后收到子代理消息和完成回报。
- 多级场景中，根会话创建 `/root/live_sibling` 并续接 `/root/live_probe`，后者再创建 `/root/live_probe/leaf`；SQLite 会话树、模型记录及三条等待命令的退出状态均显示成功，三个代理分别完成并调用 `send_message`，根会话后续答复包含三个测试标记。桌面控制随后反复返回 ScreenCaptureKit `-3812`，未能在这一轮点击 Main Stop，故不能把此场景记作三代理同时运行时的 Main Stop 实测。孙代理完成回报留在已结束的直接父代理邮箱；本次未再触发该父代理消费。
- E32 覆盖一个模型、一个开发版窗口和合成任务；不代表完整真实项目、其他 Provider、远端 Host 重连、真实 Board 服务或 Codex B0–B3 通过。未在 E32 重跑完整回归或全仓架构检查，也未修改产品源码。

### E33：两子一孙同时运行时的真实 Main Stop

- 用户要求继续后，沿用 E32 的开发版、根会话和三个后代身份。桌面读取短暂恢复，界面仍显示 `magpie/workbuddy/glm-5.3-flash`。通过主窗口输入续接原 `/root/live_sibling`、`/root/live_probe` 及其原 `/root/live_probe/leaf`，只执行指定等待命令与协作工具，没有新建代理或切换模型。
- 点击前的 SQLite 记录确认 Main、两个子代理和孙代理的 Bash 均处于 running。随后从原生主窗口点击“停止生成”，界面显示 Main 已停止、三个后代仍运行。Main Bash 在 `1793086315128` 结算为用户取消；三个后代等待命令之后分别正常退出，exit code 均为 0，未收到用户取消。
- 三个后代最终均为 completed，并成功调用 `send_message`。主邮箱保留 `V2_MULTI_STOP_LEAF_DONE`、`V2_MULTI_STOP_PARENT_DONE`、`V2_MULTI_STOP_SIBLING_DONE` 三条消息及两个直属子代理的完成回报。Main 的模型请求数从停止后至三个后代完成一直为 13，未因来信自动产生新请求。直接父级会话的持久化正文包含来自孙代理的 `FINAL_ANSWER` 及对应标记，最终该父级邮箱为空。
- E33 新增 12 条完成的模型请求记录（主轮 2、子代理 10）；E32–E33 合计 42 条（主轮 12、标题 1、子代理 29），全部记录为 `new-provider/workbuddy/glm-5.3-flash`。累计输入、输出、缓存读取字段分别为 1,045,908、8,664、719,488 tokens；保留 E32 的计量边界，不相加推算费用或缓存效果。
- 停止后桌面读取再次返回 ScreenCaptureKit `-3812`，但本地执行记录完整保留；本轮没有从原生界面再次启动 Main 消费这五条邮件。E32 已有另一批停止后邮件在下一轮实际消费的证据，不能将其称为 E33 此批邮件已消费。E33 未修改产品源码、未重跑全量测试，覆盖范围仍为该开发版中的单模型合成场景。

### E34：子代理输入区与 Main 对齐

- 用户要求同款输入区、移除子输入区的模型/权限选择，并明确补充自身上下文和单一发送/暂停逻辑。Main 与子代理共用 `ChatPromptEditorShell`；目标运行且空草稿时显示暂停，有非空草稿时同一动作位切为发送，空闲空草稿时发送禁用。保留 Enter、Shift+Enter、输入法保护、传输重试 commandId 和失败草稿。子控制仍由原 Root 准入，用量只读 child 的共享 projection。
- 初次桌面截图暴露上下文仍不可见：Core 的子代理 `ModelComplete` 缺少容量，旧事件归约及 V4 投影又统一忽略 subagent 用量。有效的 Core、Contracts、Bootstrap 定向断言先分别复现容量缺失和水位为 0；修复后，自身 subagent 事件更新自身上下文，其它 session 的子代理用量仍不能覆盖父投影。未新增协议字段、模型选择入口或第二份用量权威。
- 当前工作树的 UI 六个文件共 66 项、Contracts 28 项、Core 两个文件 18 项、Bootstrap 四个文件 352 项均通过。Bootstrap 范围包含 ProductProjection、V4 gateway、session context window 与 detached child hydration；未重跑全部 CLI 测试。
- 最新原生执行使用新 CLI bundle、独立 HOME 和本地 replay，1/1 PASS、exit 0；23/23 场景请求均匹配并返回 200，没有真实外部模型调用。新增断言要求子详情上下文指示器可见，空草稿暂停与非空草稿发送不同时存在，随后原暂停、续接、Main Stop 及进程冷重启仍通过。已查看深色桌面截图；未将此结果外推为手机、浅色和全部尺寸的视觉通过。
- 原生证据：`/var/folders/g4/g3pzp24j5nbcdqw34g74pdr40000gn/T/zcode-child-context-20261027-wmus4jdq/` 中的 `native.log`、`artifacts/summary.json` 和 `artifacts/v2-native/evidence.json`；`user-paused-and-resumed-grandchild-from-details.png` 显示子输入区的上下文圈和单一停止按钮。初次缺少上下文的截图保留在 `zcode-child-composer-20261027-weszltnk` 对应临时证据目录，不覆盖历史。
- 环境为 Node `24.18.0`、pnpm `10.33.2`、macOS；Node 与仓库指定的 `24.14.0` 不同。根 typecheck、CLI workspace 递归执行已定义的 typecheck 脚本均 exit 0；CLI 标准 Turbo 总入口因本机缺少 `turbo` 命令未成功，实际以同一 workspace 的 pnpm 递归检查替代。根 lint 0 errors / 96 warnings，CLI lint 0 errors / 70 warnings、12 项原样上游行数诊断；变更范围架构 0 违规。既有完整回归只代表其原源码快照，E34 不能据此关闭整体验收。
- 已重新生成桌面 CLI bundle；既有用户窗口/运行中的 Host 未为此强制重启，原生结果来自新建隔离进程。未提交或推送，也未清理原有未跟踪目录。

### E35：子代理上下文恢复与手机输入修复

- 本轮审查发现 E34 只补全实时用量链路：已完成 child 首次订阅时没有自己的 bootstrap record，旧 usage 读取直接返回，合成的零用量覆盖真实记录；容量又从父 record 的模型解析。新增 SQLite/gateway 回归在修复前同时复现 desktop-continuous 和 web-remote-replayable 的 `1100/960000 → 0/200000`。
- 修复复用原 `readSessionContextUsage`、EventReducer 和持久化消息计算。父 record 仅借存储/目录能力，容量读取 child 自己最近的模型事件；事件被清理后按 child 的持久选型查目录，显式未知保持未知。不为只读恢复新建 child runtime，也不借父 projection 的 tokens。
- 手机 `/remote` 子详情沿用 Main 的视口判断、Enter 换行、按钮发送、固定安全字号及快捷键提示。新增真实组件入口的键盘测试，修复前因阻止默认换行并发送而失败，修复后保留草稿且按钮只提交一次；原桌面 Enter、Shift+Enter、输入法和暂停/续接用例仍通过。
- 本轮 `subagentUserControls`、`mobileInputZoom` 共 19 项通过；Bootstrap 的 detached hydration、session context window、V4 gateway、cold merge、ProductProjection、cold hydration、transcript hydration 和 model request mapper 共 466 项通过，未重跑全仓测试。覆盖事件已被清理时的持久 tokens/选型恢复、跨 session 容量隔离及显式未知容量。
- 最新隔离 Desktop 回放 1/1 PASS，进程与 summary exit 0；23 条场景请求全部匹配且返回 200。沿原四层身份、子详情暂停/原身份续接、Main Stop 隔离、暖续接和真实进程冷重启场景回归，模型响应仅为本地 fixture，`externalLlmVerified=false`。这不代替手机实机或新一轮真实模型验证。
- 原生证据位于 `/tmp/zcode-child-review-fix-20261027-JdUQKF/`：首次命令因相对 fixture 路径解析错误停在准备阶段，记录在 `native.log` 和 `artifacts/`，未产生产品测试结果；修正为绝对路径后，实际通过记录在 `native-absolute.log`、`retry-artifacts/summary.json` 和 `retry-artifacts/v2-native/evidence.json`。使用首次执行已生成的新桌面构建/CLI bundle，没有重复调用外部模型。
- 环境为 Node `24.18.0`、pnpm `10.33.2`、macOS；Node 与仓库指定的 `24.14.0` 不同。根 typecheck、CLI workspace 递归 typecheck 和最终 Bootstrap typecheck 均 exit 0。CLI 标准入口仍因缺少 `turbo` 未成功，不能将该入口写成通过；根 lint 0 errors / 96 warnings，CLI lint 0 errors / 70 warnings、12 项原样上游行数诊断，变更架构 0 违规。未提交或推送，保留原有未跟踪目录。

### E36：代理通信显示、可读名称与递归详情

- 来信和完成汇报复用工具摘要行，显示发件代理名称并支持展开正文。保留原始邮箱正文、寻址和消费锚点；只有运行时 provenance 可产生来信样式，用户粘贴相同 carrier 仍是用户输入。XML carrier 的成功、失败和特殊字符均在显示层处理。根据用户最新用词修正，中文标签统一为“完成汇报”。后续截图暴露发件人被匿名 flex 文本挤成竖排，现用不可压缩的单行发件人元素、正文省略修复；本地 fixture 延长真实回传正文，原生测量断言发件人只有一行且没有越出容器，通过。
- Root Registry 分配同根唯一 nickname，代次续接及冷图恢复保留；旧图通过同一分配规则派生只读展示别名，不改 ID/路径或批量迁移用户数据。名称进入列表、子窗口、消息摘要及模型身份上下文。转录显示转换收在 managed 模块 `bootstrap/src/zcode-protocol-v4/agent-communication/`，纯回放入口不导入 Node 存储实现。
- 详情内递归打开下级；窄面板保留逐层返回，未关闭的父/子草稿保留。输入框上方和右上角显示全部下级的数量与运行数。新标签页增加“代理列表”，复用原工作区和 Root 身份。控制命令仍由原 Root 准入，没有第二份运行时或已接受队列。
- 原生数量断言暴露两处遗漏：生命周期只发直接父级和 Root，中间祖先漏收；首次打开时又把没有祖先用户轮次的状态投影当作 transcript-derived 事件过滤。现由原 Registry 读取祖先、每层只投影一次状态，再在 cold merge 保留这类事实；不借用后代 turnId，不唤醒模型、不改变邮箱策略。Core 多级事件断言及 Bootstrap 双 marker 冷合并断言均通过。
- 当前集成树定向验证：CLI 17 文件 635 项通过，覆盖生产 Runtime、持久恢复、用户控制、输入来源、上下文、转录、树读取与两种客户端的 V4 gateway；UI 6 文件 83 项通过；新增模块通信契约 3 项通过。没有重跑全仓套件，不能据此改写项目整体 PARTIAL。
- 最终原生证据为 `/tmp/zcode-agent-ui-native-sender-20261027/summary.json`、`v2-native/evidence.json`，均为 exit 0；四层、下级数量、列表入口、递归导航、草稿保留、暂停/原身份续接、Main Stop 隔离、暖续接及真实进程冷重启流程通过。23 条场景请求全部匹配且为 200，`externalLlmVerified=false`。已复看深色中文与浅色英文截图。最终运行重新构建桌面及 CLI bundle；不计为外部 Provider 验收。
- 中间失败保留在 `/tmp/zcode-agent-ui-native-20261027.log`、`native2-20261027.log` 及后续独立 artifact 目录：两次构建类型错误已修正；新标签页点击需等待详情过渡；下级计数断言先后发现上述事件链遗漏。早期 1/1 PASS 不覆盖后续源码，以上最终运行才是本轮验收证据。
- Node `24.18.0`、pnpm `10.33.2`、macOS；Node 与仓库指定 `24.14.0` 不同。根类型检查 exit 0；CLI 标准 typecheck 仍因缺少 `turbo` 退出 1，随后包脚本递归类型检查 exit 0。根 Lint 0 errors / 96 warnings；CLI Lint 0 errors / 70 warnings、11 项原样上游行数诊断；变更架构 0 违规；Schema 检查 8 项通过、两份基线兼容。未放宽门禁。
- 保留原资料重启 Dev 后，实际原会话已显示“接收消息”、完成摘要和 Ada/Turing/Curie 发件名称；桌面读取接口随后仍有间歇性的 ScreenCaptureKit 3811 错误。没有向用户会话发送测试提示词，未做本轮手机实机或真实模型调用。未提交、未推送，原有未跟踪目录保留。

- 用户反馈本机原生测试反复抢焦点、干扰台前调度；此轮前台测试已结束，确认没有仍在运行的对应 WDIO runner。后续默认采用不抢屏的检查；容器已有入口，但本场景尚无 Docker admission 证据，不能将 macOS 原生验收直接换算为容器通过。需要本机窗口行为验证时，先由用户安排可用时段。 用户随后明确指定：本任务必要的界面验证使用容器里的虚拟桌面。同轮只读核查 Docker daemon 未运行；未启动宿主 GUI，也未重跑真机测试。环境不可用时不得转用真机；已通过且源码未变的回归不为切换环境而机械重跑。

### E37：复用取舍落实与输入规则收口

- 对象为 `feat/multi-agent-v2-main@69494d27` 加本轮工作树；用户授权多个 sol high 子代理落实取舍，未授权本轮提交或推送。保留原 Workflow、旧公开工具及 V2 自由代理树；Core 继续复用原 Runner、Root Registry/session view、SessionStore 和 task control。本轮未发现需另建或整套删除的 Core 实现，也未新增普通 V2 正式阻塞问答协议。
- UI 的 Main、默认 editor 与 child 控制区复用纯展示 `ChatPromptSubmitButton`，统一发送/暂停动作位，草稿、状态与准入仍由原消费者负责。child 普通 Enter 改为调用现有 `shouldSubmitLexicalEnter`，修复 Ctrl/Meta + Enter 被误当作普通提交的问题；Shift、IME、手机换行与 Root 控制语义保留。新增两例先在未修复的工作树失败，再修复通过，未回退用户修改。
- Core 新增跨入口回归：V2 `send_message` 不唤醒终态孙代理；旧模型工具 `SendMessage` 与 V2 `followup_task` 复用同一 ID、child session、真实父级及 profile/model。现有 Runtime 用例补充旧回复与完成结果仅进入 V2 邮箱、各消费一次、旧唤醒队列零入队断言。两文件 `multi-agent-v2-runtime.test.ts`、`multi-agent-v2-user-control.test.ts` 共 **26/26 PASS**，exit 0，本地模型 fixture，非外部模型验收。
- Main 另跑 Core 的 controller/persistence、原 Workflow 回答工具、流恢复，以及 Bootstrap 的 Workflow escalation、scoped stop、cold event merge 和 child 查询，共 **8 文件 138/138 PASS**，exit 0。UI 的子代理控制/目录/详情/消息、默认输入动作、手机字号与三个 Main composer 消费者，共 **9 文件 127/127 PASS**，exit 0。以上为本轮定向回归，未重跑全仓测试，不提升整体 PARTIAL。
- 新增 Desktop 场景使用 trusted Ctrl/Command + Enter，检查暂停目标草稿保留、没有新增模型请求、仍为原 generation 的 stopped 状态，再以按钮正向续接。场景已通过 E2E TypeScript 检查，但 **未执行 E2E**：用户指定的容器虚拟桌面所需 Docker daemon 不可达（`~/.docker/run/docker.sock` 不存在）。未启动宿主 GUI、未切换真机、未做外部模型请求；历史 macOS 原生 PASS 不覆盖本轮修改。
- 根类型检查 exit 0；CLI 标准 `pnpm --dir apps/zcode-cli typecheck` 因 `turbo` 缺失 exit 1，随后 `pnpm --dir apps/zcode-cli -r --workspace-concurrency=2 run typecheck` 执行 32 个包脚本 exit 0。根 Lint 为 0 errors / 96 warnings，CLI Lint 为 0 errors / 70 warnings、11 项原样上游行数诊断；变更架构 0 违规，`git diff --check` exit 0。环境为 macOS、Node `24.18.0`、pnpm `10.33.2`；本机无 mise，未在仓库指定 Node `24.14.0` 上复验。Main 日志位于 `/tmp/zcode-v2-reuse-20261027-OMPkUe/`，临时日志不承诺长期保留。
- 三份现行文档同步原有/增强归属、入口适用模式、普通消息与 Workflow qid 问答的边界，保留所有历史验收记录。另一个 sol high 子代理只读复核本轮共享按钮、Main 修饰键行为、child Root 准入及新 E2E 断言，未发现该范围内需修改的问题；静态复核不能替代容器交互验证。原有未跟踪文件和在途修改均保留，未提交、未推送。

### E38：Docker 虚拟桌面补验

- 用户明确告知 Docker 已启动并授权继续。复核当前分支仍为 `feat/multi-agent-v2-main@69494d27` 加工作树，Docker `desktop-linux` daemon 可达。使用既有 `scripts/test-desktop-e2e-container.sh`，仅选择 `conversation-session-subagent-v2-native.test.ts`，`E2E_NETWORK_MODE=replay-isolated`、容器 network 为 `none`，Xvfb `:99`；没有挂载宿主显示服务或操作真机窗口。
- 首次运行真实进入应用，四层身份及 3 个运行后代已出现；在 A 的下级数量检查失败，exit 1、0/1 PASS。截图中 header 为 `2/2`，composer 为英文 `Child agents 2 · 2 running`，而用例硬编码中文 `下级代理 2 · 2`。因此这是 Linux 默认系统语言暴露的测试前置条件缺失，不是代理计数丢失。保留首轮 `artifacts/summary.json`、`v2-native/child-descendant-count-failed.png` 和日志，没有降低或删除计数断言。
- 最小修复仅在 `assertNestedChildUi` 开始调用既有 `setAgentPresentation("zai-dark", "zh-CN")`，之后仍运行浅色英文和深色中文切换。该辅助函数使用真实语言偏好入口，不修改代理状态；产品代码、fixture 和业务契约均未改。另一个 sol high 子代理只读核对了截图、语言偏好持久化及过期 system 解析防护，确认与故障一致。
- 第二轮使用首次镜像的依赖层和只复制上述测试文件的临时派生 Dockerfile，运行前重新构建测试应用与 CLI bundle；没有跳过测试准备或使用宿主构建产物替代。Linux x64、Node `24.14.0`、pnpm `10.33.2`、ChromeDriver `146.0.7680.80`。本轮 70 个已改/新增源码、配置和测试文件在容器镜像与宿主逐项 SHA-256 一致，执行后宿主也无漂移。
- 最终 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；测试主体 `48,108ms`，容器报告总时长 `154,234ms`（含应用构建及准备）。23 条场景请求均为匹配的不同本地 fixture，全部 complete/200，`externalLlmVerified=false`。
- 实际闭合：代理列表入口、各级下级计数、递归子窗口、父/子草稿保留、深色中文/浅色英文、Ctrl/Command + Enter 不误恢复暂停目标、详情暂停/原身份续接孙代理、Main Stop 后子孙继续、暖续接、真实 Electron/Host 进程冷重开、历史不冒充运行、待收消息不唤醒及再次原身份恢复。已复看本次容器截图；Main Stop 时 Root 为 completed，A/B/C 仍为 running；冷续接保持原身份并达到预期 generation。
- 根类型检查、Lint、变更架构和 `git diff --check` 均 exit 0；Lint 仍为 0 errors / 96 warnings，架构 0 违规。本轮仅修测试语言前置条件，不重复 E37 已通过且源码未变的单测。此前各环境的历史结果保留，容器 E2E 不替代外部模型、跨 Provider、B0 或未执行的全仓验收，项目总判定仍为 PARTIAL。
- 全部证据位于 `/tmp/zcode-v2-reuse-container-20261027-XThbvS/`：首次 `container.log`、`artifacts/summary.json`；最终 `container-fixed.log`、`fixed-artifacts/summary.json`、`fixed-artifacts/v2-native/evidence.json` 及截图；`image-source-check-fixed.json`、`host-source-check-after.json` 和 `container-isolation-fixed.json` 保存版本/隔离/源码核对。临时日志不承诺长期保留。测试容器已由原脚本退出清理，未提交、未推送，原有工作树和未跟踪文件保留。

### E39：代理来信实际复用原版消息组件

- 对象为 `feat/multi-agent-v2-main@69494d27` 加本轮工作树；按用户“原版有的就用原版的样式”，从原 `send-message.tsx` 提取纯展示 `AgentMessageBlock`。发送、接收和完成汇报共用原摘要、详情字段与折叠交互，V4 不再维护独立接收卡片 JSX。仅展示入口适配发件人及目标；真实用户气泡、邮箱投递/消费、历史和 Runtime 未改，未伪造 ToolCall、Workflow 或 qid。
- 原工具适配器保留解析、失败/拒绝/停止/运行状态、强制展开和截断全文加载；来信保留名称、路径与完整正文，“来自”横排不被长摘要压缩。会话内展开状态继续由原 `ToolLayout` 管理，使用含 session 的消息 key；展开/退出动画也沿用原组件。
- UI 定向测试 **5 文件 85/85 PASS，exit 0**，包括原发送行为、MESSAGE/FINAL_ANSWER 共用详情、完整多行正文、折叠与跨会话隔离、旧名称/路径不重复、真实用户气泡、原工具全文加载。另一个 sol high 子代理只读复核本轮 UI 变化，未发现该范围内需修问题；静态复核不代替运行结果。
- 容器首轮把原摘要的 `div[role=button]` 误选为原生 button，修正为既有摘要 test id 后完整场景通过。随后新增主题/窄窗口展开检查，一次在元素存在但 WebDriver 尚未读取到正文时失败，改为滚到正文并等待实际可读文本，未降低完整正文断言。另一次在 Main Stop 后释放 Root 文件门闩后出现 `root-done`；日志确认 Root 已收到取消，但旧用例没有等待异步进程树实际退出，存在门闩释放竞态。旧产物未记录 PID，不能据此唯一确定该次写入的具体时序。测试 fixture 现记录原 shell 的真实 OS PID，Stop 前核实进程身份，Stop 后有界等待原 PID 退出，再释放门闩，保留 Root 不完成及子孙继续的原断言；没有修改产品取消机制。上述失败日志与产物均保留。
- 最终容器执行 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；主体 `48,954ms`，含构建/准备总计 `150,442ms`。23 条不同本地 fixture 请求全部 complete/200，`externalLlmVerified=false`。覆盖主代理进程退出而三层后代继续、详情暂停/续接、暖续接、真实进程冷重开及原身份恢复；新增深色中文 `1440×900`、浅色英文 `1100×900` 的来信展开/收起、原详情正文和发件人单行/容器内布局检查，并复看展开与收起截图。`1100×900` 是窄桌面窗口，不报告手机 Web 或外部模型验收通过。
- 仍由既有脚本在 Docker 虚拟桌面执行，`--network none`、Xvfb `:99`，未操作宿主窗口、输入设备或台前调度。Linux x64 / Node `24.14.0` / pnpm `10.33.2`；镜像内 70 个已改/新增源码、配置和测试文件与宿主 SHA-256 全部一致，执行后宿主无漂移。根类型检查、Lint、变更架构和 `git diff --check` 均 exit 0；Lint 0 errors / 96 warnings，架构 0 违规。本轮未重跑全仓套件，项目总判定保持 PARTIAL。
- 证据位于 `/tmp/zcode-original-message-style-20261027-XCnP0M/`：最终 `container-complete.log`、`complete-artifacts/summary.json`、`complete-artifacts/v2-native/evidence.json` 及截图；`image-source-check-complete.json`、`host-source-check-complete.json`、`container-isolation-complete.json` 保存版本、源码及隔离核对。初轮、扩展检查的失败与中间通过记录分列在其余日志/产物目录，不覆盖历史证据。临时日志不承诺长期保留。测试容器已退出清理，未提交、未推送，原有修改及未跟踪文件保留。

### E40：按用户指定参考复用原 Workflow 问答/通知展示

- 用户进一步明确参考是原版“子代理的问题已回答 / 已回答问题”问答通知，不是 E39 使用的 SendMessage 发送样式。本轮对象仍为 `feat/multi-agent-v2-main@69494d27` 加工作树；E39 保留其当时结果，当前呈现以本节和现行 spec 为准。
- 将原 Workflow 通知和回答卡的单行摘要、160 字符概要及正文面板提取为既有 `ToolLayout.tsx` 中的纯展示 `NotificationToolRow` / `NotificationProse`；原 `WorkflowNotificationToolRow`、原 `ResolveWorkflowQuestionToolCallBlock` 与 V4 代理来信实际调用同一份展示。原问答的 qid、pending/answered 判断、等待事实、拒绝结果及全文加载不变；普通 V2 来信不创建这些业务状态，不冒充“已回答”。
- 来信使用原对话回复图标，完成汇报使用原终态通知图标；展开后为原问答正文面板，身份名称/路径只作次级说明。删除 E39 的 `AgentMessageBlock` 及发送卡式来信字段详情，原 SendMessage 保留自己的图标、状态、字段详情、昵称及全文加载行为。发件人仍完整横排、摘要在剩余空间内省略；真实用户气泡、邮箱与模型请求边界未改。
- 最终 UI 定向回归 **5 文件 113/113 PASS，exit 0**：代理来信、原发送工具、原 Workflow 通知、原回答工具及 ToolLayout。新增断言实际比较原问题/回答组件与 V2 来信的正文呈现、保留完整多行文本、折叠时只保留摘要、不出现纸飞机/发送字段详情、不伪造 waiting/answered，以及名称/路径和跨会话开合隔离。根类型、Lint、格式、变更架构及 `git diff --check` 均 exit 0；Lint 0 errors / 96 warnings，架构 0 违规。
- 首次容器场景在新身份信息断言处读到空文本，0/1 PASS、exit 1。只将测试改为等待正文实际可读，再滚到身份说明并等待可读文本；完整正文和身份断言均保留。两次镜像间只有该 E2E 文件变化，未为通过测试修改产品。首次日志与产物保留。
- 最终容器场景 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；主体 `57,021ms`，含构建/准备共 `168,514ms`。深色中文 `1440×900`、浅色英文 `1100×900` 及深浅/中英 `390×844` 的通知展开/收起、完整正文、图标、身份可读性及发件人单行/边界检查通过，并复看本轮截图。390 宽度通过既有 Electron renderer emulation 路径检查共享组件，不等同于单独完成手机 `/remote` 端到端验收。
- 同一场景继续验证四层树、Main Stop 后子孙继续、详情暂停/原身份续接、暖续接和真实进程冷重开。23 个不同本地 fixture 请求均 complete/200，`externalLlmVerified=false`，无真实外部模型调用。测试仅运行在 Docker 虚拟桌面，network 为 `none`，未操作用户真机窗口或输入设备；测试容器已退出清理。
- Linux x64 / Node `24.14.0` / pnpm `10.33.2`；73 个已改/新增源码、配置和测试文件的镜像/宿主 SHA-256 一致，执行后宿主无漂移。证据位于 `/tmp/zcode-workflow-style-20261027-p8obgkbt/`：`unit-final.log`、`typecheck-fixed.log`、`lint-final.log`、`architecture-final.log`、`format-check-final.log`，最终 `container-fixed.log`、`fixed-artifacts/summary.json`、`fixed-artifacts/v2-native/evidence.json` 与截图，以及源码/隔离核对 JSON；首次 `container.log`、`artifacts/` 保留。临时证据不承诺长期保留。本轮未重跑全仓测试，项目总判定仍为 PARTIAL；未提交、未推送，原有修改和未跟踪文件保留。

### E41：删除 V2 独立呈现，直接进入原通知入口

- 用户进一步澄清要与工作流问答保持一致，消息仍应可见；本轮按该结果替换 E40 尚保留的独立接收分支。对象为 `feat/multi-agent-v2-main@69494d27` 加工作树；E39/E40 保留其当时证据，现行呈现以本节和 spec 为准。
- V4 行分发删除图标、标签、右侧发件人、正文及身份说明的独立 JSX，只将已有消息字段、稳定 key、名称和主题传入原 `WorkflowNotificationToolRow`。原入口增加仅限 UI 的 `agentMail` 数据适配，与真实工作流提问共用通知行、正文及背景说明；Workflow wire union、run/qid、邮箱、模型可见原文和消费时机未改。普通邮件不产生 Workflow 回答状态、运行链接或等待计时，真实问答仍按其原状态呈现。
- 删除 `agentCommunication.*` 四个自定义 key 及中英文文案，不再显示“接收消息 / 完成汇报 / 来自”这一套分类。来信与结果使用已有“消息 / 任务输出”标签，名称使用原 sourceLabel 来源标记，正文和真实名称/路径在原正文/背景面板中保留。统一来源标记保持单行，不在右侧另画发件人。
- 最终 UI 定向回归 **7 文件 129/129 PASS，exit 0**：代理控制/来信、原发送工具、原通知、原回答、ToolLayout、Workflow 留白与产物 chips。断言实际进入原通知根节点、独立 V2 根节点消失、原有标签与来源标记、完整正文/身份、跨会话开合，以及普通邮件即使收到真实 Workflow pendingQids/onOpenRun 参数也不伪装成已回答/等待或显示运行链接。根类型、Lint、格式、变更架构及 `git diff --check` 均 exit 0；Lint 0 errors / 96 warnings，架构 0 违规。
- 本轮容器执行 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；主体 `61,217ms`，含构建/准备共 `188,634ms`。深色中文 `1440×900`、浅色英文 `1100×900` 及深浅/中英 `390×844` 下，实际原通知入口、原“任务输出”标签、独立 V2 根节点不存在、完整正文/身份、来源单行和展开收起均通过，并复看本轮折叠与展开截图。390 是共享组件的 renderer emulation 检查，不外推为手机 `/remote` 独立端到端验收。
- 同一容器场景仍通过四层代理树、Main Stop 后子孙继续、详情暂停/原身份续接、暖续接和真实进程冷重开；23 个不同本地 fixture 请求均 complete/200，`externalLlmVerified=false`。仅在 Docker 虚拟桌面执行，network 为 `none`，未操作真机窗口或输入设备，测试容器已退出清理。
- Linux x64 / Node `24.14.0` / pnpm `10.33.2`；75 个源码、配置和测试文件的镜像/宿主 SHA-256 一致，执行后无源码漂移。证据位于 `/tmp/zcode-notification-entry-20261027-kiuma3a1/`：`unit-final.log`、`typecheck-final.log`、`lint.log`、`format-check.log`、`architecture-final.log`，`container.log`、`artifacts/summary.json`、`artifacts/v2-native/evidence.json` 与截图，以及源码/隔离核对 JSON。临时证据不承诺长期保留。未重跑全仓测试，项目整体仍为 PARTIAL；未提交、未推送，原有修改及未跟踪文件保留。

### E42：稳定名称颜色与复用 Workflow 头像（2026-10-28）

- 对象仍为 `feat/multi-agent-v2-main@69494d27` 加工作树。名称使用原 `subagentColors` 配色，同一昵称在来信、发信目标、目录、运行列表、详情和各层标签保持同色；任务描述不参与选色，不增加持久化状态或颜色设置。八色可复用，颜色只辅助识别，不能替代名称或真实运行状态。
- 直接复用 `WorkflowAgentFace` 的小方脸、眼睛、动效和减少动态效果规则；新增纯展示适配 `SubagentAvatar`，以名称颜色填充机身。原 Workflow 的编号/九色选择不变。普通代理头像不从历史消息猜测当前执行状态，实际状态文字和控制沿原链路。
- 首轮容器断言 1/1 通过，但截图复核发现原头像的 20px 最小尺寸撑高了紧凑名称标记；随后仅在普通代理头像适配中放开该下限，并补充通知头像实际宽度为 12px、与名称同色的浏览器断言。首次结果及截图保留，未把断言通过代替视觉检查。
- 最终 UI 定向回归 **9 文件 145/145 PASS，exit 0**，覆盖原 Workflow 头像/药丸、名称跨消息与面板的颜色一致性、任务改名后的稳定色、收发消息及代理控制。根类型、Lint、格式、变更架构及 `git diff --check` 均 exit 0；Lint 0 errors / 96 warnings，架构 0 违规。
- 最终容器 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；主体 `65,058ms`，含构建/准备共 `199,642ms`。深色中文 `1440×900`、浅色英文 `1100×900` 及深浅/中英 `390×844` 的通知头像真实尺寸、名称同色、单行边界和完整正文开合通过；复看本轮桌面折叠、浅色窄屏及树/子窗口截图。390 为共享组件 renderer emulation，不代表独立手机 `/remote` E2E。
- 同一场景继续通过四层代理树、Main Stop 隔离、用户暂停/原身份续接、暖续接和进程冷重开。23 个本地 fixture 请求，`externalLlmVerified=false`；仅在 Docker 虚拟桌面执行，network 为 `none`，未操作真机窗口或输入设备，最终容器已退出。
- 最终镜像 Linux x64 / Node `24.14.0`；84 个变更/新增文件的镜像及执行后宿主 SHA-256 一致。证据位于 `/var/folders/g4/g3pzp24j5nbcdqw34g74pdr40000gn/T/zcode-agent-avatar-20261028-qc83qh3i/`：`unit-final.log`、`typecheck-final.log`、`lint-final.log`、`architecture-final.log`、`format-check-final.log`、`container-final.log`、`final-artifacts/summary.json`、`final-artifacts/v2-native/evidence.json` 与截图，以及源码/隔离核对 JSON。首次 `artifacts/` 与 `container.log` 保留。证据不承诺长期保留。
- V2 与 Workflow 的触发及通信差异本轮仅核对源码：V2 按委派策略自由派发/等待，普通消息不唤醒空闲目标；Workflow 仍按原说明由用户点名发起，正式问答绑定运行中的问题状态。本轮未改变触发策略，未重跑全仓测试，整体仍为 PARTIAL；未提交、未推送，无关修改和未跟踪文件保留。

### E43：普通代理头像恢复双眼（2026-10-28）

- E42 的普通头像统一传入未知状态，原 `faceState(undefined)` 会返回等待态，故所有身份标签均显示三个点。这是接入方误用表情语义，头像绘制和眼睛资源并未缺失；E42 的运行及截图证据保留。
- 普通代理未知状态改用中性双眼及既有眨眼/侧看动作，不伪造 running。目录与运行列表传入已有真实状态，running、success、failed 对应原运行/成功/失败表情，waiting/blocked 才用三点；cancelled/lost 不猜执行结果。原 Workflow 默认状态、颜色及动效保持原语义，不新增状态 Owner、订阅或持久化。
- UI 定向回归 **9 文件 147/147 PASS，exit 0**，含未知头像连续 60 秒受控时钟下保持双眼、眨眼/侧看及卸载取消计时器，真实状态切换、颜色稳定与原 Workflow 回归。根类型、Lint、格式、变更架构及 `git diff --check` 均 exit 0；Lint 0 errors / 96 warnings，架构 0 违规。
- 容器 **1/1 PASS、0 FAIL、0 skipped，exit 0**，无自动重试；主体 `69,169ms`，含准备共 `218,409ms`。四组深浅/中英/宽窄尺寸中，浏览器实际检查双眼表情、两个眼睛图形可见、12px 头像及名称同色；复看本轮桌面、子窗口及浅色窄屏截图。四层树、停止隔离、原身份续接及冷重开仍通过。390 宽度为共享组件 emulation，不代表独立手机远控 E2E。
- 85 个变更/新增文件的镜像及执行后宿主 SHA-256 一致。Linux x64 / Node `24.14.0`；23 个本地 fixture 请求，`externalLlmVerified=false`。只在 Docker 虚拟桌面执行，network 为 `none`，容器已退出，未控制用户真机桌面。
- 证据位于 `/var/folders/g4/g3pzp24j5nbcdqw34g74pdr40000gn/T/zcode-agent-eyes-20261028-34f48zao/`：`unit.log`、`typecheck.log`、`lint.log`、`architecture.log`、`format-check.log`、`container.log`、`artifacts/summary.json`、`artifacts/v2-native/evidence.json` 与截图，以及源码/隔离核对 JSON。临时证据不承诺长期保存。本轮未重跑全仓测试，项目整体仍为 PARTIAL；未提交、未推送，无关修改与未跟踪文件保留。

## 历史 A 交接证据（E0–E14，保留当时状态）

以下记录的 A 源码截至 `e57e3b6`；当时后续 C budget、Main config/Host/UI 补丁不在 A 快照内。旧执行 ID、失败与“待跑”描述只代表当时结果；当前状态以 E15 之后的本轮证据为准。

### 历史证据等级与已执行结果

- **Core 实测**指 Main 在 Mac 执行正式 TypeScript 源码的自动测试。Registry/controller/runner/AgentRuntime、临时文件写入和事件流是真实执行；Model 与 SessionStore 在相应用例中为明确注入的本地 fixture。它不代表真实 LLM、外部 Provider、SQLite 进程重启或原生 UI 已运行。
- **部分实测**表示已有已执行断言覆盖部分契约；整项仍为 `NOT_PROVEN`，不得把静态实现补成 PASS。
- **增量待跑**只有本地 `node --check` 和 `git diff --check` 成功。A 环境无依赖，未声称 TypeScript 编译或 Vitest 通过。
- **Main/C Owner**表示实现/最终证据在另一工作树，不能从 A 的文件存在推断验收通过。

| 证据 | 实际执行与结果 | 适用边界 |
| --- | --- | --- |
| E0 | 能力测试 HTML 独立创作；Main 原样写入 Mac，执行 `1a73cb68-32c8-41a6-bb7c-81956cb0cbf3` exit 0 | 按说明不联网、不预览、不测试、不读取他人 HTML；仅证明能力门槛任务完成 |
| E1 | Mac execution `77d0edc7-c54d-424b-a9d9-45c22b53ae7f`：contracts 重建后 97/97 PASS：control 24、Runtime 8、context 53、prompt 12 | 含 4/8/16、failed resume、后台 finalization fence、Stop mailbox、固定 wait 契约；尚不含 fce6da7/83508b2/a5bca44 |
| E2 | Mac execution `cc1c8c0b-d8ae-4e0a-9f8b-3410772f9ff2`：Core typecheck PASS；4 suites 62/62 PASS：control17、Runtime7、persistence7、Board31 | 包含 cold 原始 ID、prefix、Main Stop、预算/usage；Board 为 C 所有。与 E1 有重叠，不能相加为独立测试总数 |
| E3 | Mac execution `a506188f` exit 0：contracts build、Core typecheck 与 54/54 PASS：control31、Runtime8、C budget15 | 含 initiator activity、动态 wait、前台/后台 finalization fence；同先前 suite 重叠，不相加 |
| E3b | Mac execution `5dc50a61-d5fa-4218-81c0-3eef04cd7e4e` exit 0：Core typecheck + 57/57 PASS：admission18/control31/Runtime8 | C证实含 2c3a05e 继承generate/stream正确归属与吞flush错误后的重试fence；与E3重叠，不重复计总数 |
| E4 | Mac execution `1b17883c-296b-4560-8b4d-7998adc16941`：contracts build、Core typecheck；runtime-compact71、V2Runtime10、context55、prompt12 共148/148 PASS；Main另报config76 PASS | 含 reactive/auto→同turn→cold followup，child own prefix保留且不重放原fork；Model仍为注入fixture，无Provider cache实验 |
| E5 | Mac execution `b55c30ec-3415-4038-9271-856ba04634b1`：真实SQLite writer exit0，fresh reader exit1，FAIL：首模型请求缺少已恢复的idle mail | 原ID、cold lost/residentfalse、pending mail存在的前置断言已过；整体测试FAIL，不把前置断言冒作完整恢复PASS |
| E6 | `236581a`、`e3f85f6` 修复 V2 startup mailbox 时序与旧 steering unit 无 config；后续 E9 的 queue3 与 E11 真实 SQLite 用例已过 | 首 model step 按 turn/generation/sink fence 同步进入既有 steer + 持久 ack，不用 10ms 重试掩盖短 turn 竞态 |
| E7 | Main全Core回归 execution `780528d6…`：4286 PASS / 2 FAIL / 21 skipped，279 suites，86.72s | A steering 旧 fixture 缺失 config 与 node-repl browser injection 两项已在 E9 针对性回归通过；完整 Core 套件未收到重跑结果，不能报全套 PASS |
| E8 | Mac execution `835777cf-52a7-4a53-8246-56656f00c9e1`：contracts/adapters/Core类型PASS，Board remote10 PASS；SQLite原缺mail断言通过，reader随后因base mode build不等于旧单轴plan断言而FAIL | 源码核对为基础mode与planEnabled双轴；a2eb81a改为正式execution entry双轴断言。该命令使用&&，后续Core suites未运行，不能算通过 |
| E9 | Mac RED `c4c01f29-9958-4534-912a-3b0f34fc349c` exit1：1 FAIL/10 skipped，真实Write权限context.planEnabled=false；GREEN `d550795e-52f0-425c-9feb-ee40fced5d2d` exit0：V2Runtime11/prompt17/browser9/queue3 共40 PASS | 0497bb3先验证缺陷，0829108再收紧hydrate后的双轴状态；也验证旧queue fixture兼容修复。不是整套Core重跑总数 |
| E10 | Mac RED `bc5d9fd9-9352-4fd9-adf2-2728fcb8d1a9` exit1：Build→Guarded、Auto→edit 两个真实权限反例；8caa216 后 GREEN `7a2e2904`：Board34 + admission18 + V2Runtime13 共65 PASS，随后同执行 adapter V2SQLite1 PASS | 独立 inheritedPlanEnabled 快照、base mode 交集以及新版真实 SQLite 权限快照断言均已过；不是 65 个全新测试，不能与旧批次相加 |
| E11 | Mac execution `66d50ffb-ec76-407f-877a-01ee80547f81`：3/3 PASS，V2 真实 SQLite 独立 OS 进程恢复 1 + C Board 磁盘进程恢复 2 | 关闭真实 SQLite、writer 进程退出、不同 reader PID 恢复原 ID/上下文/mail/权限/lost 状态；本地 Model fixture，不是外部 Provider。该批次在 E10 产品修复之前；E10 随后又通过 V2 SQLite 新权限快照断言 |
| E12 | Mac RED `b84b139d-2cdc-4533-9fda-59809cb06574` exit1：非空/空指导两例均发现 Root 指导泄漏；A 217c822 透传与 Main 优先链后 GREEN `2f18552a-da1c-41ba-92f9-a73b5c64cf3c` exit0：Runtime15 + prompt17 共32 PASS | specialist parent→默认 grandchild→Root lazy rebind followup→冷恢复 Root 新 override；原指导含有效空串均保持，原 agent/session ID 不变。Model 为本地 fixture |
| E13 | Mac execution `245220fa-2446-45e4-a280-8a8e98791ce2` exit0：选定 4 例 PASS、15 例 skipped（文件共19）；只计选定的4例 | local/native × gates 开/关，正式 Runtime 验证六工具无重复、Schema 相等、真实目录投影、子代理许可收窄、违规调用拒绝和合法 list；不是 Code Mode 或外部 Provider 证据 |
| E14 | Main execution `3995c454`：全 CLI 32/32 包 typecheck PASS；lint 0 error / 70 warnings；完整 test 因缺少 tsx 提前停止 | Main 已补齐仓库锁定 tsx4.21.0，完整测试正在 `92b0d6f5` 重跑；未收到最终结果，不报全套 PASS，未运行用例不计通过 |

能力产物：`/Users/aizou/Desktop/工作台/能力测试-禁止参考本目录下的html/20261026123848711902.html`。云端独立副本：`/workspace/scratch/f2a8b10a54ea/capability-a/20261026123848711902.html`。

## 正式 Owner 与消费者

| Owner | 生产源码入口（仓库根相对路径） | 职责 |
| --- | --- | --- |
| 契约 | `apps/zcode-cli/packages/contracts/src/multi-agent/index.ts`、`interfaces/session.port.ts`；`packages/shared/src/zcode-protocol/index.ts`、`zcode-protocol-v4/command.ts` | 六工具、持久图与原控制 Port；既有公开取消入口的 scope 和逐任务回执 |
| 唯一状态 Owner | `apps/zcode-cli/packages/core/src/runtime-task/registry.ts` | identity/path、generation、邮箱、执行/驻留、reported usage，session scoped facade |
| 行为控制 | `apps/zcode-cli/packages/core/src/multi-agent/controller.ts`、`handler.ts` | 原子准入、六操作、schema/门控、wait/steer/路径边界 |
| 持久投影 | `apps/zcode-cli/packages/core/src/multi-agent/persistence.ts` | root session entry；不是第二数据库；hydration validation、cold lost、消费锚点 |
| 用量 | `apps/zcode-cli/packages/core/src/multi-agent/budget.ts`、`runtime/methods/usage-observability.ts` | reported usage 幂等归账与后续请求阻断；C 的统一 Model handle 18测试已过，含继承包装所有权与flush错误重试fence |
| 原执行器 | `apps/zcode-cli/packages/core/src/subagent/runner.ts` | 原环境/原身份续接、取消与 generation fence、父级通知、root事件/initiator活动 |
| Runtime 接线 | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`、`steering.ts`、`context-refresh.ts`、`background.ts` | 真实子 Runtime、fork/model/权限、消费持久 ack、prefix 恢复；显式范围取消复用原 Registry/task control |
| 自动行为证据 | `apps/zcode-cli/packages/core/tests/multi-agent-v2*.test.ts`；`apps/zcode-cli/packages/adapters/tests/multi-agent-v2-sqlite-process.test.ts`；`apps/zcode-cli/packages/bootstrap/tests/multi-agent-v2-{scoped-stop,reading-fixture}.test.ts` | E16 覆盖当前集成树的控制/Runtime、SQLite 独立进程、App/V4 范围停止及 Read 读取；Model 是本地替身，边界见 E16/E18/E19 |

## MA01–MA36 逐项映射

下表逐项保留原 ID 与关联。`PASS（本地…）` 只表示注明的自动边界通过；`PARTIAL` 表示同一条要求仍有未覆盖部分。E16 是当时集成树复跑，后续增量结果见 E25–E30；E0–E14 只补充历史根因，不能相加成独立测试总数，也不能将 108 个重叠视角当作 108 项互不相关能力。

| MA | V2 聚合 | T / S 场景 | 当前本地证据状态 | 实际完成与剩余边界 |
| --- | --- | --- | --- | --- |
| MA01 | V2-01/02 | T01 | PASS（本地自动） | 六工具 spawn 即时返回规范路径，真实 Registry/runner 仍 running；不能把接受当完成。 当前相应用例由 E16 复跑。 |
| MA02 | V2-03 | T03/04 | PASS（本地自动） | 规范/相对路径、agent ID、跨根拒绝与重名拒绝；控制器在 await 前预约。 当前相应用例由 E16 复跑。 |
| MA03 | V2-03/12/17 | T03/11 | PARTIAL | 同根路径、跨根拒绝、同级 initiator 与消息控制由 E16 复跑；真实外部模型双向逐字对话受本轮边界限制。 |
| MA04 | V2-04 | T02 | PASS（本地自动） | 实际 AgentRuntime 连续派生 /root/a/b/c/d，未沿用 V1 固定深度上限。 当前相应用例由 E16 复跑。 |
| MA05 | V2-05 | T05/06 | PASS（本地自动） | all/none 控制分支、实际 child request 含父可见历史、fork_context 拒绝。 当前相应用例由 E16 复跑。 |
| MA06 | V2-06 | T05/19 | PARTIAL | reasoning/孤立工具结果过滤、preserveForkPrefix 两模式与冷续接已测；reactive/auto compact同turn与cold恢复修复已实测；真实Provider归一化/cache未测。 当前相应用例由 E16 复跑。 |
| MA07 | V2-07 | T07/22 | PARTIAL | custom worker Profile 与 Explore 真实 Runtime 请求已测；全部自定义角色组合不等于已穷尽。 当前相应用例由 E16 复跑。 |
| MA08 | V2-08 | T07/26 | PARTIAL | 实际 selection provider/model/effort 继承覆盖、full fork 禁止覆盖已测；Provider 为注入 Model factory 的身份值，不是外部调用。 当前相应用例由 E16 复跑。 |
| MA09 | V2-09/26 | T22 | PARTIAL | 有效工具/权限交集、cwd/AGENTS、Plan 独立轴及 Build/Auto 恢复收窄有 E16 自动证据；真实 MCP 审批、系统执行权限与原生安全交互矩阵未覆盖。 |
| MA10 | V2-10 | T08 | PASS（本地自动） | idle QueueOnly 不创建执行，pending mailbox 保留；Stop 落盘交错不丢已接受邮件。 当前相应用例由 E16 复跑。 |
| MA11 | V2-11 | T09/10/25 | PASS（本地+SQLite进程） | 原 identity/session 续接、并发 followup 单一恢复、failed identity 复用与 running Root followup 拒绝已测；E11 完整跨进程 case 通过，包含恢复后的首请求 mail；权限/指导增量分别已有 E10/E12 实测。 当前相应用例由 E16 复跑。 |
| MA12 | V2-03/10/11 | T03/11 | PASS（本地自动） | 统一根内 resolver，拒绝 parent traversal/另一 root ID；同级用完整路径。 当前相应用例由 E16 复跑。 |
| MA13 | V2-17/20/21 | T08/19/23 | PASS（本地+SQLite进程） | pending FIFO/dedupe、消费锚点、Stop 写入期间 mail 保留已测；SQLite startup 竞态修复后 E11 完整通过，首请求读到原 mail 且消费后不残留；不宣称分布式 Exactly-Once。 当前相应用例由 E16 复跑。 |
| MA14 | V2-13 | T12/13 | PASS（本地自动） | 先订阅后检查、早到活动、steer、超时/取消、无消息正文、默认边界已测；动态三时限配置和组合校验已实测。 当前相应用例由 E16 复跑。 |
| MA15 | V2-12/15 | T14 | PASS（本地自动） | 同根 list、path_prefix、completed 输出、已卸载身份仍可列举。 当前相应用例由 E16 复跑。 |
| MA16 | V2-14/15 | T15/17 | PASS（本地自动/API） | interrupt 原 previous_status/root/self 边界、身份续接和旧结果 fence 由 E16 复跑；新增显式 task/subtree/tree 经 E18 真实 App/V4/Runtime/SQLite 验证。原生范围控件未验。 |
| MA17 | V2-01/02/13/14 | T01/07/12/15 | PASS（本地自动） | 严格入参、六操作输出字段、namespace 与 Provider 64字节别名；并非全部错误分支逐 Provider 实测。 当前相应用例由 E16 复跑。 |
| MA18 | V2-10/11/17 | T10/23 | PASS（本地自动） | steer 接受仍保留邮件，persistUserPrompt 消费锚点后 ack；UI 不伪造已读。 当前相应用例由 E16 复跑。 |
| MA19 | V2-16 | T24 | PASS（本地自动） | 父级 FINAL_ANSWER 与非父级 initiating session/turn 的 metadata-only Completed activity 已实测；后者不泄露正文或唤醒idle。 当前相应用例由 E16 复跑。 |
| MA20 | V2-18/19/21/22 | T02/20/21 | PASS（本地自动） | 既有 root RuntimeTaskRegistry 唯一 mutable Owner；session facade 分离普通枚举与 branch epoch，controller 不持平行 graph。 当前相应用例由 E16 复跑。 |
| MA21 | V2-20/21 | T18/19 | PARTIAL（原生冷恢复已验） | E27 在真实进程退出及重启后保留原身份、历史和排队邮件并续接；独立 Host 断线重连及完整权限环境仍需另证。 |
| MA22 | V2-19/20 | T19/20 | PASS（本地自动） | execution/residency 独立预算；终态统一 Owner hook 释放；完成父 Runtime lazy rebind 到 root，保环境/邮箱。 当前相应用例由 E16 复跑。 |
| MA23 | V2-04/19 | T02/20 | PASS（本地自动） | 默认4含root，8/16并发准入与达限释放已测，无固定3层上限。 当前相应用例由 E16 复跑。 |
| MA24 | V2-22 | T21 | PARTIAL | 主/子 reported usage 与根预算、C统一Model handle 18tests已过，覆盖工具内Model准入/计账、继承父Model再包装的正确归属、吞flush错误重试fence。未报告usage、在飞请求费用/service tier外部实验不在此证据内。 当前相应用例由 E16 复跑。 |
| MA25 | V2-18 | T04/10/15/20 | PASS（本地自动） | setup Stop、容量预约、并发续接、背景落盘 fence/mailbox 已测；前台 artifact fence 4个交错场景已实测。 当前相应用例由 E16 复跑。 |
| MA26 | V2-08/09/26 | T07/19/22 | PARTIAL | 有效模型快照、原环境恢复、权限双轴交集及默认孙代理冻结 developer guidance 有实际回归；实际多 Provider 选项、安全审批环境矩阵未测。 当前相应用例由 E16 复跑。 |
| MA27 | V2-07/25 | S-T01–12 | PARTIAL | Root/Child/Grandchild、Profile、权限优先级、门控/namespace、compact/续接及 custom/workflow 的请求和模板断言由 E16 覆盖；E32 增加单模型、明确点名工具的协作实测。完整 S-T 模型行为、跨 Provider、token/cache 实验仍未完成。 |
| MA28 | V2-23/24 | T07/29/S-T04 | PARTIAL | 配置门控、wait 三时限、namespace/model override/metadata/prefix 及 usage hint 的现有自动回归由 E16 覆盖；不把配置字符串/fixture 等同于真实 Provider 能力。 |
| MA29 | V2-24/30 | T26/27 | PARTIAL（Code Mode条件不触发） | 原生六工具已测；已有 ToolSearch local/native 真实对照 E13 已过。依据 A7/411 和现有 CLI 执行面审查，Code Mode 无对应通用工具执行模式，条件不触发；未将 ToolSearch 叫作 Code Mode，也未把外部 Provider 验证记 PASS。 当前相应用例由 E16 复跑。 |
| MA30 | V2-08/29 | T07/26/28 | PARTIAL | 实际有效model/effort与用量归属进入Registry事件；root可取四层生命周期/usage；E27 覆盖部分原生 UI，E32 增加指定模型的真实主子孙调用；完整模型矩阵及其余场景仍需另验。 |
| MA31 | V2-13 | T13 | PASS（本地自动） | 用户steer sequence唤醒 wait，取消wait不停止已准入后代。 当前相应用例由 E16 复跑。 |
| MA32 | V2-30 | T16 | PARTIAL（原生 Main Stop 已验） | E30 原生桌面前台 A、后台 B、孙 C 的 fixture 组合通过；E32–E33 真实模型覆盖单子代理及两子一孙同时运行时的 Main Stop；E18 验证显式范围取消。原生整树范围选择控件尚未覆盖。 |
| MA33 | V2-28/29 | T28 | PARTIAL（原生场景已验） | E27 覆盖原生树、详情暂停与续接、Main Stop、暖续接和真实冷重启；E32–E33 增加真实模型的子代理控制及多级 Main Stop。Host 单独断线重连及完整客户端/模型矩阵仍未覆盖。 |
| MA34 | V2-27 | Board附加场景 | PARTIAL | E16 包含 Board 控制器、Host 门控、remote HTTP adapter 与真实 SQLite 跨进程用例；远端测试依赖本地服务替身，不是实际部署 Board 端到端通过。 |
| MA35 | V2-15/16/21 | T01/14/24/25 | PASS（本地自动） | 结果/OutputFile保留原身份，终态不删邮箱；续接新generation/原session，旧结果fence。 当前相应用例由 E16 复跑。 |
| MA36 | V2-09/26 | T22/S-T03/10 | PARTIAL | 有效工具、Explore 限制、Profile/恢复 ceiling 和委派模式请求有 E16 断言；真实模型授权行为及高风险 MCP/系统审批矩阵未完成。 |

## V2-01–V2-30 逐项映射

| V2 | MA 细项 | 当前本地证据状态 | 说明 |
| --- | --- | --- | --- |
| V2-01 | MA01, MA17, MA20 | PASS（本地自动） | 六工具复用原 Owner，E16 全 CLI 回归包含旧 Agent/Task/Workflow 等正式消费者；局部自动通过不代替原生/外部总体验收。 |
| V2-02 | MA01, MA17 | PASS（本地自动） | task_name/message/fork/override schema与结果字段。 当前相应用例由 E16 复跑。 |
| V2-03 | MA02, MA03, MA12, MA25 | PASS（本地自动） | 路径、根隔离、唯一性。 当前相应用例由 E16 复跑。 |
| V2-04 | MA04, MA23 | PASS（本地自动） | 实际Runtime达到/root/a/b/c/d。 当前相应用例由 E16 复跑。 |
| V2-05 | MA05 | PASS（本地自动） | all/none默认与fork_context拒绝。 当前相应用例由 E16 复跑。 |
| V2-06 | MA06 | PARTIAL | 历史清理/prefix/cold已测，reactive/auto compact修复已实测；Provider cache未测。 当前相应用例由 E16 复跑。 |
| V2-07 | MA07, MA27 | PARTIAL | general/custom/Explore 请求与原角色保留由 E16 覆盖；完整提示词专项见 S-T，模型行为另证。 |
| V2-08 | MA08, MA26, MA30 | PARTIAL | 真实Runtime有效selection；无外部Provider请求。 当前相应用例由 E16 复跑。 |
| V2-09 | MA09, MA36 | PARTIAL | 有效工具、权限快照、Plan 独立轴与 Build/Auto 恢复交集由 E16 覆盖；真实 MCP/审批和系统边界仍未验。 |
| V2-10 | MA10, MA12, MA18 | PASS（本地自动） | QueueOnly、Stop期间mail保留。 当前相应用例由 E16 复跑。 |
| V2-11 | MA11, MA12, MA18 | PASS（本地+SQLite进程） | 原身份续接/并发/失败恢复与 root 全状态拒绝已过；E11 完整验证 SQLite 跨进程原 ID 与首请求 mail。 当前相应用例由 E16 复跑。 |
| V2-12 | MA15, MA35 | PASS（本地自动） | path_prefix与已卸载状态。 当前相应用例由 E16 复跑。 |
| V2-13 | MA14, MA31 | PASS（本地自动） | 固定wait与三时限动态配置契约已过。 当前相应用例由 E16 复跑。 |
| V2-14 | MA16 | PASS（本地自动/API） | interrupt 的 root/self 拒绝、previous_status 与续接由 E16 复跑；显式 subtree/tree 公开取消另由 E18 覆盖，不扩大模型 interrupt 工具的范围。 |
| V2-15 | MA15, MA16, MA21, MA35 | PASS（本地自动） | running/completed/errored/interrupted映射；cold lost准确展示。 当前相应用例由 E16 复跑。 |
| V2-16 | MA19, MA35 | PASS（本地自动） | 父级终态mail与initiator Completed activity已过，正文/活动按正式消费者区分。 当前相应用例由 E16 复跑。 |
| V2-17 | MA13, MA18 | PASS（本地+SQLite进程） | 未消费保留、FIFO/dedupe、transcript anchor 恢复与跨进程 startup mailbox 由 E11 完整验证；不外推为分布式投递保证。 当前相应用例由 E16 复跑。 |
| V2-18 | MA20, MA25 | PASS（本地自动） | reservation/setup/Stop与generation fence；前台/后台artifact交错回归已过。 当前相应用例由 E16 复跑。 |
| V2-19 | MA20, MA22, MA23 | PASS（本地自动） | root执行计数与4/8/16容量。 当前相应用例由 E16 复跑。 |
| V2-20 | MA13, MA21, MA22 | PASS（本地自动） | 终态卸载/释放、root lazy execution binding恢复。 当前相应用例由 E16 复跑。 |
| V2-21 | MA20, MA21, MA35 | PARTIAL（冷重启已验） | E27 在原生进程退出并重启后保留身份、历史与邮箱并续接；Host 单独断线重连仍需证据。 |
| V2-22 | MA20, MA24, MA30 | PARTIAL | reported usage根汇总与统一Model边界18tests已过，含继承包装归属/flush-failure重试fence；成本/service tier未实测。 当前相应用例由 E16 复跑。 |
| V2-23 | MA28 | PARTIAL | 配置、注册、模型可见工具、namespace/override/wait/usage hint 的现有自动矩阵由 E16 覆盖；原生配置交互与真实模型效果未验。 |
| V2-24 | MA17, MA28, MA29 | PARTIAL | metadata/override gate 已测；ToolSearch local/native 的实际目录/Schema/许可对照 E13 已过；Code Mode 条件不触发，不宣称实现了其桥接或曝光开关。 当前相应用例由 E16 复跑。 |
| V2-25 | MA27 | PARTIAL | E16 请求/模板回归验证角色、授权、compact 与默认孙代理指导在 rebind/cold restore 保留（含空串）；完整 S-T 外部模型行为仍受阻。 |
| V2-26 | MA09, MA26, MA36 | PARTIAL | 绑定/权限继承已实现；真实MCP/沙箱/跨Provider重载未证。 当前相应用例由 E16 复跑。 |
| V2-27 | MA34 | PARTIAL | E16 含 Board/Host/HTTP adapter 与真实 SQLite 进程恢复；真实远端服务部署、网络与授权环境未验。 |
| V2-28 | MA21, MA33 | PARTIAL（原生冷恢复已验） | E18 验证生产 App/V4/Runtime/SQLite 范围取消；E27 覆盖原生详情控制和冷重启；Host 独立断线重连及原生范围选择控件未验。 |
| V2-29 | MA30, MA33, MA35 | PARTIAL | E27 覆盖原生树路径、层级、详情、状态与冷续接；真实外部 token/cache 及完整模型矩阵仍无证据。 |
| V2-30 | MA29, MA32 | PARTIAL | 本地停止/恢复、请求/Schema、E19 区间阅读及 E27 原生 Main Stop 已验；跨 Provider、Codex B 明文、原生范围选择和实际 Board 服务仍未闭合。 |

## T01–T30 实测场景映射

| T | MA | V2 | 当前本地证据状态 | 精确覆盖/未覆盖 |
| --- | --- | --- | --- | --- |
| T01 | MA01/17/35 | V2-01/02/15 | PASS（本地自动） | 异步接受/结果分离；实际Runner及Runtime结束。 当前相应用例由 E16 复跑。 |
| T02 | MA04/20/23 | V2-04/19 | PASS（本地自动） | 实际递归到/root/a/b/c/d，root事件路径完整。 当前相应用例由 E16 复跑。 |
| T03 | MA02/03/12 | V2-03 | PASS（本地自动） | 短名、绝对路径、ID、跨root拒绝；同级initiator案例已过。 当前相应用例由 E16 复跑。 |
| T04 | MA02/25 | V2-03/18 | PASS（本地自动） | 重名拒绝与同步reservation；并发8/16压力验证槽位原子性。 当前相应用例由 E16 复跑。 |
| T05 | MA05/06 | V2-05/06 | PASS（本地自动） | 父可见历史真正进入child request，prefix true/false。 当前相应用例由 E16 复跑。 |
| T06 | MA05 | V2-05 | PASS（本地自动） | none不携带forkHistory，独立task/env/policy。 当前相应用例由 E16 复跑。 |
| T07 | MA07/08/26/28/30 | V2-07/08/23 | PARTIAL | E16 覆盖 Profile/override/inherit/effort 及非法 fullfork；E32 验证指定模型的主子孙继承，完整 Profile/override 和其他 Provider 仍未实测。 |
| T08 | MA10/13 | V2-10/17 | PASS（本地自动） | idle/terminal QueueOnly不产生新执行，mail仍归原身份。 当前相应用例由 E16 复跑。 |
| T09 | MA11 | V2-11 | PASS（本地自动） | followup原id/session的新generation，实际Runtime还原transcript。 当前相应用例由 E16 复跑。 |
| T10 | MA11/18/25 | V2-11/17/18 | PARTIAL | E16 覆盖并发 followup、generation、消费锚点/去重；未单独证明真实副作用工具在连续模型故障/恢复中的整个应用场景。 |
| T11 | MA03/12 | V2-03/10 | PARTIAL | E16 覆盖同根 peer 解析、消息及 initiator 控制行为；双向真实模型中文/特殊符号全文往返受外部模型边界限制。 |
| T12 | MA14 | V2-13 | PASS（本地自动） | 任意当前mailbox活动唤醒，无target、无正文返回。 当前相应用例由 E16 复跑。 |
| T13 | MA14/31 | V2-13 | PASS（本地自动） | 早到、steer、默认边界、动态三时限一致性已过。 当前相应用例由 E16 复跑。 |
| T14 | MA15/21/35 | V2-12/15/20 | PASS（本地自动） | pathprefix及卸载completed身份。 当前相应用例由 E16 复跑。 |
| T15 | MA16/25 | V2-14/18 | PASS（本地自动） | previous_status、原身份续接、旧背景结果fence；前台扩展亦已过。 当前相应用例由 E16 复跑。 |
| T16 | MA32 | V2-30 | PASS（原生回放与单模型实机） | E30 在真实桌面链路验证前台 A、后台 B、孙 C 在 Main Stop 后继续，模型为本地 fixture；E32–E33 使用指定真实模型验证单子代理及两子一孙的 Main Stop。真实模型场景均为合成任务，未覆盖旧 Agent 与 V2 的混合组合。 |
| T17 | MA16 | V2-14/28 | PARTIAL（公开范围已验） | 用户确认的 task/subtree/tree 已贯通共享 wire、legacy/V4、App 与原 Runtime；E18/E16 验证 Main-only、子树兄弟隔离、整树 Main/后代、跨根拒绝、部分失败、自然完成竞态、身份续接与旧结果 fence。普通 Main Stop 范围不变；原生 UI 范围操作未验。 |
| T18 | MA21 | V2-21/28 | PARTIAL（原生冷重启已验） | E27 验证旧 Electron/Host/CLI 进程退出、冷重开无幽灵运行行及原身份续接；独立 Host 断线重连尚未单独执行。 |
| T19 | MA13/21/22 | V2-17/20/21 | PARTIAL（原生冷续接已验） | E27 验证原身份、历史和排队邮件经真实冷重启后续接；完整权限、MCP 及独立 Host 重连环境尚未逐项覆盖。 |
| T20 | MA22/23 | V2-19/20 | PASS（本地自动） | 4默认、8/16同时spawn、独立residency上限、终态释放。 当前相应用例由 E16 复跑。 |
| T21 | MA24 | V2-22 | PASS（本地reported usage） | root+child耗尽无后续Model调用、工具内Model统一边界、继承包装所有权、flush失败重试fence已过；实际外部服务账单不在fixture证据范围。 当前相应用例由 E16 复跑。 |
| T22 | MA09/26/36 | V2-09/26 | PARTIAL | E16 验证 Explore/有效工具及恢复权限 ceiling/双轴交集；真实 MCP、审批交互、系统高风险执行未纳入本轮已运行证据。 |
| T23 | MA13/18 | V2-17 | PASS（本地+SQLite进程） | 已接受/steered 不作已消费，anchor 后 ack 与冷重放去重已测；E11 完整 SQLite 用例通过首请求 startup mailbox 与消费断言。 当前相应用例由 E16 复跑。 |
| T24 | MA19/35 | V2-16 | PASS（本地自动） | 子代理成功与错误结果按原身份交付；V2 停止仅发布真实状态活动，不伪造 FINAL_ANSWER。普通邮件与最终答复遵循 E25 的 QueueOnly 边界。 |
| T25 | MA11/35 | V2-11/21 | PARTIAL | E16 包含同一 runner 多次任务、真实 Runtime 冷续接与非重试错误；真实模型+副作用+瞬态失败三次串联场景未运行。 |
| T26 | MA08/29/30 | V2-08/30 | BLOCKED（跨 Provider） | E32 已按后续授权实测单一 `workbuddy/glm-5.3-flash`；其他模型及跨 Provider 仍不在本次授权内，factory 中的 provider/model 字符串不算另一 Provider 的远端调用。 |
| T27 | MA29 | V2-30/B | BLOCKED（B0未证明） | ZCode 本地明文消息行为与 Codex B 密文/明文传输分开；B0 固定版 IPC 字段不兼容且本轮不重发外部请求，B1/B2/B3 不关闭（E22）。 |
| T28 | MA30/33 | V2-28/29 | PARTIAL（原生场景已验） | E27 覆盖三层子孙的原生状态、详情暂停/输入、Main Stop 和冷续接；E32–E33 补充真实模型的子代理控制及多级 Main Stop。完整客户端范围、独立 Host 重连及其他模型场景仍需另证。 |
| T29 | MA17/20/36 | V2-01/23/26 | PASS（本地全回归） | 以 E16 最终完整 CLI 执行为准，另有 E17 根共享协议/UI 回归与 E20 门禁；skip 按实记录，外部/原生环境不混入通过数。 |
| T30 | MA18/35 | V2-29/30 | PARTIAL（本地Read已验） | E19/E16 通过两个真实 Child 的指定区间 Read、trace/session、SQLite tool parts、内容隔离及证据卡收集；本地 fixture 决定调用，真实模型理解、独立阅读和汇总质量未证明。 |

## S-T01–S-T12 提示词专项边界

提示内容由 Main 所有。下表记录本地请求/模板/控制证据；E32 的指定模型实测仅覆盖明确点名工具的场景，不据此关闭自主决策、跨 Provider 或 token/cache 专项。

| S-T | MA | V2 | 当前证据状态 | 尚需证据 |
| --- | --- | --- | --- | --- |
| S-T01 | MA27/28 | V2-01/25 | PARTIAL（本地请求已验） | E16 验证 Root /root、有效六工具、委派边界与原编程/权限规则；模型自主执行这些规则未验。 |
| S-T02 | MA04/19/27 | V2-04/16/25 | PARTIAL（本地链路已验） | E16 验证多级路径/parent、子级请求和真实父级最终邮箱/initiator 活动；E32–E33 增加明确指令下的单模型子孙协作、孙代理回报由直接父级消费，自主模型协作另证。 |
| S-T03 | MA07/09/36 | V2-07/09/26 | PARTIAL | E16 覆盖 Explore/general/custom 的角色与权限工具限制；完整来源、真实模型/安全环境组合不视为已穷尽。 |
| S-T04 | MA17/28 | V2-01/23/24 | PARTIAL（本地门控已验） | E16 验证 enabled/操作隐藏/namespace、wait 配置与实际工具/提示对应，含 local/native ToolSearch 对照；Code Mode 条件不触发，真实模型选择未验。 |
| S-T05 | MA10/11/27 | V2-10/11/25 | PARTIAL（明确指令已验） | QueueOnly/TriggerTurn 的控制与实际 Runtime 语义经 E16 复跑；E32 指定模型按明确指令调用 send/followup，自主判断何时选择仍未验证。 |
| S-T06 | MA14/15/16/27 | V2-12/13/14/25 | PARTIAL（明确指令已验） | wait/list/interrupt 的机械行为由 E16 实测；E32 指定模型按明确指令调用 wait，暂停由界面触发；模型自主判断和操作选择仍未验证。 |
| S-T07 | MA05/06/09/27 | V2-05/06/09/25 | PARTIAL | E16 断言实际 request 的 all/none、权限层级、prefix 与 reasoning/工具对过滤；不同真实 Provider 的归一化和行为未验。 |
| S-T08 | MA06/21/27 | V2-06/21/25 | PARTIAL（本地恢复已验） | E16 覆盖 reactive/auto compact→同 turn→cold followup、transcript/prefix/角色保留及 SQLite 冷恢复；外部 Provider 请求/cache 实验未做。 |
| S-T09 | MA07/27/36 | V2-07/25/26 | PARTIAL（本地模板已验） | E16 覆盖 customSystemPrompt、workflowActor 原互斥与 V2 身份/角色组合；模板与请求证据不外推为真实模型执行证据。 |
| S-T10 | MA27/36 | V2-25/26 | PARTIAL（本地策略已验） | E16 断言 explicit/proactive 委派模式的提示与继承；真实模型遵守用户授权及并发策略仍未证明。 |
| S-T11 | MA29/30 | V2-24/25/30 | BLOCKED（跨 Provider） | E32 完成单模型的 Root→Child→Grandchild 真实调用；至少两种 Provider 的真实调用仍不在本次授权内。 |
| S-T12 | MA06/27/30 | V2-06/25/29 | PARTIAL（用量记录已取） | E16 验证稳定/动态分段模板；E32 记录单模型实机 usage 聚合，但未验证多轮前缀字节一致性或独立 cache 实验，不报告命中率或节省。 |


## 未闭合项与不能承诺的事项

1. **Code Mode 条件与已有 ToolSearch**：A7 的“若存在对应执行模式”与 §8.10/411 的“等现有执行模式”由 Main 接受为条件约束。已核 CLI 的配置枚举、工具注册/执行、NodeRepl 注入和工作流脚本，均没有通用 ToolRegistry 代码调用执行层；因此未新增解释器，未宣称 Code Mode 或 `non_code_mode_only` 已实现，条件项不作为 PASS。现有 ToolSearch local/native 仍必须验收，E13 四个生产 Runtime 对照已通过。详见下节源码依据。
2. **嵌套模型预算**：WebSearch/Fetch 绕过旧 `runModelTextRequest` 的准入/漏账修复已闭合Core证据：统一Model handle 18测试实际通过，含继承父Model被child二次包裹的正确归属与adapter吞掉flush异常后重试fence。外部服务账单/未报告usage/在飞开销不在这份测试证据范围。
3. **预算含义**：只能据 Provider 实际报告 token 累计；未报告消费和已经在飞请求不可能被事后账本当作预付硬金额上限。cache/reasoning 不能在 total 上再加一次。service tier 与费用实验尚无 A 证据。
4. **持久恢复证据**：E5/E8 保留真实 SQLite 初跑邮件竞态和旧 Plan 单轴断言的失败记录。236581a/e3f85f6 修复 startup mailbox，a2eb81a 校准正式双轴断言后，E11 完整跨进程用例通过。父级 Plan 权限恢复有 E9 真实 RED/GREEN；Guarded/Build/Auto 交集和独立 Plan 快照有 E10 两个真实 RED 及随后 GREEN，包含新版 SQLite 再跑。冻结原 developer guidance 的 E12 也已有两例 RED 与修复后 GREEN。Host 独立断线重连仍需证据。非正常退出留下的 running 恢复为 lost；正常 Root 关闭按 E26 中断并结算，不能宣称退出后仍在后台计算。
5. **前缀证据**：内部模型可见历史已经真实断言；不同 Provider 的 System/Developer 归一化与 cache 字节命中未测，不报 token/cache 提升。
6. **真实模型与 UI**：E18 已验证公开取消范围，E19 已验证真实 Read/SQLite 的隔离阅读链路；两者均不证明真实模型会自主正确调用。E27 已覆盖原生详情交互、Main Stop 与进程冷重启；E30 已覆盖原生前台/后台/孙代理 A4 的 fixture 组合；E32–E33 增加指定模型的单子代理和两子一孙 Main Stop、详情控制和主子孙通信。Host 独立断线重连仍未覆盖。新增公开 scope 不等于新增原生范围控件。
7. **其余未覆盖场景**：T10/T25 的真实副作用与连续故障/恢复整场景、T22 的真实 MCP/系统审批矩阵，不能仅据控制器或一般旧工具回归关闭；真实 Board 部署、B0 服务端链路、跨 Provider、自主模型工具选择及 token/cache 实验均未闭合。超出指定模型授权的外部模型项记 BLOCKED，其余按各行的 PARTIAL/未覆盖保留。
8. **不伪造全量通过**：MA/V2/T/S 是重叠视角，不能用 suite case 数代替计划分母。当前 C retry/预算/Board 与 Main 提示词/投影均有 E16 本地集成回归；B 明文、未覆盖的原生 UI 场景与真实 Provider 仍必须各自给出对应证据。

## Code Mode 条件核对与已有执行面

这份核对读取的是 Main 提供的 ZCode CLI 生产源码快照及固定 Codex 参考，不是根据模型名称或自述推断能力。计划第 253 行要求接入已有 ToolSearch/Code Mode；第 276 行明确 Code Mode“若存在对应执行模式”；第 411 行要求已有模式的真实工具与权限对照。Main 已接受下述条件判定，MA29/V2-24 仍保留并分别报告其他适用部分。

| 现有入口 / 参考 | 源码依据（ZCode 仓库相对路径；Codex 行另注明） | 实际边界 |
| --- | --- | --- |
| ToolSearch | `packages/contracts/src/tools/tool-search.ts` 的 off/auto/native/local；`packages/core/src/tool/search/exposure.ts`；`handlers/tool-search.ts` | 工具目录来自本轮有效工具集合；local 以函数定义文本投影，native 以 tool_reference 投影，调用仍由原 ToolExecutor 执行 |
| DeferredToolCall | `packages/contracts/src/tools/deferred-tool-call.ts`；`packages/core/src/tool/handlers/deferred-tool-call.ts` | 单个已发现 deferred 工具的结构化包装调用，不执行任意代码；V2 六工具保持 resident，不能被该包装扩大权限 |
| NodeRepl | `packages/core/src/repl/node-repl-session.ts`；`packages/core/src/tool/handlers/node-repl.ts::buildInjectedGlobals` | Node 执行与 browser 专用 bridge；无通用 tools/ToolRegistry 六操作调用桥，不能据其执行 JavaScript 就称 Code Mode 已存在 |
| Script Workflow | `packages/bootstrap/src/app/script-workflow-child-source.ts`；`script-workflow-tool-port.ts` | agent/parallel/pipeline 等工作流 DSL 走 WorkflowPort；不是六工具的代码曝光面，不把其队列/状态当 V2 Owner |
| Codex `non_code_mode_only` | 固定 Codex `core/src/tools/spec_plan.rs` 的 add_collaboration_tools；`features/src/feature_configs.rs` | true 选择 DirectModelOnly，false 选择 Direct；控制代码执行面的曝光，不要求新建 Agent Registry，也不能将 ZCode ToolSearch 当作其等价解释器 |

表中 ZCode 路径均相对 `apps/zcode-cli/`。A 对整个可用 CLI 源码的精确 CodeMode/`code_mode`/`non_code_mode_only`/曝光枚举搜索未发现其他执行层；不从缺少某个外部 Codex artifact 推导此结论。NodeRepl、Workflow 既有行为不被本任务重写。已有 ToolSearch 的真实 schema、去重、门控与 Profile 权限证据已由 E13 单独给出，不能以条件项不触发豁免。

## 交付与工作树保护

A 的历史云端快照通过独立 patch 合入 Mac 隔离工作树；E0–E14 保留原执行与失败。当前唯一结果总账为本文件，原差距审计保留历史取证，原计划仅追加当前用户决策与接续入口。

验证阶段未 commit、merge 或 push，基线为 `3c5b2276`。随后用户授权分类提交：`785d4b01` 路径测试、`ad74a30f` 流恢复、`6c167e0a` 多代理运行时、`8f04090d` 桌面交互、`d2e7c21d` 架构配置格式；验收记录随其后的文档提交保存。未 push、merge 或改写历史。原始 `zcode/main`、固定 `codex` 参考与 `codex-v2-plaintext` 保持原 HEAD；原有 SQLite 备份和启动探针保留，未 reset、clean 或 stash。

### 恢复入口

1. 先核对本轮机器摘要的源码指纹、环境与完整执行结果；源码变更后按直接影响重新验证，不能复用旧 PASS。
2. E27–E30 已完成原生详情控制、Main Stop、界面刷新重连和冷续接回放；E32–E33 在开发版合成任务中补充了单模型真实调用、详情控制及多级 Main Stop。仍需覆盖实际用户项目、远端 Host 断线重连及原生范围控件；E33 主邮箱的五条邮件尚未从原生界面消费。
3. 在用户限定的 `workbuddy/glm-5.3-flash` 范围内可继续单模型场景；其他模型和跨 Provider 仍受授权限制。实际 Board 服务和 B0 服务端链路另需相应环境；B0 先解决已识别 wire 字段不兼容，再证明真实明文收发，不能直接关闭 B1/B2/B3。
4. 按四张 ID 表补齐各自剩余场景；在全部适用要求有对应实测证据前，总判定保持 PARTIAL。本轮交付不涉及发布，无需新增发布记录。
