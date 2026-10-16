import { supabase } from './supabaseClient';

/** Calls one of our Netlify functions as the signed-in user. Returns the parsed JSON body or throws with the server's message. */
export async function callFunction<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status})`);
  return json as T;
}
