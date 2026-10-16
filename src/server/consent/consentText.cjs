// The consent statement and enrollment confirmation. This text MUST stay identical to the statement published at
// https://www.activesos.com/emns-sms-consent (carriers compare the two). The enrollment page renders what the server returns,
// and the exact text shown is stored with the consent record, so what was agreed to is always provable.
const TEXT_VERSION = 'v1-2026-10-15';
const LINKS = {
  privacy: 'https://www.activesos.com/emns-privacy-policy',
  terms: 'https://www.activesos.com/emns-sms-terms',
  consent: 'https://www.activesos.com/emns-sms-consent',
};

function consentText(orgName) {
  const org = String(orgName || '').trim() || '[Organization Name]';
  return `I agree to receive emergency alerts, drill and test notices, and safety check-in messages by text (SMS) from ${org} through the Active SOS eMNS service (Calm Water Trading, LLC dba Active SOS) at the mobile number I provided. Message frequency varies. Message and data rates may apply. Consent is not a condition of any purchase. Reply STOP to opt out at any time and HELP for help. See the Privacy Policy and SMS Terms.`;
}

// One-time confirmation after a person agrees. Matches the sample message registered with the carriers.
function confirmationMessage(orgName) {
  const org = String(orgName || '').trim() || 'your organization';
  return `Active SOS eMNS: You are enrolled to receive alerts from ${org}. Message frequency varies. Msg&Data rates may apply. Reply HELP for help, STOP to opt out.`;
}

module.exports = { TEXT_VERSION, LINKS, consentText, confirmationMessage };
