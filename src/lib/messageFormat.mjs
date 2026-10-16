// Browser copy of src/server/broadcast/messageFormat.cjs, used for the compose-screen preview.
// tests/messageFormat.test.cjs checks both produce identical text, so the preview is exactly what recipients get.
export const BRAND = 'Active SOS eMNS';

export function cleanTag(tag, fallback) {
  const t = String(tag == null ? '' : tag).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return t || fallback;
}
const endStop = (s) => (/[.!?]$/.test(s) ? s : s + '.');

export function formatMessage({ kind, orgName, body, requiresAck = true, drillTag, testTag }) {
  const org = String(orgName || '').trim() || 'your organization';
  const text = String(body || '').trim();
  const stop = ' Reply STOP to opt out.';
  if (kind === 'alert') {
    return `${BRAND}: ALERT from ${org}: ${endStop(text)}${requiresAck ? ' Reply SAFE when secure.' : ''}${stop}`;
  }
  if (kind === 'drill') {
    const tag = cleanTag(drillTag, 'DRILL');
    return `${BRAND}: [${tag}] This is a drill from ${org}. ${text ? endStop(text) : 'No action is needed.'}${requiresAck ? ' Reply SAFE to confirm you received this.' : ''}${stop}`;
  }
  if (kind === 'test') {
    const tag = cleanTag(testTag, 'TEST');
    return `${BRAND}: [${tag}] This is a test of the notification system for ${org}. ${text ? endStop(text) : 'No action is needed.'}${requiresAck ? ' Reply SAFE if you received this.' : ''}${stop}`;
  }
  throw new Error('kind must be alert, drill or test');
}
