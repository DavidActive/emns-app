export function formatDuration(seconds: number | string | null | undefined): string;
export function csvCell(value: unknown): string;
export function bucketLabel(key: string): string;
export function statusLabel(key: string): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildCsv(report: any, tz?: string): string;
