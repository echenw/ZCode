import type { AgentMessageBoardRemotePort } from "@zcode/contracts";

/**
 * 复用正式 RemotePort；工厂仍只经 @zcode/adapters/multi-agent-board 的 index 导出。
 * 不另造 agent ID、消息板状态、接受队列或网络客户端接口。
 *
 * setMembers：调用前由 Core 根 Registry 提供完整成员投影；只更新待注册映射，不发请求。
 * 相同投影不重复注册，原 branded ID 在 Host 内稳定映射为 wire UUID。
 *
 * call：caller 必须属于当前成员投影，context 保留原 trace/requestId/取消信号。
 * 首次调用先创建远端 board 并登记成员，随后使用服务返回的会话凭据发送一次 /call。
 * 返回已解析的有界 JSON；业务 schema 仍由 Core 校验。写失败不自动重放，也不写本地存储；
 * post 幂等键由 Core 的 params.request_id 提供，只有服务确认的响应表示本次远端调用成功。
 *
 * notifications：每个实际活动 turn 创建一个 receiver。ready 表示首次尝试已结束，健康
 * 连接必须已收到服务 ready；失败也释放启动等待，随后只在同一未取消 turn 内重连。
 * 回调仅交付通过 schema、recipient、turn 校验的预览。它不是持久事件或新回合启动命令。
 * close 只终止该 receiver；dispose 由根 Host shutdown 调用并终止本根全部连接。
 * 两者均可重复调用，不删除服务上的 board/history，不取消其他根的工作。
 *
 * 标准 Node 实现提供全部可选生命周期方法；类型上的可选性沿用共享端口，允许精简的嵌入端口。
 * HTTP 错误是 CoreError；403 保留 permission_denied/action/resource，凭据不会进入错误文本。
 * 会话事件、权限准入和 SQLite 持久化由 Core/现有存储链拥有，Adapter 不发第二套事件。
 */
export type CliMultiAgentBoardTransportContract = AgentMessageBoardRemotePort;
