export const PRESETS = {
  "9p-classic":  { werewolf: 3, seer: 1, witch: 1, guard: 1, villager: 3 },
  "12p-classic": { werewolf: 4, seer: 1, witch: 1, guard: 1, villager: 5 },
};

export function totalRoles(roles = {}) {
  return Object.values(roles).reduce((s, n) => s + Number(n || 0), 0);
}

export function nonVillagerCount(roles = {}) {
  return Object.entries(roles).reduce((s, [k, v]) => (k === "villager" ? s : s + (v || 0)), 0);
}

export function finalizeRoleConfig(baseRoles, players, mode = "flex") {
  const roles = { ...baseRoles };
  if (mode === "strict") {
    const expected = totalRoles(roles);
    if (players !== expected) {
      return { error: `严格模式：玩家数(${players})必须等于预设总数(${expected})` };
    }
    return { final: roles, expectedPlayers: expected, playersNeeded: Math.max(0, expected - players) };
  }
  const mustHave = nonVillagerCount(roles);
  const expected = Math.max(players, mustHave);
  const villagers = Math.max(0, expected - mustHave);
  roles.villager = villagers;
  return { final: roles, expectedPlayers: expected, playersNeeded: Math.max(0, expected - players) };
}
