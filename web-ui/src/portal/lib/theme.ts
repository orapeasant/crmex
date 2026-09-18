// Light / dark / system theme. A per-viewer convenience kept in localStorage.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'crmex:theme';
const listeners = new Set<() => void>();

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

function resolved(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice: ThemeChoice = getThemeChoice()) {
  document.documentElement.classList.toggle('dark', resolved(choice) === 'dark');
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable */
  }
  applyTheme(choice);
  listeners.forEach((l) => l());
}

/** Current choice and the theme actually shown; follows OS changes while "system" is chosen. */
export function useTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void } {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = () => setChoice(getThemeChoice());
    listeners.add(onChange);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onOs = () => {
      if (getThemeChoice() === 'system') {
        applyTheme('system');
        force((n) => n + 1);
      }
    };
    mq?.addEventListener('change', onOs);
    return () => {
      listeners.delete(onChange);
      mq?.removeEventListener('change', onOs);
    };
  }, []);
  return { choice, resolved: resolved(choice), setChoice: setThemeChoice };
}
