export const PHASE_ACTORS = {
  init: [],
  night: ["guard", "werewolves", "seer", "witch", "system"],
  day: ["system"],
  vote: ["system"],
  end: [],
};

export function nextPhase(curr) {
  const order = ["init", "night", "day", "vote", "night"];
  const idx = order.indexOf(curr);
  return idx === -1 ? "night" : order[(idx + 1) % order.length];
}
