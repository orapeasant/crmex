// Pure helpers for the schedule-and-pace step (crmex.md §18.4 step 5). Kept
// framework-free and deterministic so the arithmetic shown to the user before
// they confirm a campaign can be unit tested exactly.
import { campaignWindow, estimatedDurationMs, DEFAULT_CAMPAIGN_INTERVAL_MS, DEFAULT_JITTER_PCT, type PacingWindow } from '../../../pacing/pacing.js';

/** §18.2 C5: a late window, default 6h, offered as presets plus the default. */
export const LATE_WINDOW_PRESETS_MS = [1, 3, 6, 12, 24].map((h) => h * 3_600_000);
export const DEFAULT_LATE_WINDOW_MS = 6 * 3_600_000;

export type SendTiming = { mode: 'now' } | { mode: 'scheduled'; at: string };

export interface CampaignPlan {
  timing: SendTiming;
  /** Base gap between consecutive sends (§18.2 C3). Jitter is fixed at DEFAULT_JITTER_PCT — not a user control. */
  intervalMs: number;
  jitterPct: number;
  /** How long past the start the job may still be claimed before it expires (§18.2 C5), relative to the start time. */
  expiresInMs: number;
}

export function defaultCampaignPlan(): CampaignPlan {
  return { timing: { mode: 'now' }, intervalMs: DEFAULT_CAMPAIGN_INTERVAL_MS, jitterPct: DEFAULT_JITTER_PCT, expiresInMs: DEFAULT_LATE_WINDOW_MS };
}

/** The wall-clock instant the run may start: now, or the picked date and time. */
export function startDate(plan: CampaignPlan, now: Date = new Date()): Date {
  return plan.timing.mode === 'now' ? now : new Date(plan.timing.at);
}

/** send_jobs.scheduled_at — null means "run as soon as the phone sees it" (§18.3.2, pre-§18 behaviour). */
export function scheduledAtIso(plan: CampaignPlan): string | null {
  return plan.timing.mode === 'now' ? null : new Date(plan.timing.at).toISOString();
}

/** send_jobs.expires_at — the late window measured from the start time (§18.3.2). */
export function expiresAtIso(plan: CampaignPlan, now: Date = new Date()): string {
  return new Date(startDate(plan, now).getTime() + plan.expiresInMs).toISOString();
}

export function planWindow(plan: CampaignPlan): PacingWindow {
  return campaignWindow(plan.intervalMs, plan.jitterPct);
}

/** An interval a user could plausibly type into "custom". The DB floor (app_settings) is enforced server-side regardless. */
export function isValidIntervalMs(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= 3_600_000;
}

/** Estimated finish instant for N recipients, starting at the plan's start time (§18.4 step 5). */
export function finishDate(plan: CampaignPlan, recipientCount: number, now: Date = new Date()): Date {
  const duration = estimatedDurationMs(recipientCount, planWindow(plan));
  return new Date(startDate(plan, now).getTime() + duration);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local wall-clock time, rounded to the nearest minute (the spec's own example rounds :30 up). */
function roundToMinute(d: Date): Date {
  return new Date(Math.round(d.getTime() / 60_000) * 60_000);
}

function formatClock(d: Date): string {
  const r = roundToMinute(d);
  return `${pad2(r.getHours())}:${pad2(r.getMinutes())}`;
}

function formatDayAndTime(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${formatClock(d)}`;
}

/**
 * The exact shape the spec requires (crmex.md §18.4 step 5), shown before the
 * user can confirm — the arithmetic is not something a user computes themselves:
 *
 *   412 recipients · every 30 s (±25 %) · starts Fri 19 Sep 09:00 · finishes ≈ 12:26
 */
export function formatScheduleSummary(plan: CampaignPlan, recipientCount: number, now: Date = new Date()): string {
  const seconds = Math.round(plan.intervalMs / 1000);
  const startLabel = plan.timing.mode === 'now' ? 'now' : formatDayAndTime(startDate(plan, now));
  const finishLabel = formatClock(finishDate(plan, recipientCount, now));
  return `${recipientCount} recipient${recipientCount === 1 ? '' : 's'} · every ${seconds} s (±${plan.jitterPct} %) · starts ${startLabel} · finishes ≈ ${finishLabel}`;
}

// ---------------------------------------------------------------------------
// Describing an already-queued job's schedule (campaign list / batch detail)
// ---------------------------------------------------------------------------

export interface JobScheduleInfo {
  scheduled_at: string | null;
  interval_ms: number | null;
  jitter_pct: number;
  expires_at: string | null;
}

/** A "campaign" is a job with any of the three §18.3.2 columns set; a plain immediate send has all three null. */
export function isCampaignJob(job: JobScheduleInfo): boolean {
  return job.scheduled_at !== null || job.interval_ms !== null || job.expires_at !== null;
}

/** One line describing when a campaign starts, how fast it paces, and when it goes stale — for the campaign list and batch detail. */
export function formatJobSchedule(job: JobScheduleInfo): string | null {
  if (!isCampaignJob(job)) return null;
  const parts: string[] = [];
  parts.push(job.scheduled_at ? `starts ${formatDayAndTime(new Date(job.scheduled_at))}` : 'starts as soon as claimed');
  if (job.interval_ms !== null) parts.push(`every ${Math.round(job.interval_ms / 1000)} s (±${job.jitter_pct} %)`);
  if (job.expires_at) parts.push(`expires ${formatDayAndTime(new Date(job.expires_at))} if unclaimed`);
  return parts.join(' · ');
}
