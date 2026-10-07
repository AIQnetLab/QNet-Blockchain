//! qnet-device-oracle command line.

use std::path::PathBuf;

use qnet_device_oracle::config::Config;
use qnet_device_oracle::messages::{pem_decode, sha256, sha3_256};
use qnet_device_oracle::signer::Signer;
use qnet_device_oracle::{boot, log};

const USAGE: &str = "usage:
  qnet-device-oracle run --config <file>        serve (primary or standby, from the config)
  qnet-device-oracle check --config <file>      load the config and every secret, then exit
  qnet-device-oracle keygen --out <file>        create the ML-DSA-65 signing key (never overwrites)
  qnet-device-oracle evidence-key --out <file>  create the 32-byte evidence sealing key
  qnet-device-oracle pubkey --key <file>        print the public key the node binary pins
  qnet-device-oracle cert-sha256 <file>         print a certificate's SHA-256 for the clients list";

fn arg(args: &[String], name: &str) -> Result<PathBuf, String> {
    args.windows(2).find(|w| w[0] == name).map(|w| PathBuf::from(&w[1])).ok_or_else(|| format!("missing {}\n{}", name, USAGE))
}

fn write_new(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o400);
    }
    let mut f = opts.open(path).map_err(|e| format!("create {}: {}", path.display(), e))?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

fn main_inner() -> Result<(), String> {
    log::init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("run") => boot::run(Config::load(&arg(&args, "--config")?)?),
        Some("check") => {
            let cfg = Config::load(&arg(&args, "--config")?)?;
            let o = boot::build_oracle(&cfg)?;
            println!(
                "ok role={:?} network={:?} ios={} android={} oracle_key_sha3={}",
                cfg.role,
                cfg.network,
                o.vendors.devicecheck.is_some(),
                o.vendors.play.is_some(),
                hex::encode(sha3_256(o.signer.public_key()))
            );
            Ok(())
        }
        Some("keygen") => {
            let out = arg(&args, "--out")?;
            let s = Signer::generate();
            s.save_new(&out)?;
            println!("public_key={}", hex::encode(s.public_key()));
            println!("public_key_sha3={}", hex::encode(sha3_256(s.public_key())));
            Ok(())
        }
        Some("evidence-key") => {
            let out = arg(&args, "--out")?;
            let mut k = [0u8; 32];
            aws_lc_rs::rand::fill(&mut k).map_err(|_| "system randomness")?;
            write_new(&out, &k)
        }
        Some("pubkey") => {
            let s = Signer::load(&arg(&args, "--key")?)?;
            println!("public_key={}", hex::encode(s.public_key()));
            println!("public_key_sha3={}", hex::encode(sha3_256(s.public_key())));
            Ok(())
        }
        Some("cert-sha256") => {
            let path = args.get(2).ok_or(USAGE)?;
            let raw = std::fs::read(path).map_err(|e| format!("read {}: {}", path, e))?;
            let der = std::str::from_utf8(&raw).ok().and_then(|t| pem_decode(t, "CERTIFICATE")).unwrap_or(raw);
            println!("{}", hex::encode(sha256(&der)));
            Ok(())
        }
        _ => Err(USAGE.to_string()),
    }
}

fn main() {
    if let Err(e) = main_inner() {
        eprintln!("{}", e);
        std::process::exit(1);
    }
}
