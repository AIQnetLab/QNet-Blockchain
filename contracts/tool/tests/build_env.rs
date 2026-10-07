//! Address-valued build variables: the build tool refuses one whose checksum fails before anything is
//! built, since a contract compiled with a mistyped owner can never be changed after deploy (DEV-R1-13).

use qnet_contract_tool::{build_env_problems, is_valid_address, templates, BuildVar, Template};

/// The wallet of the known-answer phrase (`abandon` x11 `about`), as every client derives it.
const GOLDEN: &str = "d9fa370374e24333242eon847d1d354dcd87fe873823e";
/// The canonical burn address: an all-zero body with a valid checksum.
const BURN: &str = "0000000000000000000eon00000000000000036877022";

/// `s` with the character at `i` replaced by another lowercase hex digit.
fn one_digit_off(s: &str, i: usize) -> String {
    let mut b = s.as_bytes().to_vec();
    b[i] = if b[i] == b'0' { b'1' } else { b'0' };
    String::from_utf8(b).unwrap()
}

#[test]
fn address_checksum() {
    assert!(is_valid_address(GOLDEN));
    assert!(is_valid_address(BURN));
    // One digit of the body or of the checksum off: the shape holds, the checksum does not.
    for i in [0, 18, 22, 36, 37, 44] {
        let typo = one_digit_off(GOLDEN, i);
        assert!(!is_valid_address(&typo), "{typo}");
    }
    assert!(!is_valid_address(&GOLDEN.to_uppercase()));
    assert!(!is_valid_address(&GOLDEN[..44]));
    assert!(!is_valid_address(&format!("{GOLDEN}0")));
    assert!(!is_valid_address(&GOLDEN.replace("eon", "eom")));
    // The shape alone, with a zero checksum, is not enough.
    assert!(!is_valid_address("a11ce00000000000000eon00000000000000000000000"));
}

// DEV-R2-06: the contract helper checks an address argument with its own SHA3-256 (a const fn, no dependency);
// it must agree with this checksum on valid addresses and on every one-digit typo of them.
#[test]
fn the_contract_helper_agrees_on_the_checksum() {
    use sha3::{Digest, Sha3_256};
    let helper = |s: &str| qnet_contract::Address::from_bytes(s.as_bytes()).is_some();
    let mut seed = Sha3_256::digest(b"addresses");
    for _ in 0..200 {
        let hex: String = seed.iter().map(|x| format!("{x:02x}")).collect();
        let body = format!("{}eon{}", &hex[..19], &hex[19..34]);
        let digest = Sha3_256::digest(body.as_bytes());
        let address = format!("{body}{}", digest[..4].iter().map(|x| format!("{x:02x}")).collect::<String>());
        assert!(is_valid_address(&address) && helper(&address), "{address}");
        for i in [0, 7, 18, 22, 30, 36, 37, 44] {
            let typo = one_digit_off(&address, i);
            assert_eq!(helper(&typo), is_valid_address(&typo), "{typo}");
            assert!(!helper(&typo), "{typo}");
        }
        seed = Sha3_256::digest(seed);
    }
    for fixed in [GOLDEN, BURN] {
        assert!(helper(fixed), "{fixed}");
    }
    assert!(!helper(&GOLDEN.to_uppercase()) && !helper(&GOLDEN[..44]));
}

#[test]
fn a_mistyped_owner_stops_the_build() {
    let t = Template {
        name: "game-items".to_string(),
        build_env: vec![
            BuildVar { name: "GAME_ITEMS_OWNER".to_string(), meaning: "the minter".to_string(), address: true },
            BuildVar { name: "OTHER_TEXT".to_string(), meaning: "free text".to_string(), address: false },
        ],
    };
    let with = |owner: Option<&str>| {
        let owner = owner.map(str::to_string);
        build_env_problems(&t, move |name| match name {
            "GAME_ITEMS_OWNER" => owner.clone(),
            "OTHER_TEXT" => Some("not an address".to_string()),
            _ => None,
        })
    };
    assert!(with(Some(GOLDEN)).is_empty());
    // Unset: the build goes ahead (the tool notes it; that contract can never mint).
    assert!(with(None).is_empty());
    let typo = one_digit_off(GOLDEN, 5);
    let problems = with(Some(&typo));
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("GAME_ITEMS_OWNER") && problems[0].contains(&typo), "{}", problems[0]);
}

#[test]
fn game_items_declares_its_owner_as_an_address() {
    let all = templates().expect("cargo metadata");
    let game = all.iter().find(|t| t.name == "game-items").expect("the game-items template");
    let owner = game.build_env.iter().find(|v| v.name == "GAME_ITEMS_OWNER").expect("GAME_ITEMS_OWNER");
    assert!(owner.address);
    assert!(owner.meaning.contains("mint"));
}
