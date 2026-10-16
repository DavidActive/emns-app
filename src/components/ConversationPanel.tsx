import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { sendSms } from '../lib/sendSms';

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  created_at: string;
  delivery_status: string | null;
  error_code: string | null;
}

interface Template {
  id: string;
  name: string;
  message: string;
  tier: number | null;
}

interface Props {
  alertId: string;            // newest alert for this person: replies are attached to it
  personId: string | null;    // when set, the thread shows the person's messages across ALL their alerts
  tier: 1 | 2 | 3;
  organizationId: string;
  personFirstName: string | null;
  phone: string | null;
  optedOut: boolean;
  hadUnread: boolean;
  onChanged: () => void;
}

const MAX_LEN = 1600;

// Rough SMS segment estimate (GSM-7: 160 / 153 per part; anything non-ASCII forces UCS-2: 70 / 67).
function segments(text: string): number {
  if (!text) return 0;
  const unicode = /[^\x00-\x7F]/.test(text);
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function statusChip(m: Message): { label: string; color: string } | null {
  if (m.direction !== 'outbound') return null;
  switch (m.delivery_status) {
    case 'delivered': return { label: 'Delivered ✓', color: 'var(--tier-1)' };
    case 'sent': return { label: 'Sent', color: 'var(--brand-gray-600)' };
    case 'queued':
    case 'sending': return { label: 'Sending…', color: 'var(--brand-gray-600)' };
    case 'undelivered':
    case 'failed': return { label: `Not delivered${m.error_code ? ` (code ${m.error_code})` : ''}`, color: 'var(--tier-3)' };
    default: return null; // legacy rows logged before delivery tracking existed
  }
}

export default function ConversationPanel({
  alertId, personId, tier, organizationId, personFirstName, phone, optedOut, hadUnread, onChanged,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async () => {
    // One continuous thread per person: pull messages from every alert they have ever had
    // (including resolved ones), so a new alert never starts a "blank" conversation.
    const base = supabase
      .from('inbox_messages')
      .select(personId
        ? 'id, direction, body, created_at, delivery_status, error_code, inbox_items!inner ( person_id )'
        : 'id, direction, body, created_at, delivery_status, error_code');
    const { data } = await (personId
      ? base.eq('inbox_items.person_id', personId)
      : base.eq('item_id', alertId)
    ).order('created_at', { ascending: true });
    setMessages((data as unknown as Message[]) ?? []);
  }, [alertId, personId]);

  // Load thread + live updates (new replies, delivery-status changes).
  useEffect(() => {
    loadMessages();
    const channel = supabase
      .channel(`thread-${personId ?? alertId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_messages' }, () => {
        loadMessages();
      })
      .subscribe();
    // Polling fallback in case realtime isn't delivering for this table.
    const poll = setInterval(loadMessages, 10000);
    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [alertId, personId, loadMessages]);

  // Opening the thread counts as reading it.
  useEffect(() => {
    if (!hadUnread) return;
    const q = supabase.from('inbox_items').update({ unread_reply: false });
    (personId ? q.eq('person_id', personId) : q.eq('id', alertId)).then(() => onChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertId, personId]);

  // Pre-approved replies for this org (and org-agnostic ones), matching this alert's tier or any tier.
  useEffect(() => {
    supabase
      .from('message_templates')
      .select('id, name, message, tier')
      .or(`organization_id.eq.${organizationId},organization_id.is.null`)
      .order('name')
      .then(({ data }) => {
        const all = (data as Template[]) ?? [];
        setTemplates(all.filter((t) => t.tier === null || t.tier === tier));
      });
  }, [organizationId, tier]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) { setTemplateId(null); return; }
    setTemplateId(t.id);
    setDraft(t.message.replace(/\{first_name\}/gi, personFirstName ?? 'there'));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const result = await sendSms(alertId, text, templateId);
    setSending(false);
    if (!result.ok) {
      setError(result.error ?? 'The text could not be sent.');
      loadMessages(); // a failed attempt is still recorded in the thread
      onChanged();
      return;
    }
    setDraft('');
    setTemplateId(null);
    loadMessages();
    onChanged();
  };

  const canSend = !optedOut && !!phone && !sending && draft.trim().length > 0 && draft.length <= MAX_LEN;

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--brand-gray-300)', paddingTop: 12 }}>
      {tier === 3 && (
        <div style={{ background: '#fdecea', border: '1px solid var(--tier-3)', borderRadius: 6, padding: '8px 12px', fontSize: 13, marginBottom: 10 }}>
          <strong>Tier 3 — critical.</strong> Follow your organization's escalation procedure and call 911 for any immediate danger; don't be the only person on this thread.
        </div>
      )}

      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 2px' }}>
        {messages.length === 0 && <p style={{ color: 'var(--brand-gray-600)', fontSize: 13 }}>No messages yet.</p>}
        {messages.map((m, i) => {
          const out = m.direction === 'outbound';
          const chip = statusChip(m);
          const day = new Date(m.created_at).toLocaleDateString();
          const newDay = i === 0 || day !== new Date(messages[i - 1].created_at).toLocaleDateString();
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {newDay && (
                <div style={{ alignSelf: 'center', fontSize: 11, color: 'var(--brand-gray-600)', margin: '6px 0 2px' }}>{day}</div>
              )}
            <div style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
              <div
                style={{
                  background: out ? 'var(--brand-navy)' : 'var(--brand-gray-100)',
                  color: out ? 'var(--brand-white)' : 'var(--brand-text)',
                  borderRadius: 12,
                  padding: '8px 12px',
                  fontSize: 14,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.body}
              </div>
              <div style={{ fontSize: 11, color: 'var(--brand-gray-600)', marginTop: 2, textAlign: out ? 'right' : 'left' }}>
                {out ? 'Staff' : 'Them'} · {new Date(m.created_at).toLocaleString()}
                {chip && <span style={{ marginLeft: 8, color: chip.color, fontWeight: 600 }}>{chip.label}</span>}
              </div>
            </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {optedOut ? (
        <p style={{ marginTop: 10, background: 'var(--tier-2)', color: 'white', borderRadius: 6, padding: '8px 12px', fontSize: 13 }}>
          This person replied STOP, so texting is turned off.{phone ? <> Call them at <strong>{phone}</strong> instead; texting resumes if they text START.</> : null}
        </p>
      ) : !phone ? (
        <p style={{ marginTop: 10, color: 'var(--brand-gray-600)', fontSize: 13 }}>No phone number on file, so this person can't be texted.</p>
      ) : (
        <div style={{ marginTop: 10 }}>
          {templates.length > 0 && (
            <select
              value={templateId ?? ''}
              onChange={(e) => applyTemplate(e.target.value)}
              style={{ padding: 6, borderRadius: 6, border: '1px solid var(--brand-gray-300)', marginBottom: 6, maxWidth: '100%' }}
            >
              <option value="">Insert an approved reply…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (!e.target.value) setTemplateId(null); }}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSend) send(); }}
            placeholder={`Text ${personFirstName ?? 'this person'}…`}
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span style={{ fontSize: 12, color: draft.length > MAX_LEN ? 'var(--tier-3)' : 'var(--brand-gray-600)' }}>
              {draft.length}/{MAX_LEN} · {segments(draft)} text{segments(draft) === 1 ? '' : 's'} · Ctrl+Enter to send
            </span>
            <button className="btn-primary" disabled={!canSend} onClick={send} style={{ opacity: canSend ? 1 : 0.5 }}>
              {sending ? 'Sending…' : 'Send text'}
            </button>
          </div>
        </div>
      )}
      {error && <p style={{ color: 'var(--tier-3)', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
