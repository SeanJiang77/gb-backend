import { Role } from "./role.js";
import { HttpError } from "../utils/errors.js";

export class GodRole extends Role {
  static get team() { return "good"; }
  static get nightOrder() { return 30; }
  static isActionPhaseOk(phase, _action) { return phase === "night"; }
  validate(_action, targetSeat) {
    if (typeof targetSeat === "number") {
      const t = this.room.players.find(p => p.seat === targetSeat);
      if (!t) throw new HttpError(404, "Target seat not found");
      if (!t.alive) throw new HttpError(409, "Target is already dead");
    }
  }
}

export class VillagerRole extends Role {
  static get team() { return "good"; }
  static get allowedActions() { return []; }
  static get nightOrder() { return 90; }
  static isActionPhaseOk() { return false; }
}

export class WolfRole extends Role {
  static get team() { return "werewolf"; }
  static get nightOrder() { return 20; }
  static get allowedActions() { return ["kill"]; }
  static isActionPhaseOk(phase) { return phase === "night"; }
  validate(action, targetSeat) {
    if (action !== "kill") return;
    const t = this.room.players.find(p => p.seat === targetSeat);
    if (!t) throw new HttpError(404, "Target seat not found");
  }
}
