#!/usr/bin/env python3
"""
v14.5: Initialize 1DEV BurnTracker PDA on redeployed program.

Usage:
  python3 initialize_tracker.py <deployer_keypair.json>

Calls `initialize(authority, admin, burn_address, one_dev_mint,
network_genesis_timestamp, verification_authority)` on program
CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw to create the burn_tracker
PDA. Uses the deployer keypair for ALL authority/admin slots on testnet.

The off-chain Anchor discriminator is SHA256("global:initialize")[:8].
"""
import json
import struct
import sys
import hashlib
import time
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.message import Message
from solders.transaction import Transaction
from solders.hash import Hash

RPC_URL = "https://api.devnet.solana.com"
PROGRAM_ID = Pubkey.from_string("CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw")
BURN_INCINERATOR = Pubkey.from_string("1nc1nerator11111111111111111111111111111111")
ONE_DEV_MINT = Pubkey.from_string("62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ")


def anchor_discriminator(ix_name: str) -> bytes:
    """Anchor 0.30 discriminator: first 8 bytes of SHA256('global:<name>')."""
    return hashlib.sha256(f"global:{ix_name}".encode()).digest()[:8]


def derive_burn_tracker_pda() -> tuple[Pubkey, int]:
    return Pubkey.find_program_address([b"burn_tracker"], PROGRAM_ID)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: initialize_tracker.py <deployer_keypair.json>", file=sys.stderr)
        return 2

    kp_path = sys.argv[1]
    with open(kp_path, "r") as f:
        secret = bytes(json.load(f))
    deployer = Keypair.from_bytes(secret)
    print(f"Deployer (payer, authority, admin, verification_authority): {deployer.pubkey()}")

    client = Client(RPC_URL)

    # Check balance
    bal = client.get_balance(deployer.pubkey()).value
    print(f"Balance: {bal / 1e9:.4f} SOL")

    # PDA
    tracker_pda, bump = derive_burn_tracker_pda()
    print(f"BurnTracker PDA: {tracker_pda}  (bump={bump})")

    # Check if tracker already exists
    info = client.get_account_info(tracker_pda).value
    if info is not None:
        print(f"[OK] Tracker already initialized (lamports={info.lamports}).")
        return 0

    # Network genesis timestamp: use current Unix time rounded down to hour
    # (for testnet this is informational — affects only the 5-year phase-2 limit).
    network_genesis_ts = int(time.time())

    # Build instruction data:
    #   disc(8) + authority(32) + admin(32) + burn_address(32) +
    #   one_dev_mint(32) + network_genesis_timestamp(i64 LE) +
    #   verification_authority(32)
    data = (
        anchor_discriminator("initialize")
        + bytes(deployer.pubkey())            # authority
        + bytes(deployer.pubkey())            # admin
        + bytes(BURN_INCINERATOR)             # burn_address
        + bytes(ONE_DEV_MINT)                 # one_dev_mint
        + struct.pack("<q", network_genesis_ts)
        + bytes(deployer.pubkey())            # verification_authority
    )

    # Accounts (order must match #[derive(Accounts)] InitializeBurnTracker):
    #   burn_tracker (PDA, mut, init) — writable, NOT signer (init by PDA)
    #   authority                    — writable + signer
    #   system_program               — readonly
    ix = Instruction(
        program_id=PROGRAM_ID,
        accounts=[
            AccountMeta(pubkey=tracker_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=deployer.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ],
        data=data,
    )

    bh = client.get_latest_blockhash().value.blockhash
    msg = Message.new_with_blockhash([ix], deployer.pubkey(), bh)
    tx = Transaction([deployer], msg, bh)
    print("Sending initialize transaction...")
    resp = client.send_transaction(tx)
    print(f"TX signature: {resp.value}")
    print("Waiting confirmation (up to 30s)...")
    client.confirm_transaction(resp.value, commitment="confirmed")
    print("Confirmed.")

    info = client.get_account_info(tracker_pda).value
    if info is None:
        print("[ERR] Tracker account not present after tx — unexpected.", file=sys.stderr)
        return 3
    print(f"[OK] BurnTracker PDA initialized (lamports={info.lamports}, data_len={len(info.data)}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
