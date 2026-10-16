export const BRAND: string;
export function cleanTag(tag: unknown, fallback: string): string;
export function formatEmail(o: { kind: 'alert' | 'drill' | 'test'; orgName?: string; subject?: string; body?: string; requiresAck?: boolean; drillTag?: string; testTag?: string }): { subject: string; text: string };
