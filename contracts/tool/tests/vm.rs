//! Runs the templates in the node's own VM (core/qnet-vm): deploy validation, then calls through
//! `execute_call_tree`, the executor block application uses. Storage is committed between calls
//! only when a call does not trap, as the node does.
//!
//! Builds the wasm32 modules once per run into `target/vm-test` (needs the wasm32-unknown-unknown
//! target). `cargo test -- --nocapture` prints module sizes and fuel.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::OnceLock;

use qnet_contract_tool::{
    build, check_module, deploy_gas, templates, workspace_root, DEPLOY_PAYLOAD_OVERHEAD, HOST_FUNCTIONS, MAX_GAS_LIMIT,
    MAX_MODULE_BYTES,
};
use qnet_vm::{execute_call_tree, CallTreeOutcome, ContractResolver};

const HEIGHT: u64 = 42;
const FUEL: u64 = 1_000_000;

/// A valid address (its checksum included) starting with the hex `tag`: the helper refuses any other.
fn address(tag: &str) -> String {
    use sha3::{Digest, Sha3_256};
    let body = format!("{tag:0<19}eon{:0>15}", "");
    let digest = Sha3_256::digest(body.as_bytes());
    let checksum: String = digest[..4].iter().map(|x| format!("{x:02x}")).collect();
    let a = format!("{body}{checksum}");
    assert!(qnet_contract_tool::is_valid_address(&a));
    a
}

fn owner() -> String {
    address("a11ce")
}

fn player() -> String {
    address("b0b")
}

/// Every template plus the ABI probe, built once with `GAME_ITEMS_OWNER` = [`owner`], by file stem.
fn modules() -> &'static BTreeMap<String, Vec<u8>> {
    static BUILT: OnceLock<BTreeMap<String, Vec<u8>>> = OnceLock::new();
    BUILT.get_or_init(|| {
        let mut packages: Vec<String> = templates().expect("templates").into_iter().map(|t| t.name).collect();
        packages.push("qnet-contract-abi-probe".to_string());
        let dir = workspace_root().join("target").join("vm-test");
        let owner = owner();
        let paths = build(&packages, Some(&dir), &[("GAME_ITEMS_OWNER", owner.as_str())])
            .expect("wasm32 build (rustup target add wasm32-unknown-unknown)");
        paths
            .into_iter()
            .map(|p| {
                (
                    p.file_stem().unwrap().to_string_lossy().into_owned(),
                    std::fs::read(&p).unwrap(),
                )
            })
            .collect()
    })
}

fn module(stem: &str) -> Vec<u8> {
    modules()
        .get(stem)
        .unwrap_or_else(|| panic!("{stem}.wasm was not built"))
        .clone()
}

/// Committed storage per contract address.
type Stores = BTreeMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>;

/// Contracts and their committed storage.
struct Chain {
    codes: BTreeMap<Vec<u8>, Vec<u8>>,
    stores: RefCell<Stores>,
}

impl ContractResolver for Chain {
    fn code(&self, addr: &[u8]) -> Option<Vec<u8>> {
        self.codes.get(addr).cloned()
    }
    fn storage(&self, addr: &[u8]) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.stores.borrow().get(addr).cloned().unwrap_or_default()
    }
}

impl Chain {
    fn new(contracts: &[(&str, Vec<u8>)]) -> Rc<Chain> {
        for (_, code) in contracts {
            qnet_vm::validate_wasm_module(code, &qnet_vm::VmLimits::default()).expect("deploy validation");
        }
        Rc::new(Chain {
            codes: contracts
                .iter()
                .map(|(a, c)| (a.as_bytes().to_vec(), c.clone()))
                .collect(),
            stores: RefCell::new(BTreeMap::new()),
        })
    }

    /// One transaction: `caller` calls `entry` on `contract` with `args`.
    fn call(self: &Rc<Self>, contract: &str, entry: &str, caller: &str, args: &[u8]) -> CallTreeOutcome {
        let out = execute_call_tree(
            self.clone(),
            contract.as_bytes(),
            entry,
            caller.as_bytes(),
            0,
            HEIGHT,
            args.to_vec(),
            FUEL,
        );
        if !out.trapped {
            let mut stores = self.stores.borrow_mut();
            for (addr, writes) in &out.writes {
                stores.entry(addr.clone()).or_default().extend(writes.clone());
            }
        }
        out
    }

    fn get(&self, contract: &str, key: &[u8]) -> Option<Vec<u8>> {
        self.stores
            .borrow()
            .get(contract.as_bytes())
            .and_then(|s| s.get(key).cloned())
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn deploy_size_cap_follows_the_gas_rules() {
    assert_eq!(DEPLOY_PAYLOAD_OVERHEAD, 102);
    assert_eq!(MAX_MODULE_BYTES, 24_949);
    assert_eq!(deploy_gas(MAX_MODULE_BYTES), MAX_GAS_LIMIT);
    assert!(deploy_gas(MAX_MODULE_BYTES + 1) > MAX_GAS_LIMIT);
    assert_eq!(deploy_gas(1_709), 535_200);
    assert_eq!(deploy_gas(8_712), 675_260);
}

#[test]
fn gas_constants_match_the_node_source() {
    let root = workspace_root().join("..");
    let state = std::fs::read_to_string(root.join("core/qnet-state/src/transaction.rs")).unwrap();
    for pin in [
        "pub const CONTRACT_DEPLOY: u64 = 500_000;",
        "pub const MAX_GAS_LIMIT: u64 = 1_000_000;",
        "gas_limits::CONTRACT_DEPLOY.saturating_add((code_bytes as u64).saturating_mul(10))",
    ] {
        assert!(
            state.contains(pin),
            "core/qnet-state/src/transaction.rs no longer has `{pin}`"
        );
    }
    // The payload {"code":<hex>,"code_hash":<hex>,"wasm":true} behind DEPLOY_PAYLOAD_OVERHEAD, compared without
    // whitespace: the handler adds code_hash itself, or the node's canonical-payload helper does.
    let squash = |s: &str| s.split_whitespace().collect::<String>();
    let rpc =
        squash(&std::fs::read_to_string(root.join("development/qnet-integration/src/rpc/contracts_api.rs")).unwrap());
    let state = squash(&state);
    assert!(
        rpc.contains(r#""wasm":true,"code":hex::encode(&wasm_code)"#),
        "the deploy payload in contracts_api.rs changed: its wasm and code fields are gone"
    );
    assert!(
        rpc.contains(r#"deploy_data["code_hash"]=json!(code_hash);"#)
            || state.contains(r#"m.insert("code_hash",V::String(deploy_code_hash(kind,parsed)?));"#),
        "the deploy payload no longer carries code_hash"
    );
}

#[test]
fn every_template_passes_the_node_validator_and_fits_a_deploy() {
    for (name, bytes) in modules() {
        let r = check_module(bytes).unwrap_or_else(|p| panic!("{name}: {p:?}"));
        println!(
            "{name}.wasm: {} bytes, deploy gas {}, entries {:?}",
            r.bytes, r.deploy_gas, r.entries
        );
        assert!(r.bytes <= MAX_MODULE_BYTES);
    }
    let entries = |stem: &str| {
        let mut e = check_module(&module(stem)).unwrap().entries;
        e.sort();
        e
    };
    assert_eq!(entries("counter"), ["reset", "run"]);
    assert_eq!(entries("game_items"), ["balance", "mint", "transfer"]);
}

#[test]
fn counter_matches_the_text_example() {
    let source = include_str!("../../../development/qnet-contracts/examples/counter.wat");
    let example = wat::parse_str(source).unwrap();
    let c = address("c0c");
    let text_chain = Chain::new(&[(c.as_str(), example)]);
    let rust_chain = Chain::new(&[(c.as_str(), module("counter"))]);
    let (p, o) = (player(), owner());
    for (entry, caller) in [("run", &p), ("run", &o), ("reset", &p), ("run", &o)] {
        let a = text_chain.call(&c, entry, caller, &[]);
        let b = rust_chain.call(&c, entry, caller, &[]);
        println!(
            "counter {entry}: fuel {} (text example {})",
            b.fuel_consumed, a.fuel_consumed
        );
        assert!(!a.trapped && !b.trapped, "{entry}");
        assert_eq!(a.writes, b.writes, "{entry}");
        assert_eq!(a.logs, b.logs, "{entry}");
    }
    assert_eq!(rust_chain.get(&c, b"count"), Some(1u64.to_le_bytes().to_vec()));
    let first = rust_chain.call(&c, "run", &p, &[]);
    let event = [&2u64.to_le_bytes()[..], p.as_bytes()].concat();
    assert_eq!(first.logs, [(c.as_bytes().to_vec(), event)]);
}

fn move_args(to: &str, item: u64, amount: u64) -> Vec<u8> {
    [to.as_bytes(), &item.to_le_bytes(), &amount.to_le_bytes()].concat()
}

#[test]
fn game_items_run_in_the_vm() {
    let g = address("ca");
    let chain = Chain::new(&[(g.as_str(), module("game_items"))]);
    let (owner, player) = (owner(), player());
    let bal = |who: &str, item: u64| chain.get(&g, format!("bal:{who}:{item}").as_bytes()).map(|v| text(&v));

    let mint = chain.call(&g, "mint", &owner, &move_args(&player, 7, 5));
    println!("game-items mint: fuel {}", mint.fuel_consumed);
    assert!(!mint.trapped);
    assert_eq!(bal(&player, 7).as_deref(), Some("5"));
    assert_eq!(chain.get(&g, b"supply:7"), Some(b"5".to_vec()));
    assert_eq!(
        mint.logs,
        [(g.as_bytes().to_vec(), format!("mint:{player}:7:5").into_bytes())]
    );

    let stranger = chain.call(&g, "mint", &player, &move_args(&player, 7, 5));
    assert!(stranger.trapped && stranger.writes.is_empty() && stranger.logs.is_empty());

    let transfer = chain.call(&g, "transfer", &player, &move_args(&owner, 7, 2));
    println!("game-items transfer: fuel {}", transfer.fuel_consumed);
    assert!(!transfer.trapped);
    assert_eq!(bal(&player, 7).as_deref(), Some("3"));
    assert_eq!(bal(&owner, 7).as_deref(), Some("2"));
    assert_eq!(
        transfer.logs[0].1,
        format!("transfer:{player}:{owner}:7:2").into_bytes()
    );

    let too_much = chain.call(&g, "transfer", &player, &move_args(&owner, 7, 4));
    assert!(too_much.trapped);
    assert_eq!(bal(&player, 7).as_deref(), Some("3"));

    // DEV-R2-06: a recipient with one digit wrong is refused in the node's VM, and the checksum it costs leaves
    // a transfer far inside the clients' default fuel of 200,000.
    let mut typo = owner.clone().into_bytes();
    typo[3] = if typo[3] == b'0' { b'1' } else { b'0' };
    let typo = String::from_utf8(typo).unwrap();
    let mistyped = chain.call(&g, "transfer", &player, &move_args(&typo, 7, 1));
    assert!(mistyped.trapped && mistyped.writes.is_empty() && mistyped.logs.is_empty());
    assert_eq!(bal(&player, 7).as_deref(), Some("3"));
    assert!(transfer.fuel_consumed < 100_000, "transfer fuel {}", transfer.fuel_consumed);

    for bad in [
        move_args(&player, 7, 0),
        move_args(&player, 7, 1)[..50].to_vec(),
        b"x".repeat(61),
    ] {
        assert!(chain.call(&g, "mint", &owner, &bad).trapped);
    }

    let query = [player.as_bytes(), &7u64.to_le_bytes()].concat();
    let balance = chain.call(&g, "balance", &player, &query);
    assert!(!balance.trapped);
    assert_eq!(balance.ret, 3u64.to_le_bytes());
}

/// DEVP-R1-06: the fuel the documents quote for the templates is what the node's VM measures now, and the gas margin
/// they recommend over the intrinsic gas covers the dearest entry by half again.
#[test]
fn documented_fuel_is_what_the_vm_measures() {
    let g = address("ca");
    let items = Chain::new(&[(g.as_str(), module("game_items"))]);
    let (owner, player) = (owner(), player());
    let mint = items.call(&g, "mint", &owner, &move_args(&player, 7, 5));
    let transfer = items.call(&g, "transfer", &player, &move_args(&owner, 7, 2));
    let c = address("c0c");
    let counter = Chain::new(&[(c.as_str(), module("counter"))]);
    let run = counter.call(&c, "run", &player, &[]);
    assert!(!mint.trapped && !transfer.trapped && !run.trapped);
    let grouped = |n: u64| {
        let digits = n.to_string();
        let mut out = String::new();
        for (i, ch) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(ch);
        }
        out
    };
    let root = workspace_root().join("..");
    for doc in ["contracts/README.md", "docs/developers/smart-contracts.md"] {
        let text = std::fs::read_to_string(root.join(doc)).unwrap().split_whitespace().collect::<Vec<_>>().join(" ");
        for quoted in [
            format!("counter `run` {};", grouped(run.fuel_consumed)),
            format!(
                "`mint` {} and `transfer` {}",
                grouped(mint.fuel_consumed),
                grouped(transfer.fuel_consumed)
            ),
        ] {
            assert!(text.contains(&quoted), "{doc} does not say \"{quoted}\"");
        }
        let margin: u64 = text
            .split("A gas limit of intrinsic plus ")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .map(|n| n.replace(',', "").parse().unwrap())
            .unwrap_or_else(|| panic!("{doc} recommends no gas margin"));
        let dearest = mint.fuel_consumed.max(transfer.fuel_consumed).max(run.fuel_consumed);
        assert!(margin * 2 >= dearest * 3, "{doc}: a margin of {margin} for an entry burning {dearest}");
    }
}

#[test]
fn the_helper_binds_every_host_function() {
    let probe = module("qnet_contract_abi_probe");
    let mut imports = check_module(&probe).unwrap().imports;
    imports.sort();
    let mut host: Vec<&str> = HOST_FUNCTIONS.iter().map(|(n, _, _)| *n).collect();
    host.sort();
    assert_eq!(imports, host);

    let (a, b) = (address("a1"), address("b1"));
    let chain = Chain::new(&[(a.as_str(), probe.clone()), (b.as_str(), probe)]);
    let p = player();

    let ctx = chain.call(&a, "probe_context", &p, &[]);
    assert!(!ctx.trapped);
    assert_eq!(chain.get(&a, b"caller"), Some(p.clone().into_bytes()));
    assert_eq!(chain.get(&a, b"self"), Some(a.clone().into_bytes()));
    assert_eq!(chain.get(&a, b"height"), Some(HEIGHT.to_le_bytes().to_vec()));
    assert_eq!(chain.get(&a, b"value"), Some(0i64.to_le_bytes().to_vec()));

    let echo = chain.call(&a, "probe_echo", &p, b"hello");
    assert_eq!(echo.ret, b"hello");
    assert_eq!(echo.logs, [(a.as_bytes().to_vec(), b"hello".to_vec())]);

    let storage = chain.call(&a, "probe_storage", &p, &[]);
    assert!(!storage.trapped);
    let writes = &storage.writes[a.as_bytes()];
    assert_eq!(writes[&b"k"[..]], b"value");
    assert_eq!(writes[&b"empty"[..]], b"");
    assert_eq!(writes[&b"n"[..]], b"1234");

    for failing in ["probe_revert", "probe_panic"] {
        let out = chain.call(&a, failing, &p, &[]);
        assert!(out.trapped && out.writes.is_empty(), "{failing}");
    }

    let call = |target: &str, entry: &str| {
        let out = chain.call(&a, "probe_call", &p, &[target.as_bytes(), entry.as_bytes()].concat());
        assert!(!out.trapped, "probe_call {entry}");
        let rc = i32::from_le_bytes(chain.get(&a, b"rc").unwrap().try_into().unwrap());
        (rc, out)
    };
    let (rc, out) = call(&b, "probe_echo");
    assert_eq!(rc, 4);
    assert_eq!(chain.get(&a, b"ret"), Some(b"pi".to_vec()));
    assert_eq!(out.logs, [(b.as_bytes().to_vec(), b"ping".to_vec())]);

    assert_eq!(call(&b, "probe_context").0, 0);
    assert_eq!(chain.get(&b, b"caller"), Some(a.clone().into_bytes()));
    assert_eq!(chain.get(&b, b"value"), Some(7i64.to_le_bytes().to_vec()));

    assert_eq!(call(&b, "probe_revert").0, -3);
    assert_eq!(call(&a, "probe_echo").0, -2);
    assert_eq!(call(&address("dead"), "probe_echo").0, -1);
}

fn wat(source: &str) -> Vec<u8> {
    wat::parse_str(source).unwrap()
}

/// A valid contract of exactly `size` bytes, padded with a data segment.
fn module_of_size(size: usize) -> Vec<u8> {
    let with = |n: usize| {
        wat(&format!(
            r#"(module (memory (export "memory") 1 1) (func (export "run")) (data (i32.const 0) "{}"))"#,
            "a".repeat(n)
        ))
    };
    let mut n = size as isize;
    for _ in 0..8 {
        let m = with(n.max(0) as usize);
        if m.len() == size {
            return m;
        }
        n += size as isize - m.len() as isize;
    }
    panic!("no module of {size} bytes");
}

#[test]
fn the_checker_refuses_what_would_fail() {
    let ok = check_module(&wat(r#"(module (memory (export "memory") 1 1) (func (export "run")))"#)).unwrap();
    assert_eq!(ok.entries, ["run"]);
    assert!(ok.imports.is_empty());

    let cases = [
        (
            r#"(module (import "env" "nope" (func)) (memory (export "memory") 1 1) (func (export "run")))"#,
            "env.nope is not a host function",
        ),
        (
            r#"(module (import "env" "storage_read" (func (param i32) (result i32))) (memory (export "memory") 1 1) (func (export "run")))"#,
            "env.storage_read is imported as (i32) -> (i32)",
        ),
        (
            r#"(module (import "host" "emit_log" (func (param i32 i32))) (memory (export "memory") 1 1) (func (export "run")))"#,
            "host.emit_log",
        ),
        (
            r#"(module (import "env" "get_value" (global i64)) (memory (export "memory") 1 1) (func (export "run")))"#,
            "non-function",
        ),
        (r#"(module (memory 1 1) (func (export "run")))"#, "no memory exported"),
        (
            r#"(module (memory (export "memory") 1 1) (func (export "run") (param i32)))"#,
            "must be () -> ()",
        ),
        (r#"(module (memory (export "memory") 1 1))"#, "no entry point"),
        (
            r#"(module (memory (export "memory") 1 1) (func (export "run") (drop (f32.const 1))))"#,
            "nondeterministic",
        ),
        (
            r#"(module (memory (export "memory") 1) (func (export "run")))"#,
            "explicit maximum",
        ),
        (
            r#"(module (memory (export "memory") 1 257) (func (export "run")))"#,
            "memory_pages=257",
        ),
    ];
    for (source, expected) in cases {
        let problems = check_module(&wat(source)).expect_err(source);
        assert!(problems.iter().any(|p| p.contains(expected)), "{source}: {problems:?}");
    }

    assert!(check_module(&module_of_size(MAX_MODULE_BYTES)).is_ok());
    let over = check_module(&module_of_size(MAX_MODULE_BYTES + 1)).unwrap_err();
    assert!(over[0].contains("over the deployable 24,949"), "{over:?}");
}

type Lock = BTreeMap<(String, String), Vec<String>>;

fn read_lock(path: &std::path::Path) -> Lock {
    let text = std::fs::read_to_string(path).unwrap();
    let mut lock = Lock::new();
    for block in text.split("[[package]]").skip(1) {
        let (mut name, mut version, mut deps, mut in_deps) = (String::new(), String::new(), Vec::new(), false);
        for line in block.lines().map(str::trim) {
            if let Some(v) = line.strip_prefix("name = ") {
                name = v.trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("version = ") {
                version = v.trim_matches('"').to_string();
            } else if line == "dependencies = [" {
                in_deps = true;
            } else if line == "]" {
                in_deps = false;
            } else if in_deps {
                deps.push(line.trim_end_matches(',').trim_matches('"').to_string());
            }
        }
        lock.insert((name, version), deps);
    }
    lock
}

#[test]
fn the_vm_builds_from_the_node_lockfile_versions() {
    let ours = read_lock(&workspace_root().join("Cargo.lock"));
    let node = read_lock(&workspace_root().join("../Cargo.lock"));
    let resolve = |dep: &str| -> (String, String) {
        let mut parts = dep.split_whitespace();
        let name = parts.next().unwrap().to_string();
        match parts.next() {
            Some(v) => (name, v.to_string()),
            None => ours.keys().find(|(n, _)| *n == name).cloned().unwrap(),
        }
    };
    let mut todo = vec![("qnet-vm".to_string(), "0.1.0".to_string())];
    let mut seen = std::collections::BTreeSet::new();
    while let Some(pkg) = todo.pop() {
        if !seen.insert(pkg.clone()) {
            continue;
        }
        assert!(
            node.contains_key(&pkg),
            "{} {} is not in the node's Cargo.lock",
            pkg.0,
            pkg.1
        );
        todo.extend(ours[&pkg].iter().map(|d| resolve(d)));
    }
    assert!(seen.iter().any(|(n, v)| n == "wasmi" && v == "0.47.2"));
}
