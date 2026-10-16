// Twilio's final report for an outbound call (completed, busy, no-answer, failed, canceled).
// The database turns it into the call outcome (answered, voicemail, no answer ...), schedules a retry when the rules allow it,
// and, in fallback mode, releases the person's next channel when the call ultimately fails.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN.

const { checkTwilioSignature } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] });

exports.handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : (event.body || '');
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  const sig = checkTwilioSignature(event, params, 'voice-status');
  if (sig.reject) return { statusCode: 403, body: 'Invalid signature' };

  const sid = params.CallSid;
  const status = params.CallStatus;
  if (!sid || !status) return { statusCode: 200, body: '' };

  const duration = params.CallDuration !== undefined && params.CallDuration !== '' ? Number(params.CallDuration) : null;
  const { error } = await supabase.rpc('apply_call_status', {
    p_sid: sid,
    p_call_status: status,
    p_answered_by: params.AnsweredBy || null,
    p_duration: Number.isFinite(duration) ? Math.round(duration) : null,
    p_error_code: params.ErrorCode || null,
  });
  if (error) { console.error('voice-status: apply_call_status failed', error.message); return { statusCode: 500, body: 'Could not record' }; }
  return { statusCode: 200, body: '' };
};
