/**
 * The arming of a confirmation button that approves a signature, a send or a burn (browser/DappSheet,
 * screens/QNetLinkScreen): a stray tap must never become an approval.
 *  - The button arms only after the sheet has been on screen, untouched, for `delayMs`: every touch on the sheet
 *    while it is not armed yet starts the delay again, so a page that keeps the user tapping at a spot never arms it.
 *  - A press counts only if the finger went down after the button armed: a touch already under way when it armed
 *    does nothing.
 *  - Leaving the app disarms it; coming back starts the delay again.
 *  - What it confirms changing (a choice on the sheet) starts the delay again (`restart`).
 * Returns { armed, onTouchStart (for the sheet's root view), onPressIn (for the button), pressCounts(), restart }.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export function useArmedConfirm(active, delayMs) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  const armedAt = useRef(0);
  const pressedAt = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    armedAt.current = 0;
    setArmed(false);
  }, []);

  const restart = useCallback(() => {
    disarm();
    if (!activeRef.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      armedAt.current = Date.now();
      setArmed(true);
    }, delayMs);
  }, [delayMs, disarm]);

  useEffect(() => {
    if (active) restart();
    else disarm();
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [active, restart, disarm]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') { if (activeRef.current) restart(); } else disarm();
    });
    return () => { if (sub && typeof sub.remove === 'function') sub.remove(); };
  }, [restart, disarm]);

  const onTouchStart = useCallback(() => {
    if (activeRef.current && armedAt.current === 0) restart();
  }, [restart]);

  const onPressIn = useCallback(() => { pressedAt.current = Date.now(); }, []);

  const pressCounts = useCallback(() => armedAt.current > 0 && pressedAt.current >= armedAt.current, []);

  return { armed, onTouchStart, onPressIn, pressCounts, restart };
}
