import { Role } from "./role.js";

const REGISTRY = new Map();

export function registerRole(RoleClass) {
  if (!(RoleClass.prototype instanceof Role)) {
    throw new Error("RoleClass must extend Role");
  }
  REGISTRY.set(RoleClass.name, RoleClass);
}

export function createRoleInstance(roleName, ctx) {
  const className = roleName.charAt(0).toUpperCase() + roleName.slice(1);
  const RoleClass = REGISTRY.get(className);
  if (!RoleClass) throw new Error(`Unknown role: ${roleName}`);
  return new RoleClass(ctx);
}

export function getRoleClass(roleName) {
  const className = roleName.charAt(0).toUpperCase() + roleName.slice(1);
  return REGISTRY.get(className);
}

export function listRoles() {
  return [...REGISTRY.entries()].map(([name, C]) => ({
    className: name,
    roleName: C.name || name,
    team: C.team || "neutral",
    nightOrder: C.nightOrder ?? 999,
    actions: C.allowedActions || [],
  }));
}
