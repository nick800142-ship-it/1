import { describe, expect, it } from "vitest";
import { getAgentDownline, type AgentHierarchyMember } from "../src/lib/agentHierarchy";

const makeMember = (
  id: string,
  overrides: Partial<AgentHierarchyMember> = {},
): AgentHierarchyMember => ({
  id,
  agency_role: "一般用戶",
  referrer_id: null,
  parent_id: null,
  master_agent_id: null,
  ...overrides,
});

describe("getAgentDownline", () => {
  it("uses the updated referrer instead of a stale legacy parent link", () => {
    const members = [
      makeMember("new-direct", { referrer_id: "viewer" }),
      makeMember("moved-member", { referrer_id: "another-parent", parent_id: "viewer" }),
      makeMember("new-second-level", { referrer_id: "new-direct" }),
    ];

    expect(
      getAgentDownline("viewer", "一般用戶", members).map(({ member }) => member.id),
    ).toEqual(["new-direct", "new-second-level"]);
  });

  it("follows an admin-reassigned L1 agent and counts its L2 under the new master", () => {
    const members = [
      makeMember("reassigned-agent", {
        agency_role: "代理",
        referrer_id: "old-master",
        master_agent_id: "new-master",
      }),
      makeMember("agent-member", { referrer_id: "reassigned-agent" }),
    ];

    expect(getAgentDownline("old-master", "總代理", members)).toEqual([]);
    expect(
      getAgentDownline("new-master", "總代理", members).map(({ member, level }) => [member.id, level]),
    ).toEqual([
      ["reassigned-agent", 1],
      ["agent-member", 2],
    ]);
  });

  it("uses parent_id only when referrer_id is absent and limits the count to L1 plus L2", () => {
    const members = [
      makeMember("legacy-direct", { parent_id: "viewer" }),
      makeMember("second-level", { referrer_id: "legacy-direct" }),
      makeMember("third-level", { referrer_id: "second-level" }),
    ];

    expect(
      getAgentDownline("viewer", "一般用戶", members).map(({ member, level }) => [member.id, level]),
    ).toEqual([
      ["legacy-direct", 1],
      ["second-level", 2],
    ]);
  });
});
