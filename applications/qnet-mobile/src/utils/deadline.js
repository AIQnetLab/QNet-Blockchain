// The app's one time limit on a value: `promise`'s value, or `fallback` once the clock passes `deadline` (ms since the
// epoch) first; the promise runs on and its timer goes as soon as either settles. No deadline (null) sets no limit.
export function valueBy(promise, deadline, fallback) {
  if (deadline == null) return Promise.resolve(promise);
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
