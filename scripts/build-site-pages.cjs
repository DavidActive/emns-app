// Builds the three public eMNS web pages that carriers review for the A2P 10DLC campaign:
//   emns-privacy-policy.html, emns-sms-terms.html, emns-sms-consent.html
// The consent statement is read from src/server/consent/consentText.cjs, so the published page and the enrollment
// form can never drift apart (carriers compare them). Run:  node scripts/build-site-pages.cjs
// Output: site-pages/ (publish each file at https://www.activesos.com/<name without .html>).
const fs = require('fs');
const path = require('path');
const { consentText, confirmationMessage, LINKS, TEXT_VERSION } = require('../src/server/consent/consentText.cjs');

const CONTACT_EMAIL = process.env.EMNS_CONTACT_EMAIL || 'david.zink@activesos.com';
const COMPANY = 'Calm Water Trading, LLC dba Active SOS';
const UPDATED = 'October 16, 2026';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NO_SHARE = 'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties.';

const css = `
:root{--navy:#1B3A6B;--teal:#00A99D;--teal-light:#e6f7f6;--gray:#f0f4f8;--line:#d1d8e0;--text:#2d3748;--muted:#718096}
@media (prefers-color-scheme:dark){:root{--navy:#9db8e6;--teal:#2dd4c8;--teal-light:#12302f;--gray:#1c2430;--line:#394556;--text:#e2e8f0;--muted:#a0aec0}body{background:#111826}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text);background:#fff;line-height:1.6}
header{border-bottom:4px solid var(--teal);padding:16px}header div,main,footer{max-width:760px;margin:0 auto}header strong{color:var(--navy);font-size:1.1rem}
main{padding:24px 16px 48px}h1{color:var(--navy);margin:0 0 4px;font-size:1.8rem}h2{color:var(--navy);margin-top:32px;font-size:1.25rem}
.muted{color:var(--muted);font-size:.9rem}.box{background:var(--teal-light);border:1px solid var(--teal);border-radius:8px;padding:14px 16px;margin:16px 0}
.sample{background:var(--gray);border:1px dashed var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.form{border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}.form label{display:flex;gap:12px;align-items:flex-start}
.form input[type=checkbox]{width:22px;height:22px;margin-top:4px;flex:none}.btn{display:inline-block;margin-top:12px;padding:10px 18px;border-radius:6px;background:var(--line);color:var(--muted);font-weight:600}
a{color:var(--navy)}footer{padding:0 16px 32px;color:var(--muted);font-size:.85rem}`;

function page({ title, desc, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Active SOS eMNS</title><meta name="description" content="${esc(desc)}">
<style>${css}</style></head><body>
<header><div><strong>Active SOS eMNS</strong> <span class="muted">Emergency mass notification by ${esc(COMPANY)}</span></div></header>
<main>${body}</main>
<footer>&copy; ${esc(COMPANY)}. <a href="${LINKS.privacy}">Privacy Policy</a> &middot; <a href="${LINKS.terms}">SMS Terms</a> &middot; <a href="${LINKS.consent}">SMS Consent</a></footer>
</body></html>
`;
}

// ---------- Privacy policy ----------
const privacy = page({
  title: 'Privacy Policy',
  desc: 'How Active SOS eMNS collects, uses and protects information, including mobile numbers and text message consent.',
  body: `
<h1>Privacy Policy &mdash; Active SOS eMNS</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>Active SOS eMNS is an emergency mass notification service operated by ${esc(COMPANY)} (&ldquo;Active SOS,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). Organizations such as employers, schools and community groups use it to send alerts, drills, tests and safety check-ins to the people on their own rosters. This policy explains what we collect, how we use it and the choices you have.</p>
<div class="box"><strong>Mobile information and text messaging.</strong> ${esc(NO_SHARE)}</div>

<h2>Information we collect</h2>
<ul>
<li><strong>Roster information</strong> your organization gives us: your name, mobile phone number, email address and the groups you belong to.</li>
<li><strong>Consent records:</strong> when and how you agreed to receive text messages, the exact wording shown to you, and any STOP or START requests.</li>
<li><strong>Message activity:</strong> the notifications we send you, delivery status from carriers, and any replies you send (for example SAFE or a free-text reply).</li>
<li><strong>Basic technical data</strong> when you open an enrollment link, such as the time of the visit.</li>
</ul>

<h2>How we use it</h2>
<p>We use this information only to deliver the notifications your organization sends, to record your responses so your organization can see who is safe, to prove consent, to keep the service secure, and to meet legal obligations. We do not send marketing or promotional messages.</p>

<h2>Sharing</h2>
<p>We share information with your organization (the sender of the notifications) and with service providers that carry out delivery for us, such as our telecommunications and email delivery providers and our hosting and database providers. These providers may use the information only to provide their services to us. We do not sell personal information. ${esc(NO_SHARE)}</p>

<h2>Retention and security</h2>
<p>We keep notification and consent records for as long as your organization uses the service and as needed to document consent and meet legal requirements. Information is encrypted in transit and access is limited to authorized personnel and to each organization&rsquo;s own authorized staff.</p>

<h2>Your choices</h2>
<ul>
<li>Reply <strong>STOP</strong> to any text message to stop receiving texts. Reply <strong>START</strong> to resume. Reply <strong>HELP</strong> for help.</li>
<li>To correct or remove your information, contact your organization or write to us at the address below.</li>
</ul>

<h2>Contact</h2>
<p>${esc(COMPANY)}<br>Email: <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>
<p>See also our <a href="${LINKS.terms}">SMS Terms</a> and <a href="${LINKS.consent}">SMS Consent</a> page.</p>`,
});

// ---------- SMS terms ----------
const terms = page({
  title: 'SMS Terms',
  desc: 'Terms and conditions for the Active SOS eMNS text message program.',
  body: `
<h1>SMS Terms &amp; Conditions &mdash; Active SOS eMNS</h1>
<p class="muted">Last updated ${UPDATED}</p>
<h2>Program description</h2>
<p>The Active SOS eMNS text message program is operated by ${esc(COMPANY)}. It sends emergency alerts, drill and test notices and safety check-in messages on behalf of the organization that enrolled you. Message types are limited to these notifications and related replies. We do not send marketing or promotional messages.</p>
<h2>How you join</h2>
<p>You join only after you agree on the organization&rsquo;s enrollment page (see <a href="${LINKS.consent}">SMS Consent</a>) by checking an unchecked box. Agreeing is not a condition of any purchase.</p>
<h2>Message frequency</h2>
<p>Message frequency varies with your organization&rsquo;s alerts, drills and tests.</p>
<h2>Cost</h2>
<p>Message and data rates may apply. Active SOS does not charge you for these messages.</p>
<h2>Opt out and help</h2>
<p>Reply <strong>STOP</strong> at any time to opt out. You will get one confirmation and no further texts. Reply <strong>START</strong> to rejoin. Reply <strong>HELP</strong> for help, or write to <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a>.</p>
<h2>Carriers</h2>
<p>Carriers are not liable for delayed or undelivered messages. Do not rely on text messages alone in an emergency. Call 911 if you are in danger.</p>
<h2>Privacy</h2>
<p>${esc(NO_SHARE)} See our <a href="${LINKS.privacy}">Privacy Policy</a>.</p>
<h2>Changes</h2>
<p>We may update these terms and will post changes on this page.</p>
<h2>Contact</h2>
<p>${esc(COMPANY)}<br>Email: <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>`,
});

// ---------- Consent / opt-in evidence ----------
const sampleOrg = 'Acme Hospital';
const statement = esc(consentText(sampleOrg))
  .replace('Privacy Policy', `<a href="${LINKS.privacy}">Privacy Policy</a>`)
  .replace('SMS Terms', `<a href="${LINKS.terms}">SMS Terms</a>`);
const consent = page({
  title: 'SMS Consent',
  desc: 'How people opt in to Active SOS eMNS text messages, with the exact consent wording, sample messages and opt-out instructions.',
  body: `
<h1>SMS Consent &mdash; Active SOS eMNS</h1>
<p class="muted">Consent wording version ${esc(TEXT_VERSION)}</p>
<p>Active SOS eMNS (${esc(COMPANY)}) sends emergency alerts, drills, tests and safety check-ins by text message for organizations, to people those organizations have enrolled. Nobody is texted until they agree below.</p>

<h2>How people opt in</h2>
<ol>
<li>The organization adds a person to its roster and sends them a personal enrollment link.</li>
<li>The person opens the link and sees the consent statement below with an <strong>unchecked</strong> box. The Privacy Policy and SMS Terms are linked on the same page.</li>
<li>The person checks the box and taps <em>Agree</em>. We save the exact wording, the time and the version shown.</li>
<li>We send one confirmation text. No other texts are sent before the person agrees.</li>
</ol>

<h2>What the person sees</h2>
<div class="form">
<label><input type="checkbox" disabled><span>${statement}</span></label>
<div class="btn">Agree and enroll (disabled until the box is checked)</div>
<p class="muted">Links on the form: <a href="${LINKS.privacy}">Privacy Policy</a> &middot; <a href="${LINKS.terms}">SMS Terms</a> &middot; <a href="${LINKS.consent}">About this consent</a></p>
</div>

<h2>Confirmation text</h2>
<div class="sample">${esc(confirmationMessage(sampleOrg))}</div>

<h2>Sample messages</h2>
<div class="sample">Active SOS eMNS: [DRILL] This is a drill from ${esc(sampleOrg)}. No action is needed. Reply SAFE to confirm you received this. Reply STOP to opt out.</div>
<div class="sample">Active SOS eMNS: ALERT from ${esc(sampleOrg)}: Shelter in place. Reply SAFE when secure. Reply STOP to opt out.</div>
<div class="sample">Active SOS eMNS: [TEST] This is a test of the notification system for ${esc(sampleOrg)}. No action is needed. Reply STOP to opt out.</div>

<h2>Opting out and help</h2>
<p>Reply <strong>STOP</strong> to any message to opt out, <strong>START</strong> to rejoin and <strong>HELP</strong> for help. Message frequency varies. Message and data rates may apply. Consent is not a condition of any purchase.</p>
<p>${esc(NO_SHARE)}</p>
<p>Contact: <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>`,
});

const out = path.resolve(__dirname, '../site-pages');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'emns-privacy-policy.html'), privacy);
fs.writeFileSync(path.join(out, 'emns-sms-terms.html'), terms);
fs.writeFileSync(path.join(out, 'emns-sms-consent.html'), consent);
console.log('wrote', fs.readdirSync(out).join(', '), '->', out);
