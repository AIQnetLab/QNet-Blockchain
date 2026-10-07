//! Game items: item kinds numbered by a u64, held as counts per address.
//!
//! Entries. Arguments are concatenated: an address is its 45 ASCII bytes, a number 8 bytes
//! little-endian. A transaction carries them hex-encoded. An address whose checksum fails reverts the
//! call (`bad address`), so a mistyped recipient keeps the items where they were.
//! - `mint(to, item, amount)`: owner only; creates `amount` of `item` for `to`.
//! - `transfer(to, item, amount)`: moves `amount` of the caller's `item` to `to`.
//! - `balance(holder, item)`: returns the count to a calling contract, 8 bytes little-endian.
//!
//! Storage, as text so it reads plainly off-chain: `bal:<address>:<item>` and `supply:<item>`
//! hold decimal counts. Every mint and transfer emits one text event,
//! `mint:<to>:<item>:<amount>` or `transfer:<from>:<to>:<item>:<amount>`, with decimal numbers.
//!
//! The owner is fixed at build time by `GAME_ITEMS_OWNER`. A build without it can never mint.
#![cfg_attr(target_arch = "wasm32", no_std)]

use qnet_contract::{args, caller, emit, entry, revert, set_return, storage, Address, Buf, ADDRESS_LEN};

#[cfg(not(test))]
const OWNER: Option<Address> = owner(option_env!("GAME_ITEMS_OWNER"));
#[cfg(test)]
const OWNER: Option<Address> = owner(Some(tests::OWNER));

/// An address whose form or checksum is wrong fails the build; `cargo build-contracts` refuses it before
/// building anything.
const fn owner(env: Option<&str>) -> Option<Address> {
    match env {
        Some(s) => Some(Address::parse(s)),
        None => None,
    }
}

/// Longest key: `bal:` + address + `:` + 20 digits.
type Key = Buf<{ 4 + ADDRESS_LEN + 1 + 20 }>;
/// Longest event: `transfer:` + two addresses + two 20-digit numbers + three `:`.
type Event = Buf<{ 9 + 2 * ADDRESS_LEN + 2 * 20 + 3 }>;

entry! {
    /// Owner only: creates `amount` of `item` for `to`.
    fn mint() {
        require_owner(OWNER);
        let (to, item, amount) = move_args();
        credit(&to, item, amount);
        let mut supply = Key::new();
        supply.push(b"supply:").push_decimal(item);
        add(supply.as_bytes(), amount);
        emit(
            Event::new()
                .push(b"mint:")
                .push(to.as_bytes())
                .push(b":")
                .push_decimal(item)
                .push(b":")
                .push_decimal(amount)
                .as_bytes(),
        );
    }

    /// Moves `amount` of the caller's `item` to `to`.
    fn transfer() {
        let from = caller();
        let (to, item, amount) = move_args();
        let key = balance_key(&from, item);
        let held = storage::read_decimal(key.as_bytes()).unwrap_or(0);
        if held < amount {
            revert(b"insufficient balance")
        }
        storage::write_decimal(key.as_bytes(), held - amount);
        credit(&to, item, amount);
        emit(
            Event::new()
                .push(b"transfer:")
                .push(from.as_bytes())
                .push(b":")
                .push(to.as_bytes())
                .push(b":")
                .push_decimal(item)
                .push(b":")
                .push_decimal(amount)
                .as_bytes(),
        );
    }

    /// Returns the count of `item` that `holder` has, 8 bytes little-endian.
    fn balance() {
        let mut buf = [0u8; ADDRESS_LEN + 8];
        let mut a = args(&mut buf);
        let (holder, item) = (a.address(), a.u64());
        a.end();
        let n = storage::read_decimal(balance_key(&holder, item).as_bytes()).unwrap_or(0);
        set_return(&n.to_le_bytes());
    }
}

fn require_owner(owner: Option<Address>) {
    match owner {
        None => revert(b"owner not set"),
        Some(o) => {
            if o != caller() {
                revert(b"not owner")
            }
        }
    }
}

/// `(to, item, amount)`; a zero amount reverts.
fn move_args() -> (Address, u64, u64) {
    let mut buf = [0u8; ADDRESS_LEN + 8 + 8];
    let mut a = args(&mut buf);
    let (to, item, amount) = (a.address(), a.u64(), a.u64());
    a.end();
    if amount == 0 {
        revert(b"zero amount")
    }
    (to, item, amount)
}

fn balance_key(holder: &Address, item: u64) -> Key {
    let mut k = Key::new();
    k.push(b"bal:").push(holder.as_bytes()).push(b":").push_decimal(item);
    k
}

fn credit(to: &Address, item: u64, amount: u64) {
    add(balance_key(to, item).as_bytes(), amount);
}

fn add(key: &[u8], amount: u64) {
    match storage::read_decimal(key).unwrap_or(0).checked_add(amount) {
        Some(n) => storage::write_decimal(key, n),
        None => revert(b"overflow"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_contract::mock;

    pub const OWNER: &str = "a11ce00000000000000eon00000000000000039de5182";
    const PLAYER: &str = "b0b0000000000000000eon000000000000000ba6735da";

    fn move_args(to: &str, item: u64, amount: u64) -> Vec<u8> {
        [to.as_bytes(), &item.to_le_bytes(), &amount.to_le_bytes()].concat()
    }

    fn bal(holder: &str, item: u64) -> Option<String> {
        mock::storage(format!("bal:{holder}:{item}").as_bytes()).map(|v| String::from_utf8(v).unwrap())
    }

    fn events(out: &mock::Outcome) -> Vec<String> {
        out.events
            .iter()
            .map(|e| String::from_utf8(e.clone()).unwrap())
            .collect()
    }

    fn mint_as_owner(to: &str, item: u64, amount: u64) -> mock::Outcome {
        mock::set_caller(OWNER.as_bytes());
        mock::call(&move_args(to, item, amount), super::mint)
    }

    #[test]
    fn owner_mints_and_supply_counts() {
        mock::reset();
        let out = mint_as_owner(PLAYER, 7, 5);
        assert_eq!(out.reverted, None);
        assert_eq!(events(&out), [format!("mint:{PLAYER}:7:5")]);
        mint_as_owner(PLAYER, 7, 2);
        assert_eq!(bal(PLAYER, 7).as_deref(), Some("7"));
        assert_eq!(mock::storage(b"supply:7").as_deref(), Some(&b"7"[..]));
    }

    #[test]
    fn only_the_owner_mints() {
        mock::reset();
        mock::set_caller(PLAYER.as_bytes());
        let out = mock::call(&move_args(PLAYER, 7, 5), super::mint);
        assert_eq!(out.reverted.as_deref(), Some("not owner"));
        assert!(out.writes.is_empty() && out.events.is_empty());
    }

    #[test]
    fn a_build_without_an_owner_cannot_mint() {
        mock::reset();
        assert!(owner(None).is_none());
        let out = mock::call(&[], || require_owner(owner(None)));
        assert_eq!(out.reverted.as_deref(), Some("owner not set"));
    }

    #[test]
    fn transfer_moves_items_and_emits() {
        mock::reset();
        mint_as_owner(PLAYER, 3, 10);
        mock::set_caller(PLAYER.as_bytes());
        let out = mock::call(&move_args(OWNER, 3, 4), super::transfer);
        assert_eq!(out.reverted, None);
        assert_eq!(events(&out), [format!("transfer:{PLAYER}:{OWNER}:3:4")]);
        assert_eq!(bal(PLAYER, 3).as_deref(), Some("6"));
        assert_eq!(bal(OWNER, 3).as_deref(), Some("4"));
        assert_eq!(mock::storage(b"supply:3").as_deref(), Some(&b"10"[..]));
    }

    #[test]
    fn transfer_to_self_keeps_the_balance() {
        mock::reset();
        mint_as_owner(PLAYER, 3, 10);
        mock::set_caller(PLAYER.as_bytes());
        let out = mock::call(&move_args(PLAYER, 3, 10), super::transfer);
        assert_eq!(out.reverted, None);
        assert_eq!(bal(PLAYER, 3).as_deref(), Some("10"));
    }

    #[test]
    fn transfer_beyond_the_balance_reverts() {
        mock::reset();
        mint_as_owner(PLAYER, 3, 2);
        mock::set_caller(PLAYER.as_bytes());
        let out = mock::call(&move_args(OWNER, 3, 3), super::transfer);
        assert_eq!(out.reverted.as_deref(), Some("insufficient balance"));
        assert_eq!(bal(PLAYER, 3).as_deref(), Some("2"));
        assert_eq!(bal(OWNER, 3), None);
    }

    #[test]
    fn malformed_args_revert() {
        mock::reset();
        mock::set_caller(OWNER.as_bytes());
        let cases: [(Vec<u8>, &str); 4] = [
            (move_args(PLAYER, 1, 0), "zero amount"),
            (move_args(PLAYER, 1, 1)[..60].to_vec(), "args too short"),
            ([move_args(PLAYER, 1, 1), vec![0]].concat(), "args too long"),
            (move_args(&PLAYER.to_uppercase(), 1, 1), "bad address"),
        ];
        for (input, expected) in cases {
            let out = mock::call(&input, super::mint);
            assert_eq!(out.reverted.as_deref(), Some(expected));
        }
    }

    // DEV-R2-06: a recipient typed with one digit wrong is refused, never credited to an address no key controls.
    #[test]
    fn a_mistyped_recipient_reverts_and_keeps_the_items() {
        mock::reset();
        mint_as_owner(PLAYER, 3, 10);
        let mut typo = OWNER.to_string().into_bytes();
        typo[5] = b'1';
        let typo = String::from_utf8(typo).unwrap();
        mock::set_caller(PLAYER.as_bytes());
        let out = mock::call(&move_args(&typo, 3, 4), super::transfer);
        assert_eq!(out.reverted.as_deref(), Some("bad address"));
        assert_eq!(bal(PLAYER, 3).as_deref(), Some("10"));
        assert_eq!(bal(&typo, 3), None);
        mock::set_caller(OWNER.as_bytes());
        assert_eq!(mock::call(&move_args(&typo, 3, 1), super::mint).reverted.as_deref(), Some("bad address"));
    }

    #[test]
    fn minting_past_u64_reverts() {
        mock::reset();
        mock::set_storage(format!("bal:{PLAYER}:1").as_bytes(), u64::MAX.to_string().as_bytes());
        let out = mint_as_owner(PLAYER, 1, 1);
        assert_eq!(out.reverted.as_deref(), Some("overflow"));
    }

    #[test]
    fn balance_returns_the_count() {
        mock::reset();
        mint_as_owner(PLAYER, 9, 12);
        let input = [PLAYER.as_bytes(), &9u64.to_le_bytes()].concat();
        let out = mock::call(&input, super::balance);
        assert_eq!(out.ret, 12u64.to_le_bytes());
        let none = [OWNER.as_bytes(), &9u64.to_le_bytes()].concat();
        assert_eq!(mock::call(&none, super::balance).ret, 0u64.to_le_bytes());
    }
}
