/**
 * MessageProvider contract (documented as JSDoc; implementations are plain CommonJS).
 *
 * @typedef {Object} SendRequest
 * @property {'sms'} channel            Only 'sms' in P1. 'voice' and 'email' arrive in later prompts.
 * @property {string} to                E.164 destination (resolved server-side by the caller).
 * @property {string} body
 * @property {string} [from]            Sender number (ignored when messagingServiceSid is given).
 * @property {string} [messagingServiceSid]
 * @property {string} [statusCallback]  URL the provider calls with delivery status.
 *
 * @typedef {Object} SendResult
 * @property {string} sid               Provider message id.
 * @property {string} status            queued | sent | delivered | undelivered | failed
 *
 * MessageProvider: { name: string, send(req: SendRequest): Promise<SendResult> }
 * send() REJECTS with a ProviderError on failure (never resolves with an error shape).
 */
class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}
module.exports = { ProviderError };
