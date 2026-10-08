export const GENESIS_SELF_LABEL = "創世紀L0（自己）";

// Account roles are retained for permissions and legacy data only. A referral
// relationship describes downline distance; it does not change the account's own level.
export const GENESIS_ROLE_LABELS: Record<string, string> = {
  一般用戶: GENESIS_SELF_LABEL,
  一般用户: GENESIS_SELF_LABEL,
  user: GENESIS_SELF_LABEL,
  agent: GENESIS_SELF_LABEL,
  代理: GENESIS_SELF_LABEL,
  一代代理: GENESIS_SELF_LABEL,
  二代代理: GENESIS_SELF_LABEL,
  master_agent: GENESIS_SELF_LABEL,
  總代理: GENESIS_SELF_LABEL,
};

export function getGenesisRoleLabel(_role: string | null | undefined) {
  return GENESIS_SELF_LABEL;
}

export function isGenesisAgentRole(role: string | null | undefined) {
  return ["agent", "master_agent", "代理", "一代代理", "二代代理", "總代理"].includes(role ?? "");
}
