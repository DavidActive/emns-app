// Builds the subject and plain-text body recipients get by email. Same rules as the text message: brand, organization name,
// DRILL/TEST tag. There is no STOP keyword in email, so the footer explains how the address was obtained instead.
// A browser copy lives in src/lib/emailFormat.mjs (tests/emailChannel.test.cjs keeps the two identical).
const BRAND = 'Active SOS eMNS';

function cleanTag(tag, fallback) {
  const t = String(tag == null ? '' : tag).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return t || fallback;
}
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

function formatEmail({ kind, orgName, subject, body, requiresAck = true, drillTag, testTag }) {
  if (!['alert', 'drill', 'test'].includes(kind)) throw new Error('kind must be alert, drill or test');
  const org = oneLine(orgName) || 'your organization';
  const text = String(body == null ? '' : body).trim();
  const given = oneLine(subject);
  const tag = kind === 'drill' ? cleanTag(drillTag, 'DRILL') : cleanTag(testTag, 'TEST');
  let subj; let lead;
  if (kind === 'alert') {
    subj = `ALERT from ${org}${given ? `: ${given}` : ''}`;
    lead = `ALERT from ${org}`;
  } else if (kind === 'drill') {
    subj = `[${tag}] ${given || `Drill from ${org}`}`;
    lead = `[${tag}] This is a drill from ${org}.`;
  } else {
    subj = `[${tag}] ${given || `Test of the notification system for ${org}`}`;
    lead = `[${tag}] This is a test of the notification system for ${org}.`;
  }
  const parts = [lead];
  if (text) parts.push(text); else if (kind !== 'alert') parts.push('No action is needed.');
  if (requiresAck) parts.push(kind === 'alert'
    ? 'Your organization has asked everyone to confirm they are safe. If you also received a text message, reply SAFE to it. Otherwise contact your organization directly.'
    : 'If you also received a text message, reply SAFE to it to confirm you received this.');
  parts.push(`--\nSent by ${BRAND} on behalf of ${org}. You are receiving this because ${org} listed this email address for emergency notifications. Contact ${org} to change how you are notified.`);
  return { subject: subj.slice(0, 200), text: parts.join('\n\n') };
}
module.exports = { formatEmail, cleanTag, BRAND };
