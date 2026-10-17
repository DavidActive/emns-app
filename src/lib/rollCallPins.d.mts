export interface PinPerson {
  person_id: string; full_name: string; status: string; lat?: number | null; lng?: number | null;
  gps_url?: string | null; responded_at?: string | null; last_source?: string | null;
}
export interface Pin { id: string; name: string; status: string; label: string; color: string; lat: number; lng: number; at: string | null; gpsUrl: string | null; source: string | null }
export interface Unlocated { id: string; name: string; status: string; label: string }
export const PIN_COLORS: { sos: string; safe: string; other: string };
export function rollCallPins(people: PinPerson[]): { pins: Pin[]; withoutLocation: Unlocated[]; counts: { sos: number; safe: number; located: number } };
