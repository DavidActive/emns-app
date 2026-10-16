// Minimal fake of the supabase-js query builder. Every chain method returns the builder;
// terminal reads (maybeSingle/single/await) resolve from `tables[table]`.
// Writes are recorded in `calls` so tests can assert on them.
function createFakeDb({ tables = {}, user = null } = {}) {
  const calls = [];
  function builder(table) {
    const state = { table, op: 'select', payload: null, filters: [] };
    const result = () => {
      calls.push({ table, op: state.op, payload: state.payload, filters: state.filters.slice() });
      if (state.op !== 'select') return { data: state.op === 'insert' ? { id: 'new-row-id' } : null, error: null };
      const row = tables[table];
      return { data: row === undefined ? null : row, error: null };
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(result()).then(res, rej);
        if (prop === 'maybeSingle' || prop === 'single') return async () => result();
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return (payload) => { state.op = prop; state.payload = payload; return b; };
        }
        if (prop === 'eq' || prop === 'in') return (c, v) => { state.filters.push([c, v]); return b; };
        return () => b; // select, order, limit, etc.
      },
    });
    return b;
  }
  return {
    calls,
    from: (t) => builder(t),
    auth: { getUser: async () => (user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } }) },
  };
}
module.exports = { createFakeDb };
