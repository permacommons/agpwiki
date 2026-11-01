import { AsyncLocalStorage } from 'node:async_hooks';

// Values worked out once per web request. Outside a request (tests, scripts)
// there is no scope and nothing is remembered, so callers always get fresh
// results there.
const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export const runInRequestScope = <T>(callback: () => T): T => scope.run(new Map(), callback);

export const memoizeInRequest = <T>(key: string, compute: () => Promise<T>): Promise<T> => {
  const memo = scope.getStore();
  if (!memo) return compute();
  const existing = memo.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = compute();
  memo.set(key, pending);
  return pending;
};

export const forgetInRequest = (key: string) => {
  scope.getStore()?.delete(key);
};
