// A log line for an event that can come with every request, written at most once per `windowMs`: each call counts one
// event and gives the count since the line before once the window has passed (the first event at once), else null.
export function logWindow(windowMs: number): (now?: number) => number | null {
  let count = 0;
  let lineAt = Number.NEGATIVE_INFINITY;
  return (now = Date.now()) => {
    count += 1;
    if (now - lineAt < windowMs) return null;
    const events = count;
    count = 0;
    lineAt = now;
    return events;
  };
}
