import { createRoleInstance } from "./registry.js";
import { HttpError } from "../utils/errors.js";

function toHttpError(err, fallbackStatus = 409) {
  if (err instanceof HttpError) return err;
  return new HttpError(fallbackStatus, err?.message || "身份动作无效");
}

export function performAction(room, { actorSeat, action, targetSeat, payload }) {
  const actor = room.players.find(p => p.seat === actorSeat);
  if (!actor) throw new HttpError(404, `座位 ${actorSeat} 不存在`);
  if (!actor.alive) throw new HttpError(409, `座位 ${actorSeat} 已死亡，不能行动`);
  if (!actor.role) throw new HttpError(409, `座位 ${actorSeat} 尚未分配身份`);

  const roleInst = createRoleInstance(actor.role, { room, actor, rules: room.rules, payload });
  const RoleClass = roleInst.constructor;

  if (!RoleClass.allowedActions.includes(action)) {
    throw new HttpError(400, `${actor.role} 不支持动作 ${action}`);
  }
  if (!RoleClass.isActionPhaseOk(room.status, action)) {
    throw new HttpError(409, `当前阶段 ${room.status} 不允许 ${actor.role} 执行 ${action}`);
  }

  if (typeof targetSeat === "number") {
    const t = room.players.find(p => p.seat === targetSeat);
    if (!t) throw new HttpError(404, `目标座位 ${targetSeat} 不存在`);
  }

  let result;
  try {
    roleInst.validate(action, targetSeat);
    result = roleInst.apply(action, targetSeat) || {};
  } catch (err) {
    throw toHttpError(err);
  }

  const { note = "" } = result;

  room.log.push({
    phase: room.status,
    actor: actor.role,
    targetSeat: typeof targetSeat === "number" ? targetSeat : null,
    payload: { action, ...(payload || {}) },
    note
  });
}
