import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBackButton } from '../ui/util.js';

export type TabId = 'clients' | 'matters' | 'tasks' | 'messages';

export type Route =
  | { name: 'clients' }
  | { name: 'client'; id: string }
  | { name: 'client-form'; id?: string }
  | { name: 'client-import' }
  | { name: 'matters' }
  | { name: 'matter'; id: string }
  | { name: 'matter-form'; id?: string }
  | { name: 'tasks' }
  | { name: 'task-form'; id?: string; matterId?: string }
  | { name: 'messages' }
  | { name: 'batch'; batchId: string };

export interface Nav {
  push: (route: Route) => void;
  pop: () => void;
  /** Replace the top route (e.g. a create form becomes the new record's detail). */
  replace: (route: Route) => void;
  depth: number;
}

const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const v = useContext(NavContext);
  if (!v) throw new Error('useNav outside TabStack');
  return v;
}

/**
 * One navigation stack per bottom-nav tab. Lower routes stay mounted (hidden)
 * so a list keeps its filters and scroll position under a detail screen.
 */
export function TabStack({ root, active, onDepthChange, render }: { root: Route; active: boolean; onDepthChange: (depth: number) => void; render: (route: Route) => ReactNode }) {
  const [stack, setStack] = useState<{ key: number; route: Route; scrollY: number }[]>([{ key: 0, route: root, scrollY: 0 }]);
  const keySeq = useRef(1);

  useEffect(() => onDepthChange(stack.length), [stack.length, onDepthChange]);

  const push = useCallback((route: Route) => {
    const y = window.scrollY;
    setStack((s) => [...s.slice(0, -1), { ...s[s.length - 1], scrollY: y }, { key: keySeq.current++, route, scrollY: 0 }]);
    window.scrollTo({ top: 0 });
  }, []);

  const pop = useCallback(() => {
    setStack((s) => {
      if (s.length <= 1) return s;
      const next = s.slice(0, -1);
      const y = next[next.length - 1].scrollY;
      requestAnimationFrame(() => window.scrollTo({ top: y }));
      return next;
    });
  }, []);

  const replace = useCallback((route: Route) => {
    setStack((s) => [...s.slice(0, -1), { key: keySeq.current++, route, scrollY: 0 }]);
    window.scrollTo({ top: 0 });
  }, []);

  useBackButton(() => {
    if (!active || stack.length <= 1) return false;
    pop();
    return true;
  });

  const nav = useMemo<Nav>(() => ({ push, pop, replace, depth: stack.length }), [push, pop, replace, stack.length]);

  return (
    <NavContext.Provider value={nav}>
      {stack.map((entry, idx) => (
        <div key={entry.key} hidden={idx !== stack.length - 1}>
          {render(entry.route)}
        </div>
      ))}
    </NavContext.Provider>
  );
}
