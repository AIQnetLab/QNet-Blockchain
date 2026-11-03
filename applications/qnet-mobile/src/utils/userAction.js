/**
 * What the user waits on has the network first: the hold counter lives in utils/userHold (the extension's bundle compiles
 * it with the light client); this module adds the screens' hook.
 */
import { useEffect } from 'react';
import { holdForUser } from './userHold';

export { USER_HOLD_MAX_MS, afterUserActions, holdForUser } from './userHold';

/** A screen holds the network while `busy` (holdForUser) and lets it go once it is not, or once the screen goes. */
export function useHoldForUser(busy) {
  useEffect(() => (busy ? holdForUser() : undefined), [busy]);
}
