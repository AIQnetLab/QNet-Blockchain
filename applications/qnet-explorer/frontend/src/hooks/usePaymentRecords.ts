'use client';

// The activations kept in this browser (src/lib/cabinet/payment-store.ts), for the pages that show them without the
// payment key: whether one is unfinished, and the receipt or record behind the chosen wallet's node. Read on load, when
// the page is shown again and when `pulse` changes (a step of the page); null until the first read. The key's module is
// never loaded here.

import { useEffect, useState } from 'react';
import { listRecords } from '@/lib/cabinet/payment-store';
import type { PaymentRecord } from '@/lib/cabinet/flow';

export function usePaymentRecords(pulse = 0): PaymentRecord[] | null {
  const [records, setRecords] = useState<PaymentRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      void listRecords().then((all) => {
        if (live) setRecords(all);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pulse]);
  return records;
}
