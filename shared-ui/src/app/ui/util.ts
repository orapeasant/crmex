import { useEffect, useRef } from 'react';
import { describeDataError } from '../../crm/errors.js';

// Supabase errors are plain objects, which String() renders as "[object Object]".
export function describeError(err: unknown): string {
  return describeDataError(err);
}

// Hardware back (Android): the highest-priority, most recently mounted
// handler that returns true wins. Overlays (sheets, dialogs) register with a
// higher priority than screens so they close first. The platform shell wires
// the actual button through PlatformServices.backButton (see CrmexApp).
const backHandlers: Array<{ ref: { current: () => boolean }; priority: number; seq: number }> = [];
let seq = 0;

export const BACK_PRIORITY = { fallback: -10, screen: 0, page: 5, overlay: 10 } as const;

export function dispatchBack(): boolean {
  const ordered = [...backHandlers].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  for (const h of ordered) if (h.ref.current()) return true;
  return false;
}

export function useBackButton(handler: () => boolean, priority: number = BACK_PRIORITY.screen): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const entry = { ref, priority, seq: ++seq };
    backHandlers.push(entry);
    return () => {
      const idx = backHandlers.indexOf(entry);
      if (idx >= 0) backHandlers.splice(idx, 1);
    };
  }, [priority]);
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!iso) return '—';
  // Plain dates (yyyy-mm-dd) are calendar days, not instants: parse them as local dates.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, opts);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

export function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
