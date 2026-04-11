import { HttpError } from "../utils/errors.js";

export function resolveNight(room, actions = {}) {
  const rules = room.rules || {};
  const players = room.players || [];

  const findSeat = (seat) => players.find((p) => p.seat === seat);
  const roleSeat = (role) => {
    const p = players.find((x) => x.role === role);
    return p ? p.seat : null;
  };

  /* ===== 解析输入 ===== */
  const guardTarget = actions?.guard?.targetSeat ?? null;
  const wolvesTarget = actions?.wolves?.targetSeat ?? null;
  const seerTarget = actions?.seer?.targetSeat ?? null;
  const witchHeal = actions?.witch?.healTargetSeat ?? null;
  const witchPoison = actions?.witch?.poisonTargetSeat ?? null;
  const isFirstNight = !!actions?.witch?.isFirstNight;

  /* ===== 校验座位 ===== */
  const seatsToCheck = [
    guardTarget,
    wolvesTarget,
    seerTarget,
    witchHeal,
    witchPoison,
  ].filter((n) => typeof n === "number");

  for (const s of seatsToCheck) {
    if (!findSeat(s)) {
      throw new HttpError(404, `目标座位 ${s} 未找到`);
    }
  }

  /* ===== 连守规则 ===== */
  if (typeof guardTarget === "number" && !rules.guardConsecutiveProtectAllowed) {
    const last = [...(room.log || [])]
      .reverse()
      .find((e) => e.actor === "guard");
    if (last && last.targetSeat === guardTarget) {
      throw new HttpError(409, "不允许连续守护同一座位");
    }
  }

  /* ===== 女巫首夜自救规则 ===== */
  if (typeof witchHeal === "number") {
    const witchSeat = roleSeat("witch");
    if (
      isFirstNight &&
      witchSeat != null &&
      witchSeat === witchHeal &&
      !rules.witchSelfSaveFirstNight
    ) {
      throw new HttpError(409, "首夜禁止自救");
    }
  }

  /* ===== 清理并设置守护状态 ===== */
  players.forEach((p) => (p._guarded = false));
  if (typeof guardTarget === "number") {
    const t = findSeat(guardTarget);
    if (t) t._guarded = true;
  }

  /* ===== 记录意图 ===== */
  const attempted = {
    wolvesKill: typeof wolvesTarget === "number" ? wolvesTarget : null,
    guardProtect: typeof guardTarget === "number" ? guardTarget : null,
    witchHeal: typeof witchHeal === "number" ? witchHeal : null,
    witchPoison: typeof witchPoison === "number" ? witchPoison : null,
    seerCheck: typeof seerTarget === "number" ? seerTarget : null,
  };

  const prevented = { byGuard: false, byHeal: false };
  const killed = new Set();
  const survived = new Set();
  let sameProtectAndHeal = false;

  /* ===== 结算狼人刀 ===== */
  if (attempted.wolvesKill != null) {
    const victim = findSeat(attempted.wolvesKill);
    if (victim) {
      const guarded = !!victim._guarded;
      const healed =
        typeof witchHeal === "number" &&
        witchHeal === attempted.wolvesKill;

      if (guarded && healed) {
        sameProtectAndHeal = true;
        killed.add(victim.seat);
      } else if (guarded) {
        prevented.byGuard = true;
      } else if (healed) {
        prevented.byHeal = true;
      } else {
        killed.add(victim.seat);
      }
    }
  }

  /* ===== 结算毒药（无视守护） ===== */
  if (attempted.witchPoison != null) {
    killed.add(attempted.witchPoison);
  }

  /* ===== 写入死亡状态 ===== */
  const killedList = [...killed];
  killedList.forEach((seat) => {
    const p = findSeat(seat);
    if (p) p.alive = false;
  });

  /* ===== 记录“被攻击但幸存”的人（用于主持提示） ===== */
  const candidateSurvivors = [
    attempted.wolvesKill,
    attempted.witchHeal,
  ].filter((n) => typeof n === "number");

  candidateSurvivors.forEach((seat) => {
    if (!killed.has(seat)) survived.add(seat);
  });

  const summary = {
    attempted,
    prevented,
    killed: killedList,
    survived: [...survived],
    extra: sameProtectAndHeal
      ? { sameProtectAndHeal: guardTarget }
      : {},
  };

  /* ===== 写入 meta：昨夜被刀者（供前端使用） ===== */
  room.meta = room.meta || {};
  room.meta.lastKilledSeat =
    summary.killed.length === 1 ? summary.killed[0] : null;

  return summary;
}
