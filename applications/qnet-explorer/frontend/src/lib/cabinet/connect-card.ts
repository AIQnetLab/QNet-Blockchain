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
