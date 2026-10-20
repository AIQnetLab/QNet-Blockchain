// A wait with an end, for a page's first answer (src/server/first-answer.ts): `work`'s value, or null once `ms` has
// passed first; an answer that comes later is dropped. The timer never outlives the wait.
export async function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
