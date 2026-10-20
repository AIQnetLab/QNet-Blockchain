// An animation loop that draws at most `fps` frames a second, and only while `active()` holds: the caller calls
// `sync()` whenever that may have changed (the page hidden or shown, the reduced-motion setting) and `stop()` at the end.

export interface FrameClock {
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(id: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface FrameLoop {
  sync(): void;
  stop(): void;
}

// A frame is asked for this long before it is due, and a frame callback that close to its due time draws: the refresh a
// woken request lands on is then always a drawing one, so each drawn frame costs one frame callback on 60 to 240 Hz.
const LEAD_MS = 4;

export function frameLoop(step: () => void, fps: number, active: () => boolean, clock: FrameClock): FrameLoop {
  const interval = 1000 / fps;
  let frame = 0;
  let timer = 0;
  let last: number | null = null;
  // Below the display's rate the page sleeps until the next frame is nearly due, instead of waking on every refresh.
  const wait = (now: number) => {
    const left = last === null ? 0 : last + interval - now;
    if (left <= LEAD_MS) {
      frame = clock.requestAnimationFrame(tick);
      return;
    }
    timer = clock.setTimeout(() => {
      timer = 0;
      frame = clock.requestAnimationFrame(tick);
    }, left - LEAD_MS);
  };
  const tick = (now: number) => {
    frame = 0;
    // One millisecond more for the jitter of frame timestamps.
    const due = last === null || now - last >= interval - LEAD_MS - 1;
    // The next frame is due one interval on, so the rate holds on any display; a loop far behind starts again from now.
    if (due) last = last === null || now - last >= 2 * interval ? now : last + interval;
    // Asked for before the step, so a step that stops the loop also cancels it.
    wait(now);
    if (due) step();
  };
  const stop = () => {
    if (frame !== 0) clock.cancelAnimationFrame(frame);
    if (timer !== 0) clock.clearTimeout(timer);
    frame = 0;
    timer = 0;
    last = null;
  };
  return {
    sync: () => {
      if (!active()) stop();
      else if (frame === 0 && timer === 0) frame = clock.requestAnimationFrame(tick);
    },
    stop,
  };
}
