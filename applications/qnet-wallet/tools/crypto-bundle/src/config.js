// Chain constants compiled from the mobile source, so fees and the light-client trust anchor cannot drift
// between the two apps.
import * as feeConfig from '../../../../qnet-mobile/src/config/fees.js';
import * as genesisConfig from '../../../../qnet-mobile/src/config/genesisConsensus.js';

export const fees = { ...feeConfig };
export const genesisConsensus = { ...genesisConfig };
