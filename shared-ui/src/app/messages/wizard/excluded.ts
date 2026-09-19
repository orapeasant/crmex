// Formats why selected clients did not make it into a queued job
// (crmex.md §18.3.1, §18.4 step 2). Reported one reason at a time: a user who
// sees a single merged count assumes the wrong reason.
import type { ExcludedClient, ExcludedReason } from '../../../supabase/sendJobs.js';

const REASON_LABEL: Record<ExcludedReason, string> = {
  suppressed: 'opted out',
  inactive: 'inactive',
  no_phone: 'no phone number',
  duplicate: 'a duplicate number',
  not_found: 'no longer in the firm',
};

// Fixed, meaningful order rather than insertion order.
const REASON_ORDER: ExcludedReason[] = ['suppressed', 'inactive', 'no_phone', 'duplicate', 'not_found'];

/** One phrase per reason present, e.g. ["3 opted out", "12 inactive"] — never merged into a single count. */
export function summarizeExcluded(excluded: readonly ExcludedClient[]): string[] {
  const counts = new Map<ExcludedReason, number>();
  for (const e of excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  return REASON_ORDER.filter((r) => counts.has(r)).map((r) => `${counts.get(r)} ${REASON_LABEL[r]}`);
}
