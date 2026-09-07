// Two-tier log line: [LEVEL][SUBSYSTEM] event k=v k=v. Level gate via INDEXER_LOG_LEVEL (err|warn|info).
type Level = 'ERR' | 'WARN' | 'INFO';
const ORDER: Record<Level, number> = { ERR: 0, WARN: 1, INFO: 2 };
const configured = (process.env.INDEXER_LOG_LEVEL || 'info').toUpperCase();
const threshold = ORDER[(configured === 'ERROR' ? 'ERR' : configured) as Level] ?? ORDER.INFO;

export type Fields = Record<string, string | number | boolean | null | undefined>;

function line(level: Level, subsystem: string, event: string, fields?: Fields): string {
  let s = `[${level}][${subsystem}] ${event}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const text = typeof v === 'string' && /[\s"]/.test(v) ? JSON.stringify(v) : String(v);
      s += ` ${k}=${text}`;
    }
  }
  return s;
}

export const log = {
  err(subsystem: string, event: string, fields?: Fields): void {
    console.error(line('ERR', subsystem, event, fields));
  },
  warn(subsystem: string, event: string, fields?: Fields): void {
    if (threshold >= ORDER.WARN) console.warn(line('WARN', subsystem, event, fields));
  },
  info(subsystem: string, event: string, fields?: Fields): void {
    if (threshold >= ORDER.INFO) console.log(line('INFO', subsystem, event, fields));
  },
};

// Error text without a stack, for a k=v field.
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n')[0].slice(0, 300);
  return String(e).slice(0, 300);
}
