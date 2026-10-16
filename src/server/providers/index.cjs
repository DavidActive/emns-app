// Provider factory. Defaults are SAFE: mock provider, no real sends.
const { createMockMessageProvider } = require('./mockMessageProvider.cjs');
const { createTwilioMessageProvider } = require('./twilioMessageProvider.cjs');
const { ProviderError } = require('./types.cjs');

let messageOverride = null;           // tests can inject a provider
let cached = null;

function setMessageProviderForTests(p) { messageOverride = p; cached = null; }

function getMessageProvider(env = process.env) {
  if (messageOverride) return messageOverride;
  if (cached && cached.env === env) return cached.provider;
  const choice = (env.EMNS_MESSAGE_PROVIDER || 'mock').toLowerCase();
  let provider;
  if (choice === 'twilio') {
    if (env.EMNS_ALLOW_REAL_SEND !== 'true') {
      throw new ProviderError('Real sends are disabled. Set EMNS_ALLOW_REAL_SEND=true to use the Twilio provider.', 'real_send_disabled');
    }
    provider = createTwilioMessageProvider(env);
  } else if (choice === 'mock') {
    provider = createMockMessageProvider();
  } else {
    throw new ProviderError(`Unknown EMNS_MESSAGE_PROVIDER "${choice}".`, 'bad_config');
  }
  cached = { env, provider };
  return provider;
}

module.exports = { getMessageProvider, setMessageProviderForTests };
