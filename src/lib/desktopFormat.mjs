// Browser copy of formatDesktop (the words shown in a desktop alert). The server copy is src/server/broadcast/desktopFormat.cjs;
// tests/desktopAgent.test.cjs keeps the two identical.
const BRAND = 'Active SOS eMNS';

const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export function formatDesktop({ kind, orgName, body }) {
  if (!['alert', 'drill', 'test'].includes(kind)) throw new Error('kind must be alert, drill or test');
  const org = oneLine(orgName) || 'your organization';
  const text = oneLine(body);
  if (kind === 'alert') return `${BRAND} alert from ${org}: ${text}`.trim();
  if (kind === 'drill') return `[DRILL] ${org}: ${text || 'This is a drill. No action is needed.'}`;
  return `[TEST] ${org}: ${text || 'This is a test of the notification system. No action is needed.'}`;
}
