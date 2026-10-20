// The languages of QNet Wallet, in the app's order and names, each marked with its own language so the system picks
// the right face; an Arabic word reads right to left by its own letters.

import { LANGUAGES } from '@/lib/languages';

export default function LanguageList() {
  return (
    <ul className="langs" aria-label="Languages of QNet Wallet">
      {LANGUAGES.map((l) => <li key={l.code} lang={l.code}>{l.name}</li>)}
    </ul>
  );
}
