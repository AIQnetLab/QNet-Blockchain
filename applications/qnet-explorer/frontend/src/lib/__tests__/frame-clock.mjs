// A display for frame loops under test (src/lib/frame-loop.ts): it calls the queued frame callbacks at `hz`, as a
// browser does, with a little jitter on each frame's time; a timer fires at the first refresh at or after its due time,
// before that refresh's frame callbacks. `frames` counts the frame callbacks it made.

export function fakeClock() {
  let next = 1;
  let now = 0;
  const queued = new Map();
  const timers = new Map();
  const clock = {
    queued,
    timers,
    frames: 0,
    requestAnimationFrame: (cb) => { queued.set(next, cb); return next++; },
    cancelAnimationFrame: (id) => { queued.delete(id); },
    setTimeout: (cb, ms) => { timers.set(next, { cb, at: now + ms }); return next++; },
    clearTimeout: (id) => { timers.delete(id); },
    // Runs the display at `hz` for `ms` from `from`.
    run(hz, ms, from = 0) {
      for (let t = from; t <= from + ms; t += 1000 / hz) {
        now = t;
        for (const [id, timer] of [...timers]) {
          if (timer.at > t) continue;
          timers.delete(id);
          timer.cb();
        }
        const due = [...queued.values()];
        queued.clear();
        for (const cb of due) {
          clock.frames++;
          const at = t + (Math.random() - 0.5) * 0.4;
          now = at;
          cb(at);
        }
      }
    },
  };
  return clock;
}
