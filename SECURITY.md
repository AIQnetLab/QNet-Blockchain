# Security policy

This document explains how to report a security vulnerability in QNet, what is in scope, and what
to expect after you report. QNet is pre-launch, experimental software under active development. It
has not completed an independent external audit. Treat any deployment as experimental and do not
place value at risk that you cannot afford to lose.

## Reporting a vulnerability

Report privately. Do not open a public GitHub issue, pull request, discussion or social media post
describing the problem before it has been fixed and a fix has been released.

Report through GitHub's private vulnerability reporting on this repository: the **Security** tab,
then **Report a vulnerability**. That channel is visible only to the maintainers.

A useful report contains:

- The commit hash or release you tested, and the affected crate, file and function.
- A description of the flaw and the concrete impact — what an attacker gains, and under what
  assumptions (number of nodes controlled, reputation or committee membership held, network
  position). QNet has no stake: committee selection is weighted by reputation only.
- Reproduction steps, ideally a failing test or a minimal proof of concept against a local network.
- Any suggested fix, if you have one.

Encrypted reporting: if you need a key to send the report encrypted, ask for one in a plain
first message rather than including the details in it.

## Scope

In scope, in rough order of severity:

| Area | Examples of what we want to hear about |
| --- | --- |
| Consensus | Safety violations (two conflicting finalized checkpoints), permanent liveness loss, quorum-certificate forgery, committee-selection manipulation, fork-choice or reorg exploits, equivocation that goes unpunished |
| Cryptography | Signature verification that can be bypassed or confused, domain-separation collisions, weak or predictable key derivation, nonce or randomness failures, address-to-key binding bypass |
| State and accounting | Balance or supply corruption, unauthorised minting, reward or claim inflation, double-spend, replay of a transaction across contexts, state-root divergence between honest nodes |
| Node and RPC | Remote crash, memory or disk exhaustion from a single well-formed message, authentication bypass on a privileged or internal-only endpoint, path traversal, injection |
| P2P | Peer-identity spoofing, handshake or transport downgrade, eclipse attacks, message forgery that survives verification |
| Smart contract VM | Sandbox escape, non-deterministic execution across nodes, fuel or gas metering bypass, host-function memory safety |
| Wallets and applications | Key material leaving the device or leaking to logs, mnemonic exposure, transaction-content substitution before signing, insecure key storage in the mobile or browser wallet |
| Build and supply chain | A dependency or build step in this repository that can be used to inject code |

Out of scope:

- Denial of service that depends only on volume — traffic floods, resource exhaustion by sheer
  request count, or amplification against third-party infrastructure.
- Findings that require an operator to have misconfigured their own node, or that depend on the
  attacker already controlling the node's host, data directory, or key material.
- The absence of TLS and of authentication on ordinary read endpoints of the node's HTTP server.
  The node serves plain HTTP by design and expects operators to place a reverse proxy in front of
  a publicly exposed RPC port. This is documented behaviour, not a vulnerability.
- Reports produced by automated scanners with no analysis of exploitability, dependency-version
  advisories with no demonstrated path to impact, and missing hardening headers or best-practice
  checklist items with no concrete attack.
- Vulnerabilities in third-party services the project merely talks to, or in software not contained
  in this repository.
- Social engineering of maintainers, contributors, node operators or users; physical attacks; and
  attacks on accounts or infrastructure rather than on the software.

## Rules for testing

- Do not test against the public network. Run a local network or your own isolated deployment.
- Do not run denial-of-service, load or stress tests against nodes you do not operate.
- Do not attempt to access, modify or destroy data belonging to anyone else, and do not interact
  with other people's accounts, keys or funds.
- Do not use social engineering, phishing, or physical intrusion against anyone connected to the
  project.
- Stop as soon as you have established impact. Do not escalate further to prove a point.
- Do not publish, sell, or trade on the finding before it is fixed and disclosed.

Security research that follows these rules is explicitly permitted by the project's licence: the
Business Source License 1.1 in [LICENSE](LICENSE) grants use of the software for "internal business
use, evaluation, testing, research, education, and security research" with no separate agreement.

## What to expect

These are the targets the maintainers aim for, not a contractual guarantee:

| Stage | Target |
| --- | --- |
| Acknowledgement that the report was received | 3 business days |
| Initial assessment: in scope or not, and a first severity read | 10 business days |
| Status update while a fix is being developed | Every 2 weeks |
| Coordinated public disclosure after a fix is available | By agreement, 90 days by default |

If a report describes a flaw that puts a live network at immediate risk, the fix and its rollout
take priority over the timeline above, and disclosure is delayed until operators have had a
reasonable window to upgrade.

There is no bug bounty programme. The project does not offer, and this document does not promise,
any payment, reward or other compensation for reports. Reporters who wish to be named will be
credited in the release notes or advisory that accompanies the fix; tell us the name you want used,
or say that you prefer to stay anonymous.

## Reporting non-security bugs

Ordinary bugs, crashes without a security impact, and feature requests belong in the public issue
tracker. See [CONTRIBUTING.md](CONTRIBUTING.md).
