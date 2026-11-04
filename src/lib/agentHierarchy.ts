export type AgentHierarchyMember = {
  id: string;
  agency_role: string;
  referrer_id: string | null;
  parent_id?: string | null;
  master_agent_id: string | null;
};

export type AgentDownlineMember<T> = {
  member: T;
  level: 1 | 2;
};

const SUBORDINATE_AGENT_ROLES = new Set([
  "agent",
  "代理",
  "一代代理",
  "二代代理",
]);

const MASTER_AGENT_ROLES = new Set(["master_agent", "總代理"]);

export function getAgentDownline<T extends AgentHierarchyMember>(
  viewerId: string | null | undefined,
  viewerRole: string | null | undefined,
  members: readonly T[],
): AgentDownlineMember<T>[] {
  if (!viewerId) return [];

  const parentIdOf = (member: T) => member.referrer_id || member.parent_id || null;
  const isMasterAgent = MASTER_AGENT_ROLES.has(viewerRole ?? "");
  const childrenByParent = new Map<string, T[]>();

  for (const member of members) {
    const parentId = parentIdOf(member);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(member);
    childrenByParent.set(parentId, children);
  }

  const isDirectMember = (member: T) => {
    if (member.id === viewerId) return false;
    const parentId = parentIdOf(member);

    if (isMasterAgent && SUBORDINATE_AGENT_ROLES.has(member.agency_role)) {
      // Admin rebinds for agents update master_agent_id while preserving referrer_id.
      return member.master_agent_id
        ? member.master_agent_id === viewerId
        : parentId === viewerId;
    }

    // referrer_id is authoritative; parent_id is only a legacy fallback after rebinds.
    return parentId === viewerId;
  };

  const result: AgentDownlineMember<T>[] = [];
  const visited = new Set<string>([viewerId]);
  const frontier: AgentDownlineMember<T>[] = [];

  for (const member of members) {
    if (!isDirectMember(member) || visited.has(member.id)) continue;
    visited.add(member.id);
    const directMember = { member, level: 1 as const };
    result.push(directMember);
    frontier.push(directMember);
  }

  for (const { member: parent } of frontier) {
    for (const child of childrenByParent.get(parent.id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      result.push({ member: child, level: 2 });
    }
  }

  return result;
}
