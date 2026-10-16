// Builds the exact text recipients get. Alerts, drills and tests all carry the brand and the organization's name, drills and tests
// carry a configurable tag, and every message ends with opt-out wording, matching the sample messages registered with the carriers.
// A browser copy of this logic lives in src/lib/messageFormat.mjs (tests/messageFormat.test.cjs keeps the two identical).
const BRAND = 'Active SOS eMNS';

function cleanTag(tag, fallback) {
  const t = String(tag == null ? '' : tag).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return t || fallback;
}
const endStop = (s) => (/[.!?]$/.test(s) ? s : s + '.');

function formatMessage({ kind, orgName, body, requiresAck = true, drillTag, testTag }) {
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

module.exports = { formatMessage, cleanTag, BRAND };
