// services/roleService.js
// Role assignment with validation, supports preset or custom config.
import { totalRoles } from "../utils/presets.js";
import { HttpError } from "../utils/errors.js";

export function validateRolesAgainstPlayers(roles, playersCount) {
  const needed = totalRoles(roles);
  if (playersCount < needed) {
    throw new HttpError(400, `玩家数量不足，至少需要 ${needed} 名玩家来匹配所有身份`);
  }
}

export function assignRolesRandomly(players, roles) {
  // Flatten roles to a queue
  const bag = [];
  Object.entries(roles).forEach(([role, count]) => {
    for (let i = 0; i < count; i++) bag.push(role);
  });

  // Shuffle (Fisher–Yates)
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  // Assign to first N players by seat order
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  for (let i = 0; i < bag.length; i++) {
    sorted[i].role = bag[i];
  }
  return sorted;
}
