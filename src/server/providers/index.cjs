// Provider factory. Defaults are SAFE: mock provider, no real sends.
const { createMockMessageProvider } = require('./mockMessageProvider.cjs');
const { createTwilioMessageProvider } = require('./twilioMessageProvider.cjs');
const { createMockEmailProvider } = require('./mockEmailProvider.cjs');
const { createResendEmailProvider } = require('./resendEmailProvider.cjs');
const { createMockVoiceProvider } = require('./mockVoiceProvider.cjs');
const { createTwilioVoiceProvider } = require('./twilioVoiceProvider.cjs');
const { ProviderError } = require('./types.cjs');

let messageOverride = null;           // tests can inject a provider
let cached = null;
let emailOverride = null;
let emailCached = null;
let voiceOverride = null;
let voiceCached = null;

function setMessageProviderForTests(p) { messageOverride = p; cached = null; }

function setEmailProviderForTests(p) { emailOverride = p; emailCached = null; }

function setVoiceProviderForTests(p) { voiceOverride = p; voiceCached = null; }

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

// Email provider. Same safe default: mock, no real sends. The real provider needs EMNS_EMAIL_PROVIDER=resend AND EMNS_ALLOW_REAL_SEND=true.
function getEmailProvider(env = process.env) {
  if (emailOverride) return emailOverride;
  if (emailCached && emailCached.env === env) return emailCached.provider;
  const choice = (env.EMNS_EMAIL_PROVIDER || 'mock').toLowerCase();
  let provider;
  if (choice === 'resend') {
    if (env.EMNS_ALLOW_REAL_SEND !== 'true') {
      throw new ProviderError('Real sends are disabled. Set EMNS_ALLOW_REAL_SEND=true to use the Resend provider.', 'real_send_disabled');
    }
    provider = createResendEmailProvider(env);
  } else if (choice === 'mock') {
    provider = createMockEmailProvider();
  } else {
    throw new ProviderError(`Unknown EMNS_EMAIL_PROVIDER "${choice}".`, 'bad_config');
  }
  emailCached = { env, provider };
  return provider;
}

// Voice provider. Same safe default: mock, no real calls. The real provider needs EMNS_VOICE_PROVIDER=twilio AND EMNS_ALLOW_REAL_SEND=true.
function getVoiceProvider(env = process.env) {
  if (voiceOverride) return voiceOverride;
  if (voiceCached && voiceCached.env === env) return voiceCached.provider;
  const choice = (env.EMNS_VOICE_PROVIDER || 'mock').toLowerCase();
  let provider;
  if (choice === 'twilio') {
    if (env.EMNS_ALLOW_REAL_SEND !== 'true') {
      throw new ProviderError('Real sends are disabled. Set EMNS_ALLOW_REAL_SEND=true to place real calls.', 'real_send_disabled');
    }
    provider = createTwilioVoiceProvider(env);
  } else if (choice === 'mock') {
    provider = createMockVoiceProvider();
  } else {
    throw new ProviderError(`Unknown EMNS_VOICE_PROVIDER "${choice}".`, 'bad_config');
  }
  voiceCached = { env, provider };
  return provider;
}

module.exports = { getMessageProvider, setMessageProviderForTests, getEmailProvider, setEmailProviderForTests, getVoiceProvider, setVoiceProviderForTests };
