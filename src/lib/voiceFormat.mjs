// Browser copy of formatVoice (the words spoken on a call). The server copy is src/server/broadcast/voiceFormat.cjs;
// tests/voiceChannel.test.cjs keeps the two identical.
const BRAND = 'Active SOS eMNS';

const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const endStop = (s) => (/[.!?]$/.test(s) ? s : s + '.');

export function formatVoice({ kind, orgName, body }) {
  if (!['alert', 'drill', 'test'].includes(kind)) throw new Error('kind must be alert, drill or test');
  const org = oneLine(orgName) || 'your organization';
  const text = oneLine(body);
  if (kind === 'alert') return `${BRAND} alert from ${org}. ${text ? endStop(text) : ''}`.trim();
  if (kind === 'drill') return `This is a drill from ${org}. ${text ? endStop(text) : 'No action is needed.'}`;
  return `This is a test of the notification system for ${org}. ${text ? endStop(text) : 'No action is needed.'}`;
}
