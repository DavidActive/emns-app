// AI per-person activity summary — ports the "Claude review of activity" pattern from the
// Connect app's ActivityLogPanel.tsx to VetProtect. Pulls a person's alert + recovery-log
// history over a selectable window and asks Claude for a short trend/risk summary, then
// stores it in activity_ai_summaries for display in the Veterans/Supporters roster.
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

const { getDb } = require('../../src/server/providers/dataStore.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

const WINDOW_DAYS = { '1m': 30, '3m': 90, all: null };

function sinceDate(window) {
  const days = WINDOW_DAYS[window];
  if (days == null) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured in Netlify.' }) };
  }

  const { enrolled_person_id, window } = JSON.parse(event.body || '{}');
  if (!enrolled_person_id || !WINDOW_DAYS.hasOwnProperty(window)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'enrolled_person_id and window (1m|3m|all) are required.' }) };
  }

  const { data: person, error: personError } = await supabase
    .from('enrolled_people')
    .select('id, full_name, organization_id, branch_of_service, discharge_era, va_connected')
    .eq('id', enrolled_person_id)
    .single();

  if (personError || !person) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Person not found.' }) };
  }

  const since = sinceDate(window);

  let alertsQuery = supabase
    .from('alerts')
    .select('tier, alert_type, message_body, status, created_at')
    .eq('enrolled_person_id', enrolled_person_id)
    .order('created_at', { ascending: true });
  if (since) alertsQuery = alertsQuery.gte('created_at', since);
  const { data: alerts } = await alertsQuery;

  let recoveryQuery = supabase
    .from('recovery_activity_log')
    .select('activity_type, summary, activity_date')
    .eq('enrolled_person_id', enrolled_person_id)
    .order('activity_date', { ascending: true });
  if (since) recoveryQuery = recoveryQuery.gte('activity_date', since.slice(0, 10));
  const { data: recoveryLog, error: recoveryError } = await recoveryQuery;
  if (recoveryError) console.error('generate-activity-report: recovery_activity_log query failed', recoveryError);

  const alertLines = (alerts ?? [])
    .map((a) => `- [${new Date(a.created_at).toISOString().slice(0, 10)}] Tier ${a.tier} ${a.alert_type} (${a.status}): ${a.message_body ?? '(no text)'}`)
    .join('\n');
  const recoveryLines = (recoveryLog ?? [])
    .map((r) => `- [${r.activity_date}] ${r.activity_type}: ${r.summary ?? ''}`)
    .join('\n');

  const windowLabel = window === '1m' ? 'the last 1 month' : window === '3m' ? 'the last 3 months' : 'all recorded history';

  const prompt = `You are a peer-support triage assistant for VetProtect, a veteran alert/check-in system. Summarize this person's activity over ${windowLabel} for a human staff reviewer. Be concise, factual, and non-clinical — you are not diagnosing anything, only surfacing patterns for a human to look at.

Person: ${person.full_name ?? 'Unknown'} (branch: ${person.branch_of_service ?? 'unknown'}, VA-connected: ${person.va_connected ?? 'unknown'})

Alerts:
${alertLines || '(none in this window)'}

Recovery activity log:
${recoveryLines || '(none in this window)'}

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"summary": "2-4 sentence plain-language summary of trends, frequency, and anything notable", "risk_flag": "low" | "elevated" | "high"}`;

  let summary = '';
  let riskFlag = 'low';
  try {
    const raw = await callClaude(prompt);
    const parsed = JSON.parse(raw.trim());
    summary = parsed.summary ?? raw;
    riskFlag = ['low', 'elevated', 'high'].includes(parsed.risk_flag) ? parsed.risk_flag : 'low';
  } catch (err) {
    console.error('generate-activity-report: failed to parse Claude response', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'AI summary generation failed.' }) };
  }

  const { data: saved, error: insertError } = await supabase
    .from('activity_ai_summaries')
    .insert({
      enrolled_person_id,
      organization_id: person.organization_id,
      summary,
      risk_flag: riskFlag,
      time_window: window,
    })
    .select('id, summary, risk_flag, time_window, generated_at')
    .single();

  if (insertError) {
    console.error('generate-activity-report: failed to save summary', insertError);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save summary.' }) };
  }

  return { statusCode: 200, body: JSON.stringify(saved) };
};
