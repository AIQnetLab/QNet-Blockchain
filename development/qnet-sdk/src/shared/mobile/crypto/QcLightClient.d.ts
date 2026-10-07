// Types of applications/qnet-mobile/src/crypto/QcLightClient.js, which build.mjs compiles into the SDK.
export interface LightClientHooks {
  onNodeFailure?(base: string, reason: string): void;
  onProgress?(index: number): void;
  registryNodes?(): string[];
}

export type VerifiedAnchors = Record<string, { eligible_ids: string[]; beacon: string; registry_root: string }>;

export function verifyMacroblockStateRoot(
  stateRoot: string, blockHeight: number, nodes: () => string[], hooks?: LightClientHooks,
): Promise<boolean>;
export function verifyMacroblockLogsRoot(
  logsRoot: string, windowEnd: number, nodes: () => string[], hooks?: LightClientHooks,
): Promise<true | 'mismatch' | false>;
export function verifyLogInclusion(leafHex: string, proof: unknown, rootHex: string): boolean;
export function verifyLogWindowInclusion(subRootHex: string, windowProof: unknown, windowRootHex: string): boolean;
export function exportVerifiedAnchors(): VerifiedAnchors;
/** How many of the anchors it took (malformed ones and those at or below the pin are left out). */
export function importVerifiedAnchors(anchors: unknown): number;
export function trustFloorIndex(): number;
/** Forgets every verified checkpoint, resume anchor, failure and registry snapshot the light client holds. */
export function clearQcCache(): void;
