// My node's connect card (#connect) brought into view: scrolled to, focused and marked for a moment, so a tap on the
// header's Connect wallet shows where to go on. Browser code, shared by the header and the connect screen.

export const FLASH_CLASS = 'cabinet-flash';
const FLASH_MS = 1_600;
const timers = new WeakMap<HTMLElement, number>();

export function showConnectCard(card: HTMLElement, smooth: boolean): void {
  card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  card.focus({ preventScroll: true });
  // Taken off and put back, so a second tap marks it again.
  card.classList.remove(FLASH_CLASS);
  void card.offsetWidth;
  card.classList.add(FLASH_CLASS);
  window.clearTimeout(timers.get(card));
  timers.set(card, window.setTimeout(() => card.classList.remove(FLASH_CLASS), FLASH_MS));
}

// Connect wallet on a phone or tablet, from the header or the connect card: QNet Wallet's `connect` request belongs to
// the connect card (its session and its answer), which starts it now if it is shown, else once it shows. Kept in this
// page's memory only, so a reload never starts a request by itself.
export const APP_CONNECT_EVENT = 'qnet-app-connect';
let appConnectAsked = false;

export function askAppConnect(target: EventTarget = window): void {
  appConnectAsked = true;
  target.dispatchEvent(new Event(APP_CONNECT_EVENT));
}

// True once per ask: the card that takes it starts the request.
export function takeAppConnect(): boolean {
  const asked = appConnectAsked;
  appConnectAsked = false;
  return asked;
}
