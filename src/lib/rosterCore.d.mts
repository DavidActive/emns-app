export interface ImportRow { employee_id: string; full_name: string; mobile_phone: string; email: string; groups: string }
export function parseCsv(text: string): string[][];
export function mapHeaders(headerRow: string[]): { columns: Record<string, number>; unmapped: string[] };
export function normalizePhone(input: unknown): string | null;
export function buildImportRows(csvText: string): { rows: ImportRow[]; errors: string[]; unmapped: string[]; missingRequired: string[] };
export const CSV_TEMPLATE: string;
