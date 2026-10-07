'use client';

// Whether this browser runs on a phone or tablet (it opens QNet Wallet with a button) and on Android (the button is
// an intent: URL). Null until the page runs in the browser.

import { useEffect, useState } from 'react';
import { isAndroid, isPhoneLike } from '@/lib/qnet-provider';

export function useDeviceKind(): { phone: boolean; android: boolean } | null {
  const [kind, setKind] = useState<{ phone: boolean; android: boolean } | null>(null);
  useEffect(() => {
    setKind({ phone: isPhoneLike(window.navigator), android: isAndroid(window.navigator) });
  }, []);
  return kind;
}
