import { createHash } from "node:crypto";
import type { AgentMessageBoardRemoteMember } from "@zcode/contracts";

// UUIDv5 DNS namespace, with an explicit ZCode board/member domain in each name.
const NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

export function boardWireId(rootSessionId: string, agentId?: string): string {
  const name = agentId === undefined
    ? `zcode:message-board:${rootSessionId}`
    : `zcode:message-board:${rootSessionId}:agent:${agentId}`;
  const bytes = createHash("sha1").update(NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function projectBoardMembers(rootSessionId: string, members: readonly AgentMessageBoardRemoteMember[]) {
  const byAgent = new Map<string, string>();
  const paths = new Set<string>();
  const wire: Record<string, string> = {};
  for (const member of [...members].sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)) {
    if (!member.agentId || !/^\/root(?:\/[a-z0-9_]+)*$/.test(member.agentPath) || byAgent.has(member.agentId) || paths.has(member.agentPath)) {
      throw new Error("Invalid remote message-board member projection");
    }
    const id = boardWireId(rootSessionId, member.agentId);
    byAgent.set(member.agentId, id);
    paths.add(member.agentPath);
    wire[id] = member.agentPath;
  }
  return { byAgent, wire, fingerprint: JSON.stringify(wire) };
}
