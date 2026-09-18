import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './util.js';

export interface AsyncState<T> {
  status: 'loading' | 'ready' | 'error';
  data: T | undefined;
  error: string | null;
  /** True while a reload runs with previous data still shown. */
  refreshing: boolean;
  reload: () => void;
  setData: (update: (prev: T | undefined) => T) => void;
}

/** Runs `fn` when deps change; keeps the previous data visible during reloads. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ status: AsyncState<T>['status']; data: T | undefined; error: string | null; refreshing: boolean }>({
    status: 'loading',
    data: undefined,
    error: null,
    refreshing: false,
  });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setState((s) => (s.data === undefined ? { status: 'loading', data: undefined, error: null, refreshing: false } : { ...s, refreshing: true }));
    fnRef
      .current()
      .then((data) => !cancelled && setState({ status: 'ready', data, error: null, refreshing: false }))
      .catch((err) => !cancelled && setState({ status: 'error', data: undefined, error: describeError(err), refreshing: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((update: (prev: T | undefined) => T) => setState((s) => ({ ...s, status: 'ready', data: update(s.data) })), []);
  return { ...state, reload, setData };
}
