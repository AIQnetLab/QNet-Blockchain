/**
 * The answers of `reads` (promises; one that rejects answers null), in the order they came: as soon as
 * `determined(answers, left)` says the `left` still out cannot change the outcome, else once all are in. Only when an
 * agreement read is decided changes, never what decides it; the reads still out run on and are ignored.
 */
export function settleReads(reads, determined) {
  return new Promise((resolve) => {
    const got = [];
    let left = reads.length;
    let done = false;
    const settleIfDecided = () => {
      if (done || (left > 0 && !determined(got, left))) return;
      done = true;
      resolve(got.slice());
    };
    if (left === 0) { settleIfDecided(); return; }
    for (const p of reads) {
      Promise.resolve(p).catch(() => null).then((v) => {
        got.push(v);
        left -= 1;
        settleIfDecided();
      });
    }
  });
}
