// Twilio delivery-status callback for outbound staff replies (set per-message by send-sms.js).
// Updates alert_messages.delivery_status so the portal can show Sent / Delivered / Failed.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN.

const { checkTwilioSignature, baseUrl } = require('../../src/server/providers/twilioSignature.cjs');
const { getDb } = require('../../src/server/providers/dataStore.cjs');


const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore
const ok = { statusCode: 200, body: '' };

exports.handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  const sig = checkTwilioSignature(event, params, 'sms-status');
  if (sig.reject) return { statusCode: 403, body: 'Invalid signature' };

  const sid = params.MessageSid || params.SmsSid;
  const status = params.MessageStatus || params.SmsStatus;
  if (!sid || !status) return ok;

  const { data: msg } = await supabase
    .from('alert_messages')
    .update({ delivery_status: status, error_code: params.ErrorCode || null })
    .eq('twilio_sid', sid)
    .select('alert_id')
    .maybeSingle();

  // Carrier-level STOP surfaces as 21610 on delivery too — keep the opt-out flag in sync.
  if (msg && params.ErrorCode === '21610') {
    const { data: alert } = await supabase.from('alerts').select('enrolled_person_id').eq('id', msg.alert_id).maybeSingle();
    if (alert?.enrolled_person_id) {
      await supabase.from('enrolled_people').update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString() }).eq('id', alert.enrolled_person_id);
    }
  }
  return ok;
};
