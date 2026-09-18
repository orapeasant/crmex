import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseLike } from '../db/types';
import { createImageSessionsRepo } from '../repositories/imageSessionsRepo';
import { createMessageHistoryRepo } from '../repositories/messageHistoryRepo';
import { createStorageRepo } from '../repositories/storageRepo';
import { createSettingsRepo } from '../repositories/settingsRepo';
import { runRetention } from './retention';

/**
 * Thin CLI entrypoint: `npm run retention -- --dry-run`.
 * Intended to be invoked by an external scheduler (cron, Supabase scheduled
 * function, etc.) — this repo does not itself run a scheduler.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. See core-server/.env.example.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as SupabaseLike;
  const deps = {
    imageSessionsRepo: createImageSessionsRepo(supabase),
    messageHistoryRepo: createMessageHistoryRepo(supabase),
    storageRepo: createStorageRepo(supabase),
    settingsRepo: createSettingsRepo(supabase),
    now: Date.now,
  };

  const result = await runRetention(deps, { dryRun });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
