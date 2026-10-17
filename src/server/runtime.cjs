// Hosting-specific facts in one place, so the functions run unchanged on Netlify or in a container.
//   EMNS_BASE_URL      public address of the site (Netlify supplies URL)
//   EMNS_INTERNAL_URL  address the worker/sweeper use to reach the app (defaults to the public one)
//   EMNS_ENV           'production' locks safety switches (Netlify's CONTEXT=production counts too)
// Function URLs keep the /.netlify/functions/<name> path form on every host: Twilio's webhook addresses and the browser code depend on it,
// and the container server answers on the same paths.
const FUNCTIONS_PREFIX = '/.netlify/functions';

const stripSlash = (s) => String(s || '').replace(/\/$/, '');
function publicBaseUrl(event, env = process.env) {
  if (env.EMNS_BASE_URL) return stripSlash(env.EMNS_BASE_URL);
  if (env.URL) return stripSlash(env.URL);
  const h = (event && event.headers) || {};
  const proto = h['x-forwarded-proto'] || 'https';
  const host = h['x-forwarded-host'] || h.host;
  return host ? `${proto}://${host}` : '';
}
function internalBaseUrl(event, env = process.env) {
  return stripSlash(env.EMNS_INTERNAL_URL) || publicBaseUrl(event, env);
}
const functionUrl = (base, name) => `${stripSlash(base)}${FUNCTIONS_PREFIX}/${name}`;
const isProduction = (env = process.env) => env.EMNS_ENV === 'production' || env.CONTEXT === 'production';
function clientIp(event) {
  const h = event.headers || {};
  return (h['x-nf-client-connection-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}
module.exports = { FUNCTIONS_PREFIX, publicBaseUrl, internalBaseUrl, functionUrl, isProduction, clientIp };
