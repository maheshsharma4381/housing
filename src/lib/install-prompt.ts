// Android/Chrome fires beforeinstallprompt once per page load — usually on /login or while the dashboard loads,
// before any "Install app" button exists. This store catches it at app start (ServiceWorkerRegister, root layout)
// and keeps it until a button uses it.

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
export interface InstallState { prompt: InstallPromptEvent | null; installed: boolean }

export function createInstallStore(target: EventTarget) {
  let state: InstallState = { prompt: null, installed: false };
  const listeners = new Set<() => void>();
  const set = (next: InstallState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // our own button asks, at a better moment than the browser's mini-bar
    set({ ...state, prompt: e as InstallPromptEvent });
  });
  target.addEventListener('appinstalled', () => set({ prompt: null, installed: true }));
  return {
    get: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    used: () => set({ ...state, prompt: null }),
    markInstalled: () => set({ prompt: null, installed: true }),
  };
}

let shared: ReturnType<typeof createInstallStore> | null = null;
/** The one store for this browser tab, created on first use (call it as early as possible). */
export function installStore() {
  if (!shared && typeof window !== 'undefined') shared = createInstallStore(window);
  return shared;
}
