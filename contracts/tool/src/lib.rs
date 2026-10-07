//! Builds QNet contracts for wasm32 and checks modules against the node's deploy rules, using
//! the node's own validator (`core/qnet-vm`).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use wasmparser::{ExternalKind, FuncType, Parser, Payload, TypeRef, ValType};

/// Highest gas limit a transaction may carry (`gas_limits::MAX_GAS_LIMIT`, core/qnet-state).
pub const MAX_GAS_LIMIT: u64 = 1_000_000;
/// Deploy gas: this base (`gas_limits::CONTRACT_DEPLOY`) ...
pub const DEPLOY_GAS_BASE: u64 = 500_000;
/// ... plus this much per byte of the deploy payload.
pub const DEPLOY_GAS_PER_BYTE: u64 = 10;
/// The payload is `{"code":"<module hex>","code_hash":"<64 hex>","wasm":true}`: 102 bytes around
/// the module hex.
pub const DEPLOY_PAYLOAD_OVERHEAD: u64 = (r#"{"code":"","code_hash":"","wasm":true}"#.len() + 64) as u64;
/// Largest module one deploy can carry within [`MAX_GAS_LIMIT`]: 24,949 bytes.
pub const MAX_MODULE_BYTES: usize = ((MAX_GAS_LIMIT - DEPLOY_GAS_BASE - DEPLOY_GAS_PER_BYTE * DEPLOY_PAYLOAD_OVERHEAD)
    / (2 * DEPLOY_GAS_PER_BYTE)) as usize;

/// Gas a deploy of a `module_bytes` module needs; the module travels hex-encoded.
pub fn deploy_gas(module_bytes: usize) -> u64 {
    DEPLOY_GAS_BASE + DEPLOY_GAS_PER_BYTE * (2 * module_bytes as u64 + DEPLOY_PAYLOAD_OVERHEAD)
}

use ValType::{I32, I64};

/// The host functions of module `env` and their wasm types, as the node binds them
/// (core/qnet-vm `bind_frame_host`).
pub const HOST_FUNCTIONS: [(&str, &[ValType], &[ValType]); 11] = [
    ("storage_read", &[I32, I32, I32, I32], &[I32]),
    ("storage_write", &[I32, I32, I32, I32], &[]),
    ("get_caller", &[I32, I32], &[I32]),
    ("get_contract", &[I32, I32], &[I32]),
    ("get_call_args", &[I32, I32], &[I32]),
    ("set_return", &[I32, I32], &[]),
    ("get_block_height", &[], &[I64]),
    ("get_value", &[], &[I64]),
    ("emit_log", &[I32, I32], &[]),
    ("revert", &[I32, I32], &[]),
    ("call_contract", &[I32, I32, I32, I32, I32, I32, I64, I32, I32], &[I32]),
];

/// A module that passed [`check_module`].
#[derive(Debug)]
pub struct Report {
    pub bytes: usize,
    pub deploy_gas: u64,
    /// Exported entry points.
    pub entries: Vec<String>,
    /// Imported host functions.
    pub imports: Vec<String>,
    /// Declared memory in 64 KiB pages: initial and maximum.
    pub memory_pages: (u64, u64),
}

/// Judges `bytes` as a deploy is judged (size within the gas cap, the node's validator) and adds
/// what the deploy does not check but every call needs: host imports with the right types, an
/// exported `memory` and `() -> ()` entry points.
pub fn check_module(bytes: &[u8]) -> Result<Report, Vec<String>> {
    let mut problems = Vec::new();
    if bytes.len() > MAX_MODULE_BYTES {
        problems.push(format!(
            "{} bytes is over the deployable {} (deploy gas {} > {})",
            group(bytes.len() as u64),
            group(MAX_MODULE_BYTES as u64),
            group(deploy_gas(bytes.len())),
            group(MAX_GAS_LIMIT)
        ));
    }
    if let Err(e) = qnet_vm::validate_wasm_module(bytes, &qnet_vm::VmLimits::default()) {
        problems.push(format!("node validator: {e}"));
        return Err(problems);
    }
    let module = match Module::parse(bytes) {
        Ok(m) => m,
        Err(e) => {
            problems.push(e);
            return Err(problems);
        }
    };

    let mut imports = Vec::new();
    for (module_name, name, ty) in &module.imports {
        let host = HOST_FUNCTIONS.iter().find(|(n, _, _)| *n == name.as_str());
        match (module_name.as_str(), host, ty) {
            ("env", Some((_, params, results)), Some(t)) => {
                if t.params() == *params && t.results() == *results {
                    imports.push(name.clone());
                } else {
                    problems.push(format!(
                        "env.{name} is imported as {}; the host binds {}",
                        signature(t.params(), t.results()),
                        signature(params, results)
                    ));
                }
            }
            ("env", Some(_), None) => problems.push(format!("env.{name} is imported as a non-function")),
            ("env", None, _) => problems.push(format!("env.{name} is not a host function")),
            _ => problems.push(format!(
                "{module_name}.{name}: host functions come from module `env` only"
            )),
        }
    }

    if !module
        .exports
        .iter()
        .any(|(n, k, _)| n == "memory" && *k == ExternalKind::Memory)
    {
        problems.push("no memory exported as `memory`; every host call needs it".to_string());
    }
    let mut entries = Vec::new();
    for (name, kind, index) in &module.exports {
        if !matches!(kind, ExternalKind::Func | ExternalKind::FuncExact) {
            continue;
        }
        match module.func_type(*index) {
            Some(t) if t.params().is_empty() && t.results().is_empty() => entries.push(name.clone()),
            Some(t) => problems.push(format!(
                "export `{name}` is {}; an entry point must be () -> ()",
                signature(t.params(), t.results())
            )),
            None => problems.push(format!("export `{name}` names no function")),
        }
    }
    if entries.is_empty() {
        problems.push("no entry point exported".to_string());
    }

    if !problems.is_empty() {
        return Err(problems);
    }
    let (initial, maximum) = module.memory.unwrap_or((0, None));
    Ok(Report {
        bytes: bytes.len(),
        deploy_gas: deploy_gas(bytes.len()),
        entries,
        imports,
        memory_pages: (initial, maximum.unwrap_or(0)),
    })
}

#[derive(Default)]
struct Module {
    /// `(module, name, type)`; the type is `None` for a non-function import.
    imports: Vec<(String, String, Option<FuncType>)>,
    exports: Vec<(String, ExternalKind, u32)>,
    types: Vec<FuncType>,
    /// Type index of every function, imports first.
    functions: Vec<u32>,
    /// Initial and maximum pages.
    memory: Option<(u64, Option<u64>)>,
}

impl Module {
    fn parse(bytes: &[u8]) -> Result<Module, String> {
        let err = |e: wasmparser::BinaryReaderError| e.to_string();
        let mut m = Module::default();
        let mut import_types = Vec::new();
        for payload in Parser::new(0).parse_all(bytes) {
            match payload.map_err(err)? {
                Payload::TypeSection(r) => {
                    for t in r.into_iter_err_on_gc_types() {
                        m.types.push(t.map_err(err)?);
                    }
                }
                Payload::ImportSection(r) => {
                    for i in r.into_imports() {
                        let i = i.map_err(err)?;
                        let ty = match i.ty {
                            TypeRef::Func(t) | TypeRef::FuncExact(t) => {
                                m.functions.push(t);
                                Some(t)
                            }
                            _ => None,
                        };
                        import_types.push(ty);
                        m.imports.push((i.module.to_string(), i.name.to_string(), None));
                    }
                }
                Payload::FunctionSection(r) => {
                    for t in r {
                        m.functions.push(t.map_err(err)?);
                    }
                }
                Payload::MemorySection(r) => {
                    for mem in r {
                        let mem = mem.map_err(err)?;
                        m.memory = Some((mem.initial, mem.maximum));
                    }
                }
                Payload::ExportSection(r) => {
                    for e in r {
                        let e = e.map_err(err)?;
                        m.exports.push((e.name.to_string(), e.kind, e.index));
                    }
                }
                _ => {}
            }
        }
        for (import, ty) in m.imports.iter_mut().zip(import_types) {
            import.2 = ty.and_then(|t| m.types.get(t as usize).cloned());
        }
        Ok(m)
    }

    fn func_type(&self, function: u32) -> Option<&FuncType> {
        let t = *self.functions.get(function as usize)?;
        self.types.get(t as usize)
    }
}

fn signature(params: &[ValType], results: &[ValType]) -> String {
    let list = |v: &[ValType]| {
        v.iter()
            .map(|t| format!("{t:?}").to_lowercase())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!("({}) -> ({})", list(params), list(results))
}

/// `24949` as `24,949`.
pub fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The contracts workspace: this crate's parent directory.
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tool/ sits in the workspace")
        .to_path_buf()
}

/// Cargo, run from the workspace root so `.cargo/config.toml` (the wasm flags) applies.
fn cargo() -> Command {
    let mut c = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    c.current_dir(workspace_root());
    c
}

/// Length of a QNet address: 19 hex digits, `eon`, 15 hex digits and an 8-digit checksum.
pub const ADDRESS_LEN: usize = 45;

/// Whether `s` is a QNet address as the node accepts it: lowercase hex around `eon` at 19..22, and the
/// last 8 characters equal to the first 8 hex digits of SHA3-256 over the first 37.
pub fn is_valid_address(s: &str) -> bool {
    use sha3::{Digest, Sha3_256};
    let b = s.as_bytes();
    let hex = |c: &u8| c.is_ascii_digit() || (b'a'..=b'f').contains(c);
    if b.len() != ADDRESS_LEN || &b[19..22] != b"eon" || !b[..19].iter().chain(&b[22..]).all(hex) {
        return false;
    }
    let digest = Sha3_256::digest(&b[..37]);
    let checksum: String = digest[..4].iter().map(|x| format!("{x:02x}")).collect();
    checksum.as_bytes() == &b[37..]
}

/// A variable a template reads at build time (`[package.metadata.qnet.env]`), given either as its
/// meaning (`NAME = "meaning"`) or as a table with a kind (`NAME = { kind = "address", meaning = "..." }`).
pub struct BuildVar {
    pub name: String,
    pub meaning: String,
    /// The value must be a QNet address; the tool refuses a build with one whose checksum fails.
    pub address: bool,
}

/// A package under `templates/` and the environment variables it reads at build time.
pub struct Template {
    pub name: String,
    pub build_env: Vec<BuildVar>,
}

/// What stops a build of `t` before it starts: an address-valued variable that is set but is not a valid
/// address. A mistyped owner compiles into a contract whose code can never be replaced, so it is refused
/// here rather than deployed. `get` reads a variable (`std::env::var` in the tool).
pub fn build_env_problems(t: &Template, get: impl Fn(&str) -> Option<String>) -> Vec<String> {
    t.build_env
        .iter()
        .filter(|v| v.address)
        .filter_map(|v| {
            let value = get(&v.name)?;
            (!is_valid_address(&value)).then(|| {
                format!(
                    "{} is not a valid QNet address (wrong length, form or checksum): `{value}`; {} reads it as {}",
                    v.name, t.name, v.meaning
                )
            })
        })
        .collect()
}

fn build_var(name: &str, value: &Value) -> BuildVar {
    match value {
        Value::Object(o) => BuildVar {
            name: name.to_string(),
            meaning: o.get("meaning").and_then(Value::as_str).unwrap_or_default().to_string(),
            address: o.get("kind").and_then(Value::as_str) == Some("address"),
        },
        other => BuildVar { name: name.to_string(), meaning: other.as_str().unwrap_or_default().to_string(), address: false },
    }
}

/// Every package under `templates/`, by name.
pub fn templates() -> Result<Vec<Template>, String> {
    let out = cargo()
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .output()
        .map_err(|e| format!("cannot run cargo: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let meta: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let dir = canonical(&workspace_root().join("templates"));
    let mut found = Vec::new();
    for p in meta["packages"].as_array().into_iter().flatten() {
        let manifest = canonical(Path::new(p["manifest_path"].as_str().unwrap_or_default()));
        if !manifest.starts_with(&dir) {
            continue;
        }
        let build_env = p["metadata"]["qnet"]["env"]
            .as_object()
            .map(|m| m.iter().map(|(k, v)| build_var(k, v)).collect())
            .unwrap_or_default();
        found.push(Template {
            name: p["name"].as_str().unwrap_or_default().to_string(),
            build_env,
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Builds `packages` for wasm32 with the release profile and returns the module paths.
/// `target_dir` replaces the default target directory; `env` is set for the build.
pub fn build(packages: &[String], target_dir: Option<&Path>, env: &[(&str, &str)]) -> Result<Vec<PathBuf>, String> {
    let mut cmd = cargo();
    cmd.args([
        "build",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--message-format=json-render-diagnostics",
    ]);
    for p in packages {
        cmd.args(["-p", p]);
    }
    if let Some(d) = target_dir {
        cmd.arg("--target-dir").arg(d);
    }
    cmd.envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = cmd.spawn().map_err(|e| format!("cannot run cargo: {e}"))?;
    let mut modules = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|e| e.to_string())?;
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg["reason"] != "compiler-artifact" {
                continue;
            }
            for f in msg["filenames"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if f.ends_with(".wasm") {
                    modules.push(PathBuf::from(f));
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("cargo build failed (see the messages above)".to_string());
    }
    Ok(modules)
}
