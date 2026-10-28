export interface MultiAgentIdentity {
  agentPath: string;
  parentPath?: string;
  rootSessionId: string;
  nickname?: string;
}

const AGENT_NICKNAMES = [
  "Ada",
  "Turing",
  "Curie",
  "Kepler",
  "Galileo",
  "Newton",
  "Euler",
  "Pascal",
  "Faraday",
  "Darwin",
  "Hopper",
  "Noether",
] as const;

/** 只生成候选名称；同根唯一性及持久生命周期由 Root Registry 负责。 */
function multiAgentNicknameCandidate(index: number): string {
  const name = AGENT_NICKNAMES[index % AGENT_NICKNAMES.length]!;
  const cycle = Math.floor(index / AGENT_NICKNAMES.length);
  return cycle === 0 ? name : `${name} ${cycle + 1}`;
}

export function allocateMultiAgentNicknames(
  identities: readonly Pick<MultiAgentIdentity, "agentPath" | "nickname">[],
): string[] {
  const occupied = new Set(
    identities.flatMap((identity) => (identity.nickname ? [identity.nickname] : [])),
  );
  let index = 0;
  return identities.map((identity) => {
    if (identity.nickname) return identity.nickname;
    if (identity.agentPath === "/root") return "Main";
    while (occupied.has(multiAgentNicknameCandidate(index))) index++;
    const name = multiAgentNicknameCandidate(index++);
    occupied.add(name);
    return name;
  });
}
