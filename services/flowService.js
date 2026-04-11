// services/flowService.js
// Minimal night/day state machine and example rule checks.
import { HttpError } from "../utils/errors.js";

export function nextPhase(curr) {
  const order = ["init", "night", "day", "vote", "night"]; // loop until 'end'
  const idx = order.indexOf(curr);
  return idx === -1 ? "night" : order[(idx + 1) % order.length];
}

export function checkGuardConsecutive(ruleFlag, log, latestTargetSeat) {
  if (ruleFlag) return; // allowed
  const last = [...log].reverse().find(e => e.actor === "guard");
  if (last && last.targetSeat === latestTargetSeat) {
    throw new HttpError(409, "守卫不可连续守同一人（规则限制）");
  }
}

export function checkWitchSelfSave(ruleFlag, isFirstNight, isSelfSave) {
  if (!isFirstNight && isSelfSave) {
    return;
  }
  if (isFirstNight && !ruleFlag && isSelfSave) {
    throw new HttpError(409, "女巫首夜禁止自救（规则限制）");
  }
}

export function isGameOver(players) {
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === "werewolf").length;
  const others = alive.length - wolves;
  if (wolves === 0) return { over: true, winner: "good" };
  if (wolves >= others) return { over: true, winner: "werewolf" };
  return { over: false };
}
