export const BRAND: string;
export function cleanTag(tag: unknown, fallback: string): string;
export function formatMessage(o: { kind: 'alert' | 'drill' | 'test'; orgName?: string; body?: string; requiresAck?: boolean; drillTag?: string; testTag?: string }): string;
