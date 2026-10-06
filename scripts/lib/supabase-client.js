// Supabase clients for pipeline and check scripts. Never deployed: the service
// client uses SUPABASE_SERVICE_ROLE_KEY (a secret sb_secret_ key) and bypasses RLS.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getServiceClient() {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), CLIENT_OPTIONS);
}

// Public (publishable) key, subject to RLS: used by checks to confirm what the frontend can and can't do.
function getAnonClient() {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), CLIENT_OPTIONS);
}

// supabase-js returns { data, error }; turn errors into exceptions.
function unwrap({ data, error }, context) {
  if (error) throw new Error(`${context}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  return data;
}

const PAGE_SIZE = 1000;

// Reads every row of an ordered query, a page at a time, until a page comes back empty, so a
// lower max-rows setting on the project can't silently truncate the result.
async function readAll(buildQuery, context) {
  const rows = [];
  for (;;) {
    const page = unwrap(await buildQuery().range(rows.length, rows.length + PAGE_SIZE - 1), context);
    if (page.length === 0) return rows;
    rows.push(...page);
  }
}

module.exports = { getServiceClient, getAnonClient, unwrap, readAll };
