import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * The browser says it is online. The server render always counts as online: Node 21+ has a global
 * `navigator` without `onLine`, and a page built there used to carry the offline banner in its HTML.
 */
export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, () => navigator.onLine !== false, () => true);
}
