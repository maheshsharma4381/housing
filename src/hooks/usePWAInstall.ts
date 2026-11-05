import { useEffect, useState, useSyncExternalStore } from 'react';
import { installStore } from '../lib/install-prompt';

const EMPTY = { prompt: null, installed: false } as const;

export function usePWAInstall() {
  const store = installStore();
  const state = useSyncExternalStore(
    (fn) => store?.subscribe(fn) ?? (() => {}),
    () => store?.get() ?? EMPTY,
    () => EMPTY,
  );
  const [standalone, setStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Already running as the installed app
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true,
    );
    setIsIOS(/iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()));
  }, []);

  const install = async () => {
    const prompt = store?.get().prompt;
    if (!prompt) return false;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
      store?.markInstalled();
      return true;
    }
    store?.used();
    return false;
  };

  return {
    isInstallable: !!state.prompt,
    isInstalled: standalone || state.installed,
    isIOS,
    install,
  };
}

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
