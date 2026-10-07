//! The genesis side of the device layer that needs this node's own keys: its signature as one of the five
//! device-statement attestors (A3) and on the state changes it causes (A6). RPC and P2P policy only.

use super::BlockchainNode;

impl BlockchainNode {
    /// This genesis's raw ML-DSA-65 signature over a device statement or a state change, made with its
    /// consensus key - the key `GENESIS_CONSENSUS_PKS` pins, under which every other genesis checks it.
    /// None on a node that is not one of the five genesis, or whose loaded key is not the pinned one.
    pub(crate) fn sign_device_message(&self, preimage: &str) -> Option<(String, String)> {
        if !crate::genesis_constants::is_legacy_genesis_node(&self.node_id) { return None; }
        let envelope = self.wallet_identity.as_ref()?.sign_consensus(&self.node_id, preimage.as_bytes()).ok()?;
        let pk = crate::light_device::statement::GenesisSet::production().key(&self.node_id)?;
        let raw = crate::light_device::statement::raw_from_envelope(&self.node_id, &envelope, preimage, pk)?;
        Some((self.node_id.clone(), hex::encode(raw)))
    }
}
