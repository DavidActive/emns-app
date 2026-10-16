// AI population-level triage summary — analyzes the whole enrolled roster for an
// organization over a lookback window and asks Claude to rank who needs staff attention
// now, with reasoning. Complements generate-activity-report.js (per-person, persisted)
// but this one is ephemeral: it is regenerated on demand and not stored, since there is
// no org-level summaries table yet. If this becomes a daily/weekly habit, promote it to
// a real table (e.g. population_reports) rather than re-deriving it every click.
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

const { getDb } = require('../../src/server/providers/dataStore.cjs');

const supabase = new Proxy({}, { get: (_t, k) => getDb()[k] }); // lazy so tests can inject a fake DataStore

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
      max_tokens: 2000,
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

  const { organization_id, lookback_days } = JSON.parse(event.body || '{}');
  if (!organization_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'organization_id is required.' }) };
  }
  const days = Number.isFinite(lookback_days) ? lookback_days : 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: people, error: peopleError } = await supabase
    .from('enrolled_people')
    .select('id, full_name, branch_of_service, va_connected')
    .eq('organization_id', organization_id)
    .eq('enrolled', true);
  if (peopleError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load roster.' }) };
  }
  if (!people || people.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ overall_summary: 'No enrolled veterans/supporters yet.', attention_list: [], generated_at: new Date().toISOString(), lookback_days: days }) };
  }

  const { data: alerts, error: alertsError } = await supabase
    .from('alerts')
    .select('enrolled_person_id, tier, alert_type, message_body, status, created_at')
    .eq('organization_id', organization_id)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });
  if (alertsError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load alerts.' }) };
  }

  const byPerson = new Map(people.map((p) => [p.id, { ...p, tier1: 0, tier2: 0, tier3: 0, latest: null }]));
  for (const a of alerts ?? []) {
    const bucket = byPerson.get(a.enrolled_person_id);
    if (!bucket) continue;
    if (a.tier === 1) bucket.tier1++;
    else if (a.tier === 2) bucket.tier2++;
    else if (a.tier === 3) bucket.tier3++;
    bucket.latest = a; // alerts are ordered ascending, so this ends up as the most recent
  }

  const rosterLines = Array.from(byPerson.values())
    .map((p) => {
      const latest = p.latest
        ? `most recent: [${new Date(p.latest.created_at).toISOString().slice(0, 10)}] Tier ${p.latest.tier} ${p.latest.alert_type}: "${p.latest.message_body ?? ''}"`
        : 'no alerts in window';
      return `- ${p.full_name} (branch: ${p.branch_of_service ?? 'unknown'}, VA-connected: ${p.va_connected ?? 'unknown'}): Tier1=${p.tier1}, Tier2=${p.tier2}, Tier3=${p.tier3}; ${latest}`;
    })
    .join('\n');

  const prompt = `You are a peer-support triage assistant for VetProtect, a veteran alert/check-in system. Below is the entire enrolled roster for one VetSupport Group organization, with alert-tier counts over the last ${days} days for each person. Tier 1 = routine check-in, Tier 2 = elevated concern, Tier 3 = active crisis (already escalated to the Veterans Crisis Line at the time it happened).

Your job is NOT to re-diagnose or re-escalate anything — Tier 3 events are already handled through the crisis line. Instead, identify which people a staff member should proactively check on today, based on patterns like: any Tier 3 in the window, rising Tier 2 frequency, a cluster of concerning messages, or a person who has gone quiet (no check-ins at all when others are checking in regularly). Be concise and factual, non-clinical.

Roster:
${rosterLines}

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"overall_summary": "2-4 sentence narrative of the roster's overall state this period", "attention_list": [{"full_name": "...", "risk_flag": "low" | "elevated" | "high", "reason": "1-2 sentence reason this person is flagged"}]}
Only include people in attention_list who genuinely warrant a look (skip people who are simply checking in normally) — order high risk first. If nobody needs attention, return an empty attention_list.`;

  let parsed;
  try {
    const raw = await callClaude(prompt);
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    console.error('generate-population-report: failed to get/parse Claude response', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'AI triage summary generation failed.' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      overall_summary: parsed.overall_summary ?? '',
      attention_list: Array.isArray(parsed.attention_list) ? parsed.attention_list : [],
      generated_at: new Date().toISOString(),
      lookback_days: days,
      roster_size: people.length,
    }),
  };
};
