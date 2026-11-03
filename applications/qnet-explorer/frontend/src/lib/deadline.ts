// A wait with an end, the one the site uses on its server and in its pages: `work`'s value, or `fallback` (null when none
// is given) once `ms` has passed first; an answer that comes later is dropped. The timer never outlives the wait.
export function within<T>(ms: number, work: Promise<T>): Promise<T | null>;
export function within<T, F>(ms: number, work: Promise<T>, fallback: F): Promise<T | F>;
export async function within<T, F>(ms: number, work: Promise<T>, fallback: F | null = null): Promise<T | F | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F | null>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
