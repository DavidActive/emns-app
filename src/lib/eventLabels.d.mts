export const KIND_LABELS: Record<string, string>;
export const LIVE_WINDOW_MS: number;
export function kindLabel(kind: string | null | undefined): string;
export function kindColor(kind: string | null | undefined): string;
export function isLiveEvent(e: { createdAt: string; status?: string | null; pending?: number | null }, now?: number): boolean;
export interface RollCallSummary { targeted: number; safe: number; sos: number; replied: number; responded: number; unaccounted: number }
export function rollCallSummary(counts: unknown): RollCallSummary | null;
export function latestEventPerScenario<T extends { scenario_id?: string | null; created_at: string }>(events: T[] | null | undefined): Record<string, T>;
