import { StaffProfile } from './AuthContext';

/** Mirrors the database policy: only admin and sender roles (or platform admins) may change the roster. */
export function canEditRoster(staff: StaffProfile | null): boolean {
  if (!staff) return false;
  return staff.is_platform_admin || staff.role === 'admin' || staff.role === 'sender';
}
