// The consent statement and enrollment confirmation. This text MUST stay identical to the statement published at
// https://www.activesos.com/emns-sms-consent (carriers compare the two). The enrollment page renders what the server returns,
// and the exact text shown is stored with the consent record, so what was agreed to is always provable.
const TEXT_VERSION = 'v2-2026-10-16';
const LINKS = {
  privacy: 'https://www.activesos.com/emns-privacy-policy',
  terms: 'https://www.activesos.com/emns-sms-terms',
  consent: 'https://www.activesos.com/emns-sms-consent',
};

function consentText(orgName) {
  const org = String(orgName || '').trim() || '[Organization Name]';
  return `I agree to receive emergency alerts, drill and test notices, and safety check-in messages by text (SMS) from ${org} through the Active SOS eMNS service (Calm Water Trading, LLC dba Active SOS) at the mobile number I provided. Message frequency varies. Message and data rates may apply. Consent is not a condition of any purchase. Reply STOP to opt out at any time and HELP for help. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. See the Privacy Policy and SMS Terms.`;
}

// One-time confirmation after a person agrees (online, paper or by texting START). It carries the Terms and Privacy links so the text opt-in
// shows the same disclosures as the form. Matches the sample message registered with the carriers.
function confirmationMessage(orgName) {
  const org = String(orgName || '').trim() || 'your organization';
  return `Active SOS eMNS: You are enrolled to receive alerts from ${org}. Message frequency varies. Msg&Data rates may apply. Reply HELP for help, STOP to opt out. Terms: ${LINKS.terms} Privacy: ${LINKS.privacy}`;
}

module.exports = { TEXT_VERSION, LINKS, consentText, confirmationMessage };
