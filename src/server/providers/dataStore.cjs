// DataStore: the only place a Supabase client is created. Functions call getDb(); tests inject a fake.
let override = null;
let client = null;
function setDbForTests(db) { override = db; client = null; }
function getDb(env = process.env) {
  if (override) return override;
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}
module.exports = { getDb, setDbForTests };
