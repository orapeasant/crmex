import type { User } from '@supabase/supabase-js';

export interface UserProfile {
  fullName: string;
  email: string;
  initials: string;
}

/** First letter of the first name + first letter of the last name ("Alex Zhang" -> "AZ"). */
export function initialsFor(name: string, fallback = ''): string {
  // Ignore leading punctuation so "Rajah & Co (counsel)" gives "RC", not "R(".
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (words.length === 0) return (fallback.trim()[0] ?? '?').toUpperCase();
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function profileFromUser(user: User): UserProfile {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const given = str(meta.given_name);
  const family = str(meta.family_name);
  const fullName = str(meta.full_name) || str(meta.name) || [given, family].filter(Boolean).join(' ');
  const email = user.email ?? '';
  const initials = given && family ? initialsFor(`${given} ${family}`) : initialsFor(fullName, email);
  return { fullName: fullName || email, email, initials };
}

export function Avatar({ initials, size = 36, variant = 'user' }: { initials: string; size?: number; variant?: 'user' | 'contact' }) {
  return (
    <span
      className={variant === 'contact' ? 'avatar avatar--contact' : 'avatar'}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
