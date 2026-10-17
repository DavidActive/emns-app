// Twilio request-signature verification (single shared copy; replaces helpers inlined in each function).
// Enforcement is ON by default in eMNS. Set TWILIO_ENFORCE_SIGNATURE=false only for local debugging; it has no effect when CONTEXT=production.
const crypto = require('crypto');
const { isProduction, publicBaseUrl } = require('../runtime.cjs');

function validateTwilioRequest(authToken, signature, url, params) {
  if (!authToken || !signature) return false;
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function baseUrl(event, env = process.env) {
  if (env.TWILIO_WEBHOOK_BASE_URL) return env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '');
  const h = event.headers || {};
  const proto = h['x-forwarded-proto'] || 'https';
  const host = h['x-forwarded-host'] || h.host;
  return `${proto}://${host}`; // the address Twilio called: never the EMNS_BASE_URL override, which could differ behind a proxy
}

function checkTwilioSignature(event, params, functionName, env = process.env) {
  // The debug switch is ignored on the production deploy (Netlify sets CONTEXT=production there).
  const enforce = env.TWILIO_ENFORCE_SIGNATURE !== 'false' || isProduction(env);
  const signature = (event.headers || {})['x-twilio-signature'] || '';
  const url = `${baseUrl(event, env)}/.netlify/functions/${functionName}`;
  let valid = false;
  let diag = '';
  try {
    valid = Boolean(signature) && validateTwilioRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
  } catch (e) {
    console.error(`${functionName}: signature validation threw`, e);
  }
  if (!valid) {
    // Diagnostics only: never logs the token or signature. Shows whether the token exists and which URL form (if any) would have matched.
    const h = event.headers || {};
    const tok = env.TWILIO_AUTH_TOKEN || '';
    const candidates = {
      computed: url,
      host_header: `https://${h.host}/.netlify/functions/${functionName}`,
      forwarded_host: `https://${h['x-forwarded-host']}/.netlify/functions/${functionName}`,
      no_functions_prefix: `https://${h.host}/${functionName}`,
    };
    const matches = Object.entries(candidates).filter(([, u]) => { try { return validateTwilioRequest(tok, signature, u, params); } catch { return false; } }).map(([k]) => k);
    diag = `url=${url} tokenPresent=${Boolean(tok)} tokenLength=${tok.length} tokenHasWhitespaceOrQuote=${/^[\s"']|[\s"']$/.test(tok)} baseUrlOverride=${Boolean(env.TWILIO_WEBHOOK_BASE_URL)} sigHeaderPresent=${Boolean(signature)} paramCount=${Object.keys(params || {}).length} matchingUrlForms=${JSON.stringify(matches)}`;
    console.warn(`${functionName}: Twilio signature NOT valid (enforce=${enforce}) ${diag}`);
  }
  return { valid, enforce, reject: enforce && !valid, diag };
}

module.exports = { validateTwilioRequest, baseUrl, checkTwilioSignature };
