// Pure task grouping and due-date helpers. Dates are handled in the device's
// local time zone; a due date without a time is stored as 23:59 local time
// on that day ("by end of day") and displayed without a time.
import type { TaskRow } from './types.js';

export interface TaskSections {
  overdue: TaskRow[];
  today: TaskRow[];
  upcoming: TaskRow[];
  noDate: TaskRow[];
  done: TaskRow[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function groupTasks(tasks: TaskRow[], now: Date = new Date()): TaskSections {
  const endOfToday = startOfDay(now);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const sections: TaskSections = { overdue: [], today: [], upcoming: [], noDate: [], done: [] };
  for (const t of tasks) {
    if (t.status === 'done') {
      sections.done.push(t);
      continue;
    }
    if (!t.due_at) {
      sections.noDate.push(t);
      continue;
    }
    const due = new Date(t.due_at);
    if (due.getTime() < now.getTime()) sections.overdue.push(t);
    else if (due.getTime() < endOfToday.getTime()) sections.today.push(t);
    else sections.upcoming.push(t);
  }
  const byDue = (a: TaskRow, b: TaskRow) => (a.due_at ?? '').localeCompare(b.due_at ?? '') || a.title.localeCompare(b.title);
  sections.overdue.sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  sections.today.sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  sections.upcoming.sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  sections.noDate.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sections.done.sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at) || byDue(a, b));
  return sections;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** yyyy-mm-dd + optional hh:mm (local) -> ISO timestamp, or null when no date. */
export function dueAtFromParts(date: string, time: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!dm) return null;
  const tm = /^(\d{2}):(\d{2})$/.exec(time.trim());
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), tm ? Number(tm[1]) : 23, tm ? Number(tm[2]) : 59, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO timestamp -> local yyyy-mm-dd and hh:mm ('' when the due time is the end-of-day default). */
export function duePartsFromIso(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = isEndOfDay(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time };
}

function isEndOfDay(d: Date): boolean {
  return d.getHours() === 23 && d.getMinutes() === 59;
}

/** Short human label for a due date relative to `now` ("Today 14:30", "Tomorrow", "12 Oct"). */
export function formatDue(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'No date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No date';
  const dayDiff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const time = isEndOfDay(d) ? '' : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let day: string;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Tomorrow';
  else if (dayDiff === -1) day = 'Yesterday';
  else day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${day}${time}`;
}
