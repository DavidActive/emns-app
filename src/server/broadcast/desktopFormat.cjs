// Builds the words shown in a desktop alert. Same rules as text, email and voice: brand, organization name, drill/test wording.
// No "reply STOP" footer: the alert has its own buttons. A browser copy lives in src/lib/desktopFormat.mjs
// (tests/desktopAgent.test.cjs keeps the two identical).
const BRAND = 'Active SOS eMNS';

const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

function formatDesktop({ kind, orgName, body }) {
  if (!['alert', 'drill', 'test'].includes(kind)) throw new Error('kind must be alert, drill or test');
  const org = oneLine(orgName) || 'your organization';
  const text = oneLine(body);
  if (kind === 'alert') return `${BRAND} alert from ${org}: ${text}`.trim();
  if (kind === 'drill') return `[DRILL] ${org}: ${text || 'This is a drill. No action is needed.'}`;
  return `[TEST] ${org}: ${text || 'This is a test of the notification system. No action is needed.'}`;
}

module.exports = { formatDesktop, BRAND };
