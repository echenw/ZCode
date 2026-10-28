import type {
  AgentMessageBoardCallContext, AgentMessageBoardRemotePort, AgentMessageBoardRemoteReceiver, MultiAgentIdentity,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/index.js";

interface ActiveReceiver {
  turnId: string;
  receiver: AgentMessageBoardRemoteReceiver;
  controller: AbortController;
  unlink(): void;
}

/** Transport handles are derived from the existing root Registry; this owns no task states. */
export function createRemoteBoardLifecycle(input: {
  rootSessionId: string;
  registry: RuntimeTaskRegistry;
  remote: AgentMessageBoardRemotePort;
  ready?: Promise<void>;
  receive(notification: unknown, context: AgentMessageBoardCallContext): Promise<boolean>;
}) {
  const receivers = new Map<string, ActiveReceiver>();
  let disposed = false;
  const stop = (agentId: string, expected?: ActiveReceiver) => {
    const entry = receivers.get(agentId);
    if (!entry || (expected && entry !== expected)) return;
    receivers.delete(agentId);
    entry.unlink();
    entry.controller.abort();
    try { entry.receiver.close(); } catch { /* Transport cleanup cannot change the task outcome. */ }
  };
  const tasks = () => Object.values(input.registry.all()).filter((task) => task.multiAgent?.rootSessionId === input.rootSessionId);
  const syncMembers = () => input.remote.setMembers?.(tasks().map((task) => ({
    agentId: task.agentId, agentPath: task.multiAgent!.agentPath,
  })));
  const unsubscribe = input.registry.subscribe?.(() => {
    for (const [agentId, receiver] of receivers) {
      const task = tasks().find((item) => item.agentId === agentId);
      if (!task || task.status !== "running" || !task.multiAgent?.resident || task.turnId !== receiver.turnId) stop(agentId, receiver);
    }
  });
  return {
    syncMembers,
    async prepareForTurn(identity: MultiAgentIdentity, context: AgentMessageBoardCallContext): Promise<void> {
      if (disposed || !input.remote.notifications || identity.rootSessionId !== input.rootSessionId) return;
      await input.ready;
      if (disposed || context.signal?.aborted) return;
      syncMembers();
      const task = tasks().find((item) => item.multiAgent?.agentPath === identity.agentPath);
      if (!task?.turnId || task.status !== "running" || !task.multiAgent?.resident || context.trace.turnId !== task.turnId) return;
      const previous = receivers.get(task.agentId);
      if (previous?.turnId === task.turnId) { await previous.receiver.ready; return; }
      if (previous) stop(task.agentId, previous);
      const controller = new AbortController();
      const receiverContext = { ...context, requestId: `board-watch:${task.agentId}:${task.turnId}`, signal: controller.signal };
      let receiver: AgentMessageBoardRemoteReceiver;
      let active: ActiveReceiver | undefined;
      try {
        receiver = input.remote.notifications({ caller: task.agentId, turnId: task.turnId }, receiverContext,
          (notification) => active && receivers.get(task.agentId) === active && !controller.signal.aborted
            ? input.receive(notification, receiverContext) : Promise.resolve(false));
      } catch { return; /* Optional receiver setup cannot fail an ordinary model turn. */ }
      const onAbort = () => { if (active) stop(task.agentId, active); };
      active = { turnId: task.turnId, receiver, controller,
        unlink: () => context.signal?.removeEventListener("abort", onAbort) };
      receivers.set(task.agentId, active);
      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted) onAbort();
      // The Host resolves readiness after its first attempt, including a failed setup. Later
      // retries remain owned by this exact turn and never trigger a new inference.
      await receiver.ready.catch(() => undefined);
    },
    finishTurn(identity: MultiAgentIdentity, turnId: string) {
      if (identity.rootSessionId !== input.rootSessionId) return;
      const task = tasks().find((item) => item.multiAgent?.agentPath === identity.agentPath);
      const receiver = task && receivers.get(task.agentId);
      if (task && receiver?.turnId === turnId) stop(task.agentId, receiver);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const agentId of receivers.keys()) stop(agentId);
      try { input.remote.dispose?.(); } catch { /* Host shutdown remains best effort. */ }
    },
  };
}
