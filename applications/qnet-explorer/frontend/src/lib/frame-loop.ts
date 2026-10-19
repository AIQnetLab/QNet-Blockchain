// An animation loop that draws at most `fps` frames a second, and only while `active()` holds: the caller calls
// `sync()` whenever that may have changed (the page hidden or shown, the reduced-motion setting) and `stop()` at the end.

export interface FrameClock {
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(id: number): void;
}

export interface FrameLoop {
  sync(): void;
  stop(): void;
}

export function frameLoop(step: () => void, fps: number, active: () => boolean, clock: FrameClock): FrameLoop {
  const interval = 1000 / fps;
  let id = 0;
  let last: number | null = null;
  const tick = (now: number) => {
    id = clock.requestAnimationFrame(tick);
    if (last !== null && now - last < interval - 1) return;
    // The next frame is due one interval on, so the rate holds on any display; a loop far behind starts again from now.
    last = last === null || now - last >= 2 * interval ? now : last + interval;
    step();
  };
  const stop = () => {
    if (id !== 0) clock.cancelAnimationFrame(id);
    id = 0;
    last = null;
  };
  return {
    sync: () => {
      if (!active()) stop();
      else if (id === 0) id = clock.requestAnimationFrame(tick);
    },
    stop,
  };
}
