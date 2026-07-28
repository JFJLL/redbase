import { onScopeDispose } from "vue";

type ScopeListener = () => void;

const logoutListeners = new Set<ScopeListener>();

/** Broadcast used by the auth store: aborts every live request scope when the
 *  user logs out or switches accounts. */
export function notifyAuthReset(): void {
  for (const listener of [...logoutListeners]) {
    listener();
  }
}

/** Module-level auth-reset subscription (legacy sessionEpoch bump equivalent)
 *  for state that lives outside a component scope, e.g. the per-idea creative
 *  settings memory store. Returns an unsubscribe function. */
export function onAuthReset(listener: ScopeListener): () => void {
  logoutListeners.add(listener);
  return () => {
    logoutListeners.delete(listener);
  };
}

export interface AbortScope {
  /** Fresh signal for one logical request; aborts previous signal from the
   *  same key so stale responses can never overwrite newer state. */
  signalFor(key: string): AbortSignal;
  /** Abort everything tracked by this scope. */
  abortAll(): void;
}

/** Per-view abort scope. Automatically aborts all in-flight requests when the
 *  component unmounts (route leave) and when the auth session resets. */
export function useAbortScope(): AbortScope {
  const controllers = new Map<string, AbortController>();

  const abortAll = () => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
    controllers.clear();
  };

  logoutListeners.add(abortAll);
  onScopeDispose(() => {
    logoutListeners.delete(abortAll);
    abortAll();
  });

  return {
    signalFor(key: string): AbortSignal {
      controllers.get(key)?.abort();
      const controller = new AbortController();
      controllers.set(key, controller);
      return controller.signal;
    },
    abortAll,
  };
}
