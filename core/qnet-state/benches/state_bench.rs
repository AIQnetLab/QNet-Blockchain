use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use qnet_state::account::Account;
use qnet_state::state::StateMerkleTree;
use qnet_state::transaction::{Transaction, TransactionType};

fn accounts(count: usize) -> Vec<(String, Account)> {
    (0..count)
        .map(|i| {
            let address = format!("eon_account_{:016x}", i);
            let mut account = Account::with_balance(address.clone(), 1_000_000 + i as u64);
            account.nonce = i as u64;
            (address, account)
        })
        .collect()
}

fn tree_of(count: usize) -> StateMerkleTree {
    let mut tree = StateMerkleTree::new();
    tree.insert_batch(&accounts(count));
    tree.finalize();
    tree
}

/// State root over a fresh account set: the per-block cost of committing state.
fn bench_state_root(c: &mut Criterion) {
    let mut group = c.benchmark_group("state_root");

    for size in [100usize, 1_000, 10_000] {
        let set = accounts(size);
        group.bench_with_input(BenchmarkId::new("insert_batch_finalize", size), &set, |b, set| {
            b.iter(|| {
                let mut tree = StateMerkleTree::new();
                tree.insert_batch(black_box(set));
                black_box(tree.finalize())
            });
        });
    }

    group.finish();
}

/// Incremental re-root: one account changes in a populated tree, which is what a
/// microblock does, as opposed to the full recompute above.
fn bench_incremental_root(c: &mut Criterion) {
    let mut group = c.benchmark_group("incremental_root");

    for size in [1_000usize, 10_000] {
        group.bench_with_input(BenchmarkId::new("single_update_finalize", size), &size, |b, &size| {
            let mut tree = tree_of(size);
            let address = format!("eon_account_{:016x}", 0);
            let mut balance = 1_000_000u64;
            b.iter(|| {
                balance += 1;
                let account = Account::with_balance(address.clone(), balance);
                tree.insert_lazy(black_box(&address), black_box(&account));
                black_box(tree.finalize())
            });
        });
    }

    group.finish();
}

/// Balance-proof generation and verification — the light-client read path.
fn bench_balance_proof(c: &mut Criterion) {
    let mut tree = tree_of(10_000);
    let root = tree.finalize();
    let address = format!("eon_account_{:016x}", 0);
    let account = Account::with_balance(address.clone(), 1_000_000);
    let proof = tree.generate_proof(&address);
    assert!(
        StateMerkleTree::verify_proof(&address, &account, &proof, &root),
        "benchmark fixture must produce a verifying proof"
    );

    let mut group = c.benchmark_group("balance_proof");

    group.bench_function("generate_10k", |b| {
        b.iter(|| black_box(tree.generate_proof(black_box(&address))));
    });

    group.bench_function("verify_10k", |b| {
        b.iter(|| {
            black_box(StateMerkleTree::verify_proof(
                black_box(&address),
                black_box(&account),
                black_box(&proof),
                black_box(&root),
            ))
        });
    });

    group.finish();
}

/// Canonical encoding and hashing of a transaction — run once per transaction on
/// every ingress, produce and validate path.
fn bench_transaction_hash(c: &mut Criterion) {
    let tx = Transaction::new(
        "eon_sender".to_string(),
        Some("eon_recipient".to_string()),
        100,
        7,
        100_000,
        10_000,
        1_234_567_890,
        None,
        TransactionType::Transfer {
            from: "eon_sender".to_string(),
            to: "eon_recipient".to_string(),
            amount: 100,
        },
        None,
    );

    let mut group = c.benchmark_group("transaction");

    group.bench_function("canonical_bytes", |b| {
        b.iter(|| black_box(black_box(&tx).canonical_bytes()));
    });

    group.bench_function("calculate_hash", |b| {
        b.iter(|| black_box(black_box(&tx).calculate_hash()));
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_state_root,
    bench_incremental_root,
    bench_balance_proof,
    bench_transaction_hash
);
criterion_main!(benches);
