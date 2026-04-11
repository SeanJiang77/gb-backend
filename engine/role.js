export class Role {
  constructor(ctx) {
    this.room = ctx.room;
    this.actor = ctx.actor;
    this.rules = ctx.rules;
    this.payload = ctx.payload || {};
  }
  static get name() { return "role"; }
  static get team() { return "neutral"; }
  static get nightOrder() { return 999; }
  static get allowedActions() { return []; }
  static isActionPhaseOk(phase, action) { return phase === "night"; }
  validate(action, targetSeat) {}
  apply(action, targetSeat) { return {}; }
}
