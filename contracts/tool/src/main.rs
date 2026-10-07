//! `qnet-contract-tool build [TEMPLATE...]`: builds templates for wasm32 and checks each module.
//! `qnet-contract-tool check FILE...`: checks built modules.
//! Exits non-zero when a module is over the deployable size or fails a check.

use std::path::PathBuf;
use std::process::ExitCode;

use qnet_contract_tool::{build, build_env_problems, check_module, group, templates, MAX_GAS_LIMIT, MAX_MODULE_BYTES};

const USAGE: &str = "usage: qnet-contract-tool build [TEMPLATE...] | check FILE.wasm...";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("build") => build_templates(&args[1..]),
        Some("check") if args.len() > 1 => Ok(args[1..].iter().map(PathBuf::from).collect()),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(modules) => report(&modules),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(2)
        }
    }
}

fn build_templates(names: &[String]) -> Result<Vec<PathBuf>, String> {
    let all = templates()?;
    for n in names {
        if !all.iter().any(|t| &t.name == n) {
            let known: Vec<&str> = all.iter().map(|t| t.name.as_str()).collect();
            return Err(format!("no template `{n}`; templates: {}", known.join(", ")));
        }
    }
    let chosen: Vec<_> = all
        .iter()
        .filter(|t| names.is_empty() || names.contains(&t.name))
        .collect();
    let mut problems = Vec::new();
    for t in &chosen {
        for v in &t.build_env {
            if std::env::var_os(&v.name).is_none() {
                eprintln!("note: {} reads {} at build time ({}); it is not set", t.name, v.name, v.meaning);
            }
        }
        problems.extend(build_env_problems(t, |name| std::env::var(name).ok()));
    }
    if !problems.is_empty() {
        return Err(format!("nothing was built:\n{}", problems.join("\n")));
    }
    let packages: Vec<String> = chosen.iter().map(|t| t.name.clone()).collect();
    build(&packages, None, &[])
}

fn report(modules: &[PathBuf]) -> ExitCode {
    let mut failed = false;
    for path in modules {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                println!("FAIL {name}: {e}");
                failed = true;
                continue;
            }
        };
        match check_module(&bytes) {
            Ok(r) => println!(
                "ok   {name}: {} bytes, deploy gas {}, memory {}..{} pages, entries: {}\n     {}",
                group(r.bytes as u64),
                group(r.deploy_gas),
                r.memory_pages.0,
                r.memory_pages.1,
                r.entries.join(", "),
                path.display()
            ),
            Err(problems) => {
                failed = true;
                println!("FAIL {name}: {}", path.display());
                for p in problems {
                    println!("     - {p}");
                }
            }
        }
    }
    println!(
        "deployable size: at most {} bytes (deploy gas at most {})",
        group(MAX_MODULE_BYTES as u64),
        group(MAX_GAS_LIMIT)
    );
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
