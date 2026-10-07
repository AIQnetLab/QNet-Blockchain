// CABINET_PHONE_FLOWS: whether the node cabinet sends QNet Wallet its `link`, `claim` and `reserve` requests (unified
// plan SITE-8, rollout steps R5 and R8). Off until app builds that answer them are installed: the cabinet then offers its
// read pages, "I'm back" and the extension's paths, and the relay opens only `connect` sessions. On with the value 1;
// any other value, or none, is off.

export const PHONE_FLOWS_ENV = 'CABINET_PHONE_FLOWS';

export function phoneFlowsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PHONE_FLOWS_ENV] === '1';
}
