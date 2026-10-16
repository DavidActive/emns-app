import { supabase } from './supabaseClient';

export interface SendSmsResult {
  ok: boolean;
  error?: string;
  code?: string | number;
}

// Sends a staff reply through the authenticated send-sms Netlify function. The recipient is
// resolved server-side from the alert, so only the alert id and text are sent from the browser.
export async function sendSms(alertId: string, body: string, templateId?: string | null): Promise<SendSmsResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, error: 'Your session has expired. Please sign in again.' };

  try {
    const res = await fetch('/.netlify/functions/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ alert_id: alertId, body, template_id: templateId ?? undefined }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `Send failed (${res.status}).`, code: json.code };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — the text was not sent. Check your connection and try again.' };
  }
}
