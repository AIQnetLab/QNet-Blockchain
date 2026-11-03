// The app's one time limit on a value (utils/deadline valueBy), which the modules that wait on a slow read take in
// place of a race of their own.
import fs from 'fs';
import path from 'path';
import { valueBy } from '../src/utils/deadline';

describe('valueBy', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const settled = async (p) => {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it('the value when it comes first, and its timer goes with it', async () => {
    await expect(valueBy(Promise.resolve(7), Date.now() + 1000, null)).resolves.toBe(7);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the fallback once the deadline passes first; the promise runs on', async () => {
    let finish;
    const slow = new Promise((resolve) => { finish = resolve; });
    const got = valueBy(slow, Date.now() + 1000, 'late');
    jest.advanceTimersByTime(999);
    expect(await settled(got)).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(got).resolves.toBe('late');
    expect(jest.getTimerCount()).toBe(0);
    finish(1);
    await expect(slow).resolves.toBe(1);
  });

  it('a deadline already passed gives the fallback at once', async () => {
    const got = valueBy(new Promise(() => {}), Date.now() - 5, false);
    jest.advanceTimersByTime(0);
    await expect(got).resolves.toBe(false);
  });

  it('no deadline waits for the promise as it is, with no timer', async () => {
    let finish;
    const got = valueBy(new Promise((resolve) => { finish = resolve; }), null, 'late');
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(await settled(got)).toBe(false);
    finish('value');
    await expect(got).resolves.toBe('value');
  });

  it('a refusal passes through, and the timer goes with it', async () => {
    await expect(valueBy(Promise.reject(new Error('no')), Date.now() + 1000, null)).rejects.toThrow('no');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('one time limit in the app', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
  const sources = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const file = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return sources(file);
    return /\.(js|jsx|ts|tsx)$/.test(e.name) ? [file] : [];
  });
  // Each Promise.race( call of a source, to its closing parenthesis.
  const races = (src) => [...src.matchAll(/Promise\.race\(/g)].map((m) => {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
    return src.slice(m.index, i);
  });

  it('no source races a promise against a timer of its own: the modules that wait on a slow read take valueBy', () => {
    const files = sources('');
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => races(read(file)).some((call) => call.includes('setTimeout(')))).toEqual([]);
    expect(races('await Promise.race([a, new Promise((r) => { t = setTimeout(r, 5); })]);')).toHaveLength(1);
    for (const file of ['services/BackgroundPriority.js', 'services/DeviceEnrolment.js', 'services/PushService.js',
      'services/DeviceModel.js', 'components/WalletManager.js']) {
      const src = read(file);
      expect([file, src.includes("import { valueBy } from '../utils/deadline';")]).toEqual([file, true]);
      expect(src).not.toMatch(/function (within|untilDeadline)\(/);
    }
  });
});
