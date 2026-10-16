import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { sendSms } from '../lib/sendSms';
import ConversationPanel from '../components/ConversationPanel';

interface LastMessage { direction: 'inbound' | 'outbound'; body: string | null; created_at: string }

interface AlertRow {
  id: string;
  tier: 1 | 2 | 3;
  status: string;
  item_type: string;
  message_body: string | null;
  gps_url: string | null;
  created_at: string;
  last_inbound_at: string | null;
  person_id: string | null;
  organization_id: string;
  unread_reply: boolean;
  // Supabase's type inference says array, but for a many-to-one FK (alerts.person_id
  // -> people.id) PostgREST actually returns a single object at runtime. Typed
  // loosely here and normalized in getPerson() below to handle either shape safely.
  people: unknown;
  // Most recent message on this alert (nested select, limit 1) — used for the thread preview.
  inbox_messages: LastMessage[] | null;
}

interface Person { full_name: string | null; mobile_phone: string | null; sms_opted_out: boolean | null }

function getPerson(row: AlertRow): Person | null {
  const raw = row.people;
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw as Person);
}

// One inbox card per person: every open/acknowledged alert from the same person is merged
// into a single thread so a conversation can't be split across cards.
interface Thread {
  key: string;
  personId: string | null;
  person: Person | null;
  alerts: AlertRow[];        // oldest -> newest
  latest: AlertRow;          // newest alert: where staff replies are attached
  topAlert: AlertRow;        // highest-tier alert (newest among ties): drives the tier badge / escalation
  tier: 1 | 2 | 3;
  status: 'open' | 'acknowledged';
  unread: boolean;
  lastActivity: number;      // ms; latest message FROM the person (or alert creation)
  preview: LastMessage | null;
}

const activityOf = (a: AlertRow) => new Date(a.last_inbound_at ?? a.created_at).getTime();

function buildThreads(alerts: AlertRow[]): Thread[] {
  const groups = new Map<string, AlertRow[]>();
  for (const a of alerts) {
    // Alerts with no enrolled person can't be merged safely, so they stay on their own card.
    const key = a.person_id ? `p:${a.person_id}` : `a:${a.id}`;
    const list = groups.get(key);
    if (list) list.push(a); else groups.set(key, [a]);
  }
  const threads: Thread[] = [];
  groups.forEach((list, key) => {
    const sorted = [...list].sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime());
    const latest = sorted[sorted.length - 1];
    const topAlert = sorted.reduce((best, a) => (a.tier >= best.tier ? a : best), sorted[0]);
    let preview: LastMessage | null = null;
    for (const a of sorted) {
      const m = a.inbox_messages?.[0];
      if (m && (!preview || new Date(m.created_at) > new Date(preview.created_at))) preview = m;
    }
    threads.push({
      key,
      personId: latest.person_id,
      person: sorted.map(getPerson).find(Boolean) ?? null,
      alerts: sorted,
      latest,
      topAlert,
      tier: topAlert.tier,
      status: sorted.some((a) => a.status === 'open') ? 'open' : 'acknowledged',
      unread: sorted.some((a) => a.unread_reply),
      lastActivity: Math.max(...sorted.map(activityOf)),
      preview,
    });
  });
  // An unacknowledged Tier 3 (critical) is never allowed to sink below newer, calmer threads.
  // Everything else is newest message from the person first.
  const pinned = (t: Thread) => t.tier === 3 && t.status === 'open';
  threads.sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || b.lastActivity - a.lastActivity);
  return threads;
}

const ESCALATION_TEXT =
  'This is an urgent message from your organization. A team member has been notified and will contact you. If you are in immediate danger, call 911.';

export default function TriageInbox() {
  const { staff } = useAuth();
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await supabase
      .from('inbox_items')
      .select(
        'id, tier, status, item_type, message_body, gps_url, created_at, last_inbound_at, person_id, organization_id, unread_reply, people ( full_name, mobile_phone, sms_opted_out ), inbox_messages ( direction, body, created_at )'
      )
      .in('status', ['open', 'acknowledged'])
      .order('created_at', { ascending: false, referencedTable: 'inbox_messages' })
      .limit(1, { referencedTable: 'inbox_messages' });
    setAlerts((data as unknown as AlertRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();

    // Auto-refresh, same as the Connect/Protect triage inboxes: poll on an interval so
    // new inbound alerts show up without the staff member having to click Refresh.
    const interval = setInterval(load, 8000);

    // Also refresh immediately whenever a Postgres change lands on alerts, for near-instant
    // updates rather than waiting up to 8s for the next poll.
    const channel = supabase
      .channel('inbox-items')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_items' }, () => load())
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  const threads = useMemo(() => buildThreads(alerts), [alerts]);

  // Acknowledge / resolve act on every alert in the thread so nothing is left dangling behind the card.
  const acknowledge = async (t: Thread) => {
    const ids = t.alerts.filter((a) => a.status === 'open').map((a) => a.id);
    if (ids.length) {
      await supabase.from('inbox_items').update({ status: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: staff?.id ?? null }).in('id', ids);
    }
    load();
  };

  const resolve = async (t: Thread) => {
    const ids = t.alerts.map((a) => a.id);
    await supabase.from('inbox_items').update({ status: 'resolved', resolved_at: new Date().toISOString() }).in('id', ids);
    load();
  };

  const remove = async (t: Thread) => {
    const n = t.alerts.length;
    const msg = n > 1
      ? `Permanently remove these ${n} open alerts and their message history? This cannot be undone.`
      : 'Permanently remove this alert and its message history? This cannot be undone.';
    if (!window.confirm(msg)) return;
    // inbox_messages and escalations rows cascade-delete automatically (FK ON DELETE CASCADE).
    await supabase.from('inbox_items').delete().in('id', t.alerts.map((a) => a.id));
    load();
  };

  // Sends the escalation notice text to the person (previously this only LOGGED the text
  // without sending it) and records the hand-off. If the text can't be sent — opted out,
  // bad number — the failure is logged and staff are told to call directly.
  const escalate = async (t: Thread) => {
    const target = t.topAlert;
    const result = await sendSms(target.id, ESCALATION_TEXT);
    await supabase.from('escalations').insert({
      item_id: target.id,
      escalated_to: 'on_call_team',
      escalated_by: staff?.id ?? null,
      outcome: result.ok ? 'hand_off_initiated' : 'hand_off_sms_failed',
      notes: result.ok ? null : result.error ?? null,
    });
    if (!result.ok) {
      window.alert(`The escalation text was NOT sent: ${result.error}\n\nCall the person directly or call 911 if they may be in danger on their behalf.`);
    }
    load();
  };

  if (loading) return <p>Loading triage inbox…</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Triage Inbox</h1>
        <button
          onClick={load}
          style={{ background: 'transparent', border: '1px solid var(--brand-gray-300)', borderRadius: 6, padding: '8px 14px', fontWeight: 600, cursor: 'pointer' }}
        >
          ⟳ Refresh
        </button>
      </div>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        One thread per person, newest message first. Unacknowledged Tier 3 alerts stay pinned at the top.
      </p>
      {threads.length === 0 && <p>No open alerts. 🎉</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {threads.map((t) => {
          const person = t.person;
          const name = person?.full_name && person.full_name !== 'Unknown' ? person.full_name : null;
          const phone = person?.mobile_phone ?? null;
          // Freeform texts have no parsed name, so lead with the phone number instead of
          // "Unknown sender" — that's the one piece of identifying info we always have.
          const primaryLabel = name ?? phone ?? 'Unknown sender';
          const gps = [...t.alerts].reverse().find((a) => a.gps_url)?.gps_url ?? null;
          const isOpen = openThread === t.key;
          const previewText = t.preview?.body ?? t.latest.message_body ?? '';
          return (
          <div key={t.key} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className={`tier-badge tier-${t.tier}`}>Tier {t.tier}</span>
                <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--brand-gray-600)' }}>
                  Last message {new Date(t.lastActivity).toLocaleString()}
                  {t.alerts.length > 1 && ` · ${t.alerts.length} alerts`}
                </span>
                {t.unread && (
                  <span style={{ marginLeft: 10, background: 'var(--accent-orange)', color: 'white', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>● New reply</span>
                )}
              </div>
              <span style={{ fontSize: 12, textTransform: 'uppercase', fontWeight: 700, color: 'var(--brand-gray-600)' }}>{t.status}</span>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{primaryLabel}</span>
              {name && phone && <span style={{ marginLeft: 8, color: 'var(--brand-gray-600)', fontSize: 13 }}>{phone}</span>}
            </div>
            <p style={{ marginTop: 6, marginBottom: gps ? 4 : undefined, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {t.preview?.direction === 'outbound' && <span style={{ color: 'var(--brand-gray-600)', fontWeight: 600 }}>You: </span>}
              {previewText}
            </p>
            {gps && (
              <a href={gps} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-teal)', fontSize: 13, fontWeight: 600 }}>
                📍 View location
              </a>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {t.status === 'open' && (
                <button className="btn-primary" onClick={() => acknowledge(t)}>Acknowledge</button>
              )}
              <button
                onClick={() => setOpenThread(isOpen ? null : t.key)}
                style={{ background: isOpen ? 'var(--brand-teal-light)' : 'transparent', border: '1px solid var(--brand-teal)', color: 'var(--brand-teal)', borderRadius: 6, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
              >
                💬 {isOpen ? 'Hide conversation' : 'Conversation'}
              </button>
              {t.tier === 3 && (
                <button
                  onClick={() => escalate(t)}
                  style={{ background: 'var(--tier-3)', color: 'white', border: 'none', borderRadius: 6, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
                >
                  Send escalation notice
                </button>
              )}
              <button
                onClick={() => resolve(t)}
                style={{ background: 'transparent', border: '1px solid var(--brand-gray-300)', borderRadius: 6, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
              >
                Mark resolved
              </button>
              <button
                onClick={() => remove(t)}
                title="Permanently delete this alert"
                style={{ background: 'transparent', border: '1px solid var(--tier-3)', color: 'var(--tier-3)', borderRadius: 6, padding: '10px 16px', fontWeight: 600, cursor: 'pointer', marginLeft: 'auto' }}
              >
                🗑 Remove
              </button>
            </div>
            {isOpen && (
              <ConversationPanel
                alertId={t.latest.id}
                personId={t.personId}
                tier={t.tier}
                organizationId={t.latest.organization_id}
                personFirstName={name ? name.split(' ')[0] : null}
                phone={phone}
                optedOut={Boolean(person?.sms_opted_out)}
                hadUnread={t.unread}
                onChanged={load}
              />
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
