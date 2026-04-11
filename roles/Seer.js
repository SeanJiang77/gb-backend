import { GodRole } from "../engine/categories.js";

export class Seer extends GodRole {
  static get name() { return "seer"; }
  static get nightOrder() { return 30; }
  static get allowedActions() { return ["check"]; }

  apply(action, targetSeat) {
    if (action !== "check") return {};
    const t = this.room.players.find(p => p.seat === targetSeat);
    const isWolf = t?.role === "werewolf";
    return { note: `预言家查验 ${targetSeat}=${isWolf ? "狼人" : "好人"}` };
  }
}
