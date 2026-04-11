export function isGameOver(players) {
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === "werewolf").length;
  const others = alive.length - wolves;
  if (wolves === 0) return { over: true, winner: "good" };
  if (wolves >= others) return { over: true, winner: "werewolf" };
  return { over: false };
}
