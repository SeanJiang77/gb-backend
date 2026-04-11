// backend/roles/Werewolf.js
import { WolfRole } from "../engine/categories.js";

export class Werewolf extends WolfRole {
  static get name() { return "werewolf"; }

  apply(action, targetSeat) {
    if (action !== "kill") return {};
    const t = this.room.players.find(p => p.seat === targetSeat);
    if (t) t.alive = false;
    return { note: `狼人击杀 ${targetSeat}` };
  }
}
