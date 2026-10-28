# cli-multi-agent-board-transport

## 意图与入口

将既有 `AgentMessageBoardRemotePort` 接到固定上游 Board HTTP/SSE 协议。产品工厂只经
`@zcode/adapters/multi-agent-board` 的 `index.ts` 导出；本契约复用共享端口，不复制业务 schema。
Core 决定权限、操作、幂等键及当前 turn 是否接收；Adapter 执行网络与传输取消。

## 单一 Owner 与时序

- 每个根 Runtime 借用一个传输实例。它只拥有凭据、串行成员注册和活动 receiver；
  成员来自根 Registry 的投影，帖子由远端服务拥有，不新增 task 状态或待消费邮箱。
- `setMembers` 后，首个请求依次 PUT board、POST members，再使用返回的会话凭据调用
  `/call` 或 `/notifications`。并发调用共享同一注册链；单个调用取消等待不撤销其他调用
  已接受的注册，根 shutdown 才取消其共享工作。相同投影不重复登记。
- Core `remote-lifecycle.prepareForTurn` 在真实模型调用前建立 receiver 并等待首次尝试；
  健康连接先收到 ready，失败释放启动等待。之后每秒只重连相同的活动 turn，不重放历史。
- 每条通知经过 schema、wire recipient 和 turn 校验，再交给 Core 的 turn fence 与
  `sendActive` 单次准入。旧 turn、非法预览、idle 目标均不能形成新回合或邮箱补投。
- `finishTurn` 只关闭该 receiver；Main Stop 保留活动 Child。只有根 shutdown 调用
  `dispose` 取消整根传输，既不删除远端帖子，也不影响其他根。

## 不变量与失败边界

- branded 根/成员 ID 使用固定 UUIDv5 映射，重启身份不变；作者与订阅目标仍使用 AgentPath。
- endpoint 保留路径前缀，只允许 HTTP(S)，拒绝 URL 凭据、query 和 fragment。
  使用既有 proxy/noProxy/custom CA 与 network-capture 隔离，不维护第二套网络策略。
- Host provisioning 凭据和远端会话凭据只留在闭包。错误与日志脱敏，不进入模型或 SQLite entry。
- request/SSE 单帧最多 512 KiB、JSON response 最多 1 MiB，HTTP/首次连接尝试 30 秒超时。
  SSE 严格解码 UTF-8，预览最多 150 Unicode scalar；Core 仍执行自己的最终输入/输出预算。
- `/call` 写操作不自动重试。post 由原 `params.request_id` 在服务去重；传输失败不能证明
  远端未提交。HTTP 403 的结构化 permission_denied/action/resource 保留，禁止降级本地板。
- `ready` 仅保证首次连接尝试已结束；回调只表示实时预览可投递，不能证明模型已读取。
  不发 Last-Event-ID，不创建历史通知补发游标，也不借错误重连启动推理。
- 本模块不产生第二套 SessionEvent。Desktop continuous 与 Web replayable 的会话展示都沿用
  Core steer/transcript 链；SSE 本身仍是当前 turn 的即时通知，不是客户端回放日志。

## 接线与证据

Bootstrap `createZCodeApp` 通过 feature/native gates 后构造工厂并注入 Runtime；Core 根 Board
共享端口、同步成员、控制 turn 生命周期。未配置或初始化失败只影响可选 Board，普通 V2 保留。
具体业务合同见 [message-board spec](../../../../docs/design/v2/multi-agent-message-board.md)。

- `tests/multi-agent-board-remote.test.ts`：真实 loopback HTTP/SSE、注册/凭据、错误、限额、重连与取消。
- Bootstrap `tests/multi-agent-board-host.test.ts`：正式 App 到 SSE 到 steer/模型输入/SQLite 的链路；
  只注入本地 Model executor，不能当外部模型验收。
- `tests/message-board-sqlite-process.test.ts`：local/memory 的两个 OS 进程恢复边界，属于 Core/SQLite
  协作验证；不能当远端服务的持久化证明。

本地协议测试不能证明已部署服务的真实凭据、授权策略或特定代理/CA 环境可用，须单独记录实测结果。
