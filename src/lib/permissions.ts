import { StaffProfile } from './AuthContext';

/** Mirrors the database policy: only admin and sender roles (or platform admins) may change the roster. */
export function canEditRoster(staff: StaffProfile | null): boolean {
  if (!staff) return false;
  return staff.is_platform_admin || staff.role === 'admin' || staff.role === 'sender';
}

/** Operators, senders and admins may run drills and tests (viewers may not). */
export function canDrill(staff: StaffProfile | null): boolean {
  if (!staff) return false;
  return staff.is_platform_admin || ['admin', 'sender', 'operator'].includes(staff.role);
}

/** Only senders and admins may send a real alert. The server enforces the same rule. */
export function canSendAlert(staff: StaffProfile | null): boolean {
  return canEditRoster(staff);
}
