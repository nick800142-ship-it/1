export const GENESIS_ROLE_LABELS: Record<string, string> = {
  一般用戶: "創世紀L2（下下級）",
  一般用户: "創世紀L2（下下級）",
  user: "創世紀L2（下下級）",
  agent: "創世紀L1（下級）",
  代理: "創世紀L1（下級）",
  一代代理: "創世紀L1（下級）",
  二代代理: "創世紀L2（下下級）",
  master_agent: "創世紀L0（自己）",
  總代理: "創世紀L0（自己）",
};

export function getGenesisRoleLabel(role: string | null | undefined) {
  return GENESIS_ROLE_LABELS[role ?? ""] ?? role ?? "創世紀L2（下下級）";
}

export function isGenesisAgentRole(role: string | null | undefined) {
  return ["agent", "master_agent", "代理", "一代代理", "二代代理", "總代理"].includes(role ?? "");
}
