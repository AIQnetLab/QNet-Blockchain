// Times on this device's clock, in the one form every language shows (digits, never a locale's words): the Node tab,
// the QNet Link sheet, the History and the refusal wording share them.
export const pad = (n) => String(n).padStart(2, '0');

/** A time of day, hours and minutes. */
export const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** A date, year-month-day. */
export const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
