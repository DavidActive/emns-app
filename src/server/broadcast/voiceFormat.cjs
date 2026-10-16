// Builds the words spoken on a call, and the TwiML (Twilio's call instructions) around them.
// Spoken text follows the same rules as text and email: brand, organization name, drill/test wording.
// A browser copy of formatVoice lives in src/lib/voiceFormat.mjs (tests/voiceChannel.test.cjs keeps the two identical).
const BRAND = 'Active SOS eMNS';

const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const endStop = (s) => (/[.!?]$/.test(s) ? s : s + '.');

function formatVoice({ kind, orgName, body }) {
  if (!['alert', 'drill', 'test'].includes(kind)) throw new Error('kind must be alert, drill or test');
  const org = oneLine(orgName) || 'your organization';
  const text = oneLine(body);
  if (kind === 'alert') return `${BRAND} alert from ${org}. ${text ? endStop(text) : ''}`.trim();
  if (kind === 'drill') return `This is a drill from ${org}. ${text ? endStop(text) : 'No action is needed.'}`;
  return `This is a test of the notification system for ${org}. ${text ? endStop(text) : 'No action is needed.'}`;
}

const PROMPT_ACK = 'Press 1 if you are safe. Press 2 if you need help. Press 9 to stop receiving calls from this system.';
const PROMPT_STOP = 'To stop receiving calls from this system, press 9.';

const xmlEscape = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (t) => `<Say voice="Polly.Joanna">${xmlEscape(t)}</Say>`;

// First thing Twilio asks when the call connects. A machine gets the message once and no keypad prompt.
function answerTwiml({ text, requiresAck, answeredBy, gatherUrl, attempt = 0 }) {
  if (/^machine|^fax/.test(String(answeredBy || ''))) return xml(`${say(text)}<Pause length="1"/>${say(text)}<Hangup/>`);
  const prompt = requiresAck ? PROMPT_ACK : PROMPT_STOP;
  const gather = `<Gather numDigits="1" timeout="6" action="${xmlEscape(gatherUrl)}" method="POST">${say(text)}${say(prompt)}</Gather>`;
  // No key pressed: say the message once more, then goodbye (the call still counts as answered by the carrier callback).
  return xml(`${gather}${say(text)}${say(prompt)}<Pause length="3"/>${say('Goodbye.')}<Hangup/>`);
}

function digitTwiml({ result, requiresAck, gatherUrl, text }) {
  if (result && result.ok && result.action === 'opt_out') return xml(`${say('You will no longer receive calls from this system. Goodbye.')}<Hangup/>`);
  if (result && result.ok && result.response === 'SAFE') return xml(`${say('Thank you. You are marked safe. Goodbye.')}<Hangup/>`);
  if (result && result.ok && result.response === 'SOS') return xml(`${say('Your request for help has been sent to your organization right now. Stay on the line if you can, or call emergency services if you are in danger. Goodbye.')}<Hangup/>`);
  // Unknown key, or nothing to record: ask again once.
  const prompt = requiresAck ? PROMPT_ACK : PROMPT_STOP;
  return xml(`<Gather numDigits="1" timeout="6" action="${xmlEscape(gatherUrl)}" method="POST">${say('Sorry, that key is not an option.')}${say(prompt)}</Gather>${say('Goodbye.')}<Hangup/>`);
}

module.exports = { formatVoice, answerTwiml, digitTwiml, xmlEscape, PROMPT_ACK, PROMPT_STOP, BRAND };
