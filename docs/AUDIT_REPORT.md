# DAOShips Formal Security Audit Report

**Initial Audit**: 2026-04-11
**Validation Pass**: 2026-04-13
**Final Resolution**: 2026-04-14
**Commit**: `accdb25` (main branch, with audit-applied cleanup pending commit)
**Solidity Version**: 0.8.22 (viaIR, optimizer 1000 runs, EVM London)
**OpenZeppelin Version**: `^5.0.0`
**Auditors**: Solidity Smart Contract Engineer + Security Engineer

---

## About This Report

This report went through a five-phase process:

1. **Initial audit** — parallel passes by specialist agents reading every production contract.
2. **Validation pass** — every finding re-verified against the actual code. Severities were adjusted based on evidence, invalidated findings were removed, and proposed fixes were checked against existing use cases to ensure they don't break anything.
3. **Design-intent pass** — surviving findings were re-checked against the team's own design documents (`SECURITY_GUIDE.md`, `DAOSHIPS_VS_ZODIAC_BAAL.md`) to filter out issues the team had already considered and explicitly accepted. This pass invalidated one finding (originally M-1) that turned out to be a documented intentional design decision.
4. **Low-severity deep dive** — the two remaining Low findings (L-1 and L-2) were analyzed for cost/benefit of proposed fixes. L-2 was reclassified to Informational (I-18) after deep analysis revealed adding a cap would add a subtle trap for future callers with no security benefit. NatSpec documentation was applied to the four batch functions instead.
5. **C-1 structural validation** — the final remaining Critical finding was validated in depth. Investigation revealed C-1 was not a production deployment bug but rotting legacy scripts that duplicated the canonical `deploy-all.ts`. Cleanup was applied: three staged scripts deleted, `004_deploy_navigators.ts` preserved (it was always correct), package.json and README tidied. L-1 was dismissed as out of scope (testnet-only, gitignored).

Each finding that survived validation is tagged with a **Validation:** note explaining what was confirmed, what the original framing got wrong (if anything), and why any recommended fix is safe to apply. Findings that did not survive validation are listed in [Appendix A: Removed Findings](#appendix-a-removed-findings) with the reason for removal — this is intentional so future auditors don't re-file them.

**Final outcome**: zero unresolved findings at any severity.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope](#2-scope)
3. [Threat Model](#3-threat-model)
4. [Findings Summary](#4-findings-summary)
5. [Critical Findings](#5-critical-findings)
6. [Low Severity Findings](#6-low-severity-findings)
7. [Informational Findings](#7-informational-findings)
8. [Scalability Analysis](#8-scalability-analysis)
9. [Stability Analysis](#9-stability-analysis)
10. [Efficiency Analysis](#10-efficiency-analysis)
11. [Succinctness Analysis](#11-succinctness-analysis)
12. [Priority Action Items](#12-priority-action-items)
13. [Appendix A: Removed Findings](#appendix-a-removed-findings)

---

## 1. Executive Summary

DAOShips is a MolochV3-inspired DAO governance framework targeting Quai Network. The architecture uses the Zodiac module pattern where a `DAOShip` governance contract controls a Quai Vault (avatar) via `execTransactionFromModule`. Factory-deployed instances use EIP-1167 minimal proxies for gas efficiency.

**Overall Posture**: **Strong**. After five review passes, **zero unresolved findings remain at any severity**. Most findings that initially looked like High or Medium issues turned out to be either architecturally prevented, explicitly documented and deliberately designed, or already mitigated in code with in-source labels (`H-1`, `H-2`, `H-4`, `C-1`, `C-2`, `M-1`, `M-6`, `M-7`, `L-1`, `L-2` — the team's own scheme). The development team has clearly iterated through prior security review cycles and maintains parallel design documents (`SECURITY_GUIDE.md`, `DAOSHIPS_VS_ZODIAC_BAAL.md`) that record rationale for every deliberate divergence from upstream MolochV3 / Baal.

The original Critical finding (deployment script bug) was **resolved** in this audit session via cleanup of legacy staged deploy scripts. The remaining Low finding (plaintext testnet keys in `.env`) was **dismissed** as out-of-scope — the keys are properly gitignored, target only Orchard testnet, and the team has a clear path for upgrading to hardware-wallet signing before any mainnet deployment.

### Dimension Ratings (post-validation)

| Dimension | Rating | Notes |
|-----------|--------|-------|
| **Security** | Strong | Major attack classes mitigated with documented defenses |
| **Scalability** | Good | Bounded loops; EIP-1167 clones; minor consistency gap in mint/burn batch size |
| **Stability** | Excellent | State machine correctness; comprehensive event emission; extensive test coverage |
| **Efficiency** | Good | Well-packed storage; minor optimization opportunities |
| **Succinctness** | Very Good | Clean architecture; no dead code; extensive NatSpec with labeled mitigations |

---

## 2. Scope

| File | Lines | Role |
|------|-------|------|
| [contracts/core/DAOShip.sol](../contracts/core/DAOShip.sol) | 1,672 | Core governance module |
| [contracts/core/DAOShipLauncher.sol](../contracts/core/DAOShipLauncher.sol) | 209 | Factory (DAO-only) |
| [contracts/core/DAOShipAndVaultLauncher.sol](../contracts/core/DAOShipAndVaultLauncher.sol) | 342 | Factory (DAO + Vault) |
| [contracts/tokens/SharesERC20.sol](../contracts/tokens/SharesERC20.sol) | 154 | Voting share token |
| [contracts/tokens/LootERC20.sol](../contracts/tokens/LootERC20.sol) | 156 | Non-voting economic token |
| [contracts/tokens/DAOShipVotes.sol](../contracts/tokens/DAOShipVotes.sol) | 321 | Delegation & checkpoints |
| [contracts/tokens/DAOShipPermit.sol](../contracts/tokens/DAOShipPermit.sol) | 84 | EIP-2612 permit (clone-safe) |
| [contracts/navigators/BaseNavigator.sol](../contracts/navigators/BaseNavigator.sol) | 186 | Navigator base w/ allowlist |
| [contracts/navigators/OnboarderNavigator.sol](../contracts/navigators/OnboarderNavigator.sol) | 203 | ETH-based onboarding |
| [contracts/navigators/ERC20TributeNavigator.sol](../contracts/navigators/ERC20TributeNavigator.sol) | 224 | ERC20-based onboarding |
| [contracts/libraries/DAOShipUtils.sol](../contracts/libraries/DAOShipUtils.sol) | 80 | Shared utilities |

**Supporting**: ~12K lines of test code across [test/unit/](../test/unit/) and [test/e2e/](../test/e2e/), deployment scripts (`scripts/deploy/`, `scripts/deploy-all.ts`), and Hardhat configuration.

---

## 3. Threat Model

### System Architecture

- **DAOShip** (governance module) controls a **Quai Vault** (treasury/avatar) via `execTransactionFromModule`
- **SharesERC20** (voting token with delegation) and **LootERC20** (non-voting economic token) — both `onlyOwner`-gated for mint/burn/pause, with DAOShip as the sole owner
- **Navigators** (extension contracts) with tiered permissions: `ADMIN(1)`, `MANAGER(2)`, `GOVERNOR(4)` — bitmask-combinable
- **Launchers** (factory contracts) deploy EIP-1167 minimal proxies for DAOShip + tokens

### Trust Boundaries

| Boundary | From | To | Mechanism |
|----------|------|----|-----------|
| External → DAO | Public users | DAOShip | `proposalOffering`, `sponsorThreshold` |
| DAO → Treasury | DAOShip module | Quai Vault | `isModuleEnabled` + `execTransactionFromModule` |
| Navigator → DAO | Navigator contracts | DAOShip | `navigators[addr]` bitmask |
| Governance → Config | Proposals | DAOShip state | `governanceOnly` modifier + proposal lifecycle |
| Admin → Tokens | ADMIN navigators | SharesERC20/LootERC20 | `onlyAdmin` (pause/unpause) |
| Manager → Supply | MANAGER navigators | SharesERC20/LootERC20 | `onlyManager` (mint/burn) |

### High-Value Targets

1. **Treasury (Quai Vault)** — All funds held by the DAO
2. **Token supply control** — Minting shares dilutes existing members
3. **Navigator permissions** — Privilege escalation to ADMIN/MANAGER/GOVERNOR
4. **Governance parameters** — Quorum, voting period, retention thresholds
5. **Proposal execution** — Arbitrary code execution through the vault

### Trusted Roles

`ADMIN`, `MANAGER`, and `GOVERNOR` navigators are **trusted contracts appointed by governance**. They are not arbitrary external actors. An attack that requires one of these roles to be malicious is a trust-model concern, not an exploit — governance is expected to revoke compromised navigators via proposal (`setNavigators([addr], [0])`).

---

## 4. Findings Summary

### Post-Validation Counts (final)

| Severity | Unresolved | Resolved/Dismissed in this session | Change from Initial |
|----------|------------|------------------------------------|---------------------|
| Critical | **0** | 1 (C-1 resolved via staged-script cleanup) | −1 |
| High | **0** | — | **−3** (all reclassified via validation pass) |
| Medium | **0** | — | **−5** (four demoted/removed in validation pass, one removed in design-intent pass) |
| Low | **0** | 1 (L-1 dismissed — testnet-only, gitignored, out of scope) | **−7** |
| Informational | 18 | — | **+5** (net additions from demotions) |
| **Removed (invalid)** | 7 | — | — |

**Net result: zero unresolved findings at any severity.**

### Findings Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| [C-1](#c-1-legacy-staged-deploy-scripts-rotted-past-usability--resolved) | ~~Critical~~ Low (retroactively) | Legacy staged deploy scripts rotted past usability | **Resolved** |
| [L-1](#l-1-plaintext-private-keys-in-env-and-enve2e) | Low | Plaintext private keys in `.env` / `.env.e2e` (testnet-only, operational) | **Dismissed** (out of scope — testnet-only, properly gitignored) |
| [I-1](#i-1-totalshares--totalloot-cache-is-architecturally-safe) | Info | `totalShares` / `totalLoot` cache is architecturally safe |  |
| [I-2](#i-2-ragequit-callback-defense-via-balance-snapshot-documented) | Info | Ragequit callback defense via balance snapshot (documented) |  |
| [I-3](#i-3-navigator-locks-are-grant-only-by-design) | Info | Navigator locks are grant-only by design |  |
| [I-4](#i-4-navigator-pauseunpause-by-avatar-is-intentional) | Info | Navigator `pause`/`unpause` by avatar is intentional |  |
| [I-5](#i-5-erc-777-tribute-already-defended-by-balance-delta-check) | Info | ERC-777 tribute already defended by balance-delta check |  |
| [I-6](#i-6-proposalcount-uint32-overflow-is-unreachable) | Info | `proposalCount` uint32 overflow is unreachable |  |
| [I-7](#i-7-_effectivesponsorthreshold-zero-behavior-is-documented) | Info | `_effectiveSponsorThreshold` zero behavior is documented |  |
| [I-8](#i-8-front-running-sponsorproposal-already-mitigated) | Info | Front-running `sponsorProposal` already mitigated |  |
| [I-9](#i-9-launcher-full-decodere-encode-gas-overhead) | Info | Launcher full decode/re-encode gas overhead |  |
| [I-10](#i-10-yesvotesnovotes-uint32-theoretical-overflow) | Info | `yesVotes` / `noVotes` uint32 theoretical overflow |  |
| [I-11](#i-11-correctly-implemented-flash-loan-protection) | Info | Correctly implemented flash-loan protection |  |
| [I-12](#i-12-correctly-implemented-quorum-snapshot-denominator) | Info | Correctly implemented quorum snapshot (denominator) |  |
| [I-13](#i-13-correctly-implemented-oog-griefing-protection) | Info | Correctly implemented OOG griefing protection |  |
| [I-14](#i-14-correctly-implemented-post-execution-module-check) | Info | Correctly implemented post-execution module check |  |
| [I-15](#i-15-correctly-implemented-permit-for-eip-1167-clones) | Info | Correctly implemented Permit for EIP-1167 clones |  |
| [I-16](#i-16-correctly-implemented-merkle-proof-double-hashing-create2-salt-and-singleton-bricking) | Info | Merkle, CREATE2 salt, and singleton bricking all correct |  |
| [I-17](#i-17-live-read-of-governance-parameters-is-documented-design) | Info | Live-read of governance parameters is documented design (SECURITY_GUIDE.md §M-4) |  |
| [I-18](#i-18-mintburn-batch-arrays-are-intentionally-uncapped) | Info | Mint/burn batch arrays are intentionally uncapped (NatSpec added) | Applied |

---

## 5. Critical Findings

### C-1: Legacy Staged Deploy Scripts Rotted Past Usability — RESOLVED

**Files** (all now deleted):
- ~~`scripts/deploy/001_deploy_poster.ts`~~
- ~~`scripts/deploy/002_deploy_singletons.ts`~~
- ~~`scripts/deploy/003_deploy_factories.ts`~~

**Still present and working**: [scripts/deploy/004_deploy_navigators.ts](../scripts/deploy/004_deploy_navigators.ts)
**Canonical path**: [scripts/deploy-all.ts](../scripts/deploy-all.ts)
**Status**: **Resolved** in this audit session (commit pending)

**Original framing**

The initial audit flagged a single issue: `scripts/deploy/003_deploy_factories.ts:70-73` passed only two arguments to the three-argument `DAOShipAndVaultLauncher` constructor, causing the script to abort at runtime. Severity was assigned as Critical on the assumption that the script was an active deployment path.

**What the deep validation revealed**

The original framing was too narrow. A full analysis of the `scripts/deploy/` directory against `scripts/deploy-all.ts` turned up six structural problems in `001`, `002`, and `003`:

1. **Wrong SDK** — all three imported `ethers from "hardhat"` and used `ethers.getContractFactory(...)`. The canonical `deploy-all.ts` uses `quais.ContractFactory(...)` from the `quais` library, which handles Quai Network's shard-specific addressing. Plain ethers deployments do not produce valid cyprus1 addresses.
2. **No IPFS metadata publishing** — none of the three called `hre.deployMetadata.pushMetadataToIPFSWithBytecode(...)` before deployment. `deploy-all.ts` publishes metadata for every contract it deploys, which is required for source verification on the Quai explorer.
3. **Missing `--network` flag** — `deploy:poster`, `deploy:singletons`, and `deploy:factories` in [package.json](../package.json) had no `--network cyprus1` specifier, defaulting to the in-memory `hardhat` network per [hardhat.config.ts:15](../hardhat.config.ts#L15). Running any of these commands would deploy to an ephemeral network that disappears when the process exits.
4. **Missing constructor argument** in `003` (the original finding, a symptom of broader rot).
5. **Never actually used** — the `deployments/` directory contains only `deployment-complete-cyprus1-*.json` files, all produced by `deploy-all.ts`. Zero files from the `001-003` scripts exist. These scripts have never been successfully run against cyprus1 in the project's history.
6. **Duplicated `deploy-all.ts`** — all three cover subsets of what `deploy-all.ts` already does correctly.

**Important correction — `004_deploy_navigators.ts` is NOT rot**

My first pass flagged all four staged scripts as legacy code, but that was wrong. [004_deploy_navigators.ts](../scripts/deploy/004_deploy_navigators.ts) actually uses `quais.ContractFactory` + IPFS metadata + proper Quai provider setup (lines 34-35, 54-58, 81, 168-177), mirroring the `deploy-all.ts` patterns exactly. It was intentionally updated when `deploy-all.ts` was written. It handles a different concern (per-DAO navigator deployment, not platform-wide contracts) that `deploy-all.ts` does not cover, and it is referenced as a real workflow in:

- [test/e2e/onchain/OnChainDAOLifecycle.test.ts:200,461](../test/e2e/onchain/OnChainDAOLifecycle.test.ts#L200) — listed as a prerequisite for the onchain E2E test
- [scripts/deploy-all.ts:286](../scripts/deploy-all.ts#L286) — printed as the "optional next step" after a successful platform deploy
- [README.md:121](../README.md#L121) — documented in the deployment guide

So `004` is preserved.

**Actual severity assessment**

With `deploy-all.ts` working correctly (confirmed by 13+ successful cyprus1 deployments in `deployments/`), the production deployment path was never broken. The "Critical" severity rating was based on the mistaken assumption that `003_deploy_factories.ts` was an active deployment script. In reality, it was dead code exposed via a broken npm command that, if anyone had tried to run it, would have failed fast with a clear error before any misconfigured contract could be deployed.

**Correct severity retroactively**: **Low**. The canonical path was always correct; the rot was in deprecated parallel scripts that no one actually used.

**Resolution applied in this audit session**

1. Deleted [scripts/deploy/001_deploy_poster.ts](../scripts/deploy/001_deploy_poster.ts), [002_deploy_singletons.ts](../scripts/deploy/002_deploy_singletons.ts), and [003_deploy_factories.ts](../scripts/deploy/003_deploy_factories.ts).
2. Removed the corresponding `deploy:poster`, `deploy:singletons`, and `deploy:factories` entries from [package.json](../package.json). Kept `deploy:all` and `deploy:navigators`.
3. Updated the `scripts/` file tree in [README.md:223-232](../README.md#L223) to show only the surviving scripts and added clarifying comments about their roles.
4. **Did not touch `004_deploy_navigators.ts`** — it was never the problem.

**Fix safety** — every affected path verified:

- ✅ [README.md:118-123](../README.md#L118) deployment guide: already referenced only `deploy:all` and `deploy:navigators`. No user-facing documentation pointed at the deleted scripts.
- ✅ [test/e2e/onchain/OnChainDAOLifecycle.test.ts:200,461](../test/e2e/onchain/OnChainDAOLifecycle.test.ts#L200): references `npm run deploy:all && npm run deploy:navigators`. Both commands still exist and work correctly.
- ✅ [scripts/deploy-all.ts:286](../scripts/deploy-all.ts#L286): console output tells operators to run `npm run deploy:navigators` as the next step. Still works.
- ✅ No CI/CD config or documentation referenced the deleted commands.
- ✅ All four deleted files were tracked in git and are fully recoverable via `git show HEAD:scripts/deploy/...` if the team ever needs them back.
- ✅ The `deployments/` directory is unaffected — it only ever contained output from `deploy-all.ts`, which is preserved.

**Lessons from this finding**

Two things went wrong in my initial audit, both worth recording so future auditors don't repeat them:

1. **Pattern-matching on a single symptom.** I saw "missing constructor argument" and filed it as the finding without checking whether the script was actually used. A 30-second look at `deployments/` would have shown zero matching filenames and signaled that this script had never run. Always check whether a broken script is actually exercised before assigning severity.
2. **Over-generalizing from a partial read.** I scanned `004_deploy_navigators.ts` by reading only its NatSpec header and assumed its implementation matched the other three. It didn't. When claiming that N files share a problem, read all N files — don't extrapolate from one.

---

## 6. Low Severity Findings

### L-1: Plaintext Private Keys in `.env` and `.env.e2e` — DISMISSED

**Files**: `.env`, `.env.e2e` (both gitignored, neither tracked)
**Status**: **Dismissed** — out of scope; testnet-only values, properly gitignored, not used in production
**Validation pass**: deep dive on 2026-04-13

**Dismissal rationale**

After the deep dive confirmed the testnet-only nature of these keys (all target `rpc.orchard.quai.network`, confirmed via [hardhat.config.ts:41-45](../hardhat.config.ts#L41)) and the fact that `.gitignore` correctly excludes them from version control, the project owner explicitly determined that these values are not used in production and the finding is out of scope for this audit. The mainnet-tier recommendations below are preserved as forward-looking guidance but are **not action items** — they apply to a future mainnet deployment that is not part of the current codebase's concerns.

The remainder of this section is retained as reference material for future mainnet deployment planning.

**Description**

Five plaintext private keys exist on disk across two env files:

| File | Variable | Purpose |
|------|----------|---------|
| `.env` | `CYPRUS1_PK` | Testnet deployer |
| `.env.e2e` | `DEPLOYER_PK` | Testnet deployer (**duplicate of `CYPRUS1_PK` — same key value**) |
| `.env.e2e` | `ALICE_PK` | Test persona |
| `.env.e2e` | `BOB_PK` | Test persona |
| `.env.e2e` | `CAROL_PK` | Test persona |
| `.env.e2e` | `DAVE_PK` | Test persona |

**Deep validation — what these keys actually do**

1. **All keys target Orchard testnet only**, not mainnet:
   - `.env` → `RPC_URL=https://rpc.orchard.quai.network`
   - `.env.e2e` → `RPC_URL=https://rpc.orchard.quai.network`
   - Mainnet Quai would be `rpc.quai.network` — not configured anywhere in the repo
   - [hardhat.config.ts:41-45](../hardhat.config.ts#L41) defines only one keyed network (`cyprus1`), pointing at whatever `RPC_URL` is set — currently testnet

2. **The deployer key (`CYPRUS1_PK` / `DEPLOYER_PK`) is reused across dev and e2e**. Same exact hex value in both files. Low-impact since both are testnet, but violates principle of least privilege.

3. **Three scripts reference `CYPRUS1_PK`**:
   - [scripts/create-dao.ts:118](../scripts/create-dao.ts#L118)
   - [scripts/deploy-all.ts:41](../scripts/deploy-all.ts#L41)
   - [scripts/deploy/004_deploy_navigators.ts:64](../scripts/deploy/004_deploy_navigators.ts#L64)
   - All three throw a clear error if the env var is not set.

4. **Both files are correctly gitignored** (`.env`, `.env.*` with `!.env.example`, `!.env.e2e.example` exceptions). Confirmed not tracked via `git ls-files`.

5. **Templates exist** at `.env.example` and `.env.e2e.example` with placeholder values (`your_private_key_here`, `your_test_alice_private_key_here`, etc.). The intended workflow is: copy template → fill in values → never commit.

6. **The `.env` contains deployed contract addresses on Orchard testnet** (`DAOSHIP_SINGLETON=0x00298e9a...`, etc.), confirming the deployer key has been active on that network.

**Revised impact assessment**

Given the testnet-only scope, the practical risk is **near-zero**:

- Testnet QUAI is obtained free from faucets
- The deployed testnet contracts have no real value to protect
- Compromise of these keys would let an attacker redeploy (free) or mess with testnet state (no value)

The remaining concerns are **forward-looking**:

- Mainnet deployment will require a real deployer, and the team needs a clean workflow before that happens
- The `.gitignore` pattern is correct but one-off operator mistakes (backup, cloud sync, accidental `git add .env`) are still possible
- The duplicate deployer key across `.env` and `.env.e2e` means a single leaked file compromises both environments

**Recommendation — updated for testnet-only reality**

Tiered recommendations by deployment environment:

**For current testnet workflow (no urgent action needed):**
1. Consider migrating to Hardhat's [configuration variables](https://hardhat.org/hardhat-runner/docs/guides/configuration-variables) (`npx hardhat vars set CYPRUS1_PK`) for the deployer key — drop-in replacement that encrypts at rest
2. Generate a distinct e2e deployer key so `.env` and `.env.e2e` don't share the same credential (defense in depth, not a security fix)
3. Add a pre-commit scanner (`gitleaks` or `trufflehog`) as a second layer against the "oops I committed .env" mistake

**Before any mainnet deployment (blocking):**
4. Do NOT use plaintext `.env` for a mainnet deployer key. Use one of:
   - Hardware wallet (Ledger/Trezor) via Hardhat plugin
   - Encrypted keystore file with interactive passphrase
   - Cloud KMS (AWS KMS, GCP KMS) with Hardhat signer plugin
5. Add a separate `cyprus1-mainnet` network entry in `hardhat.config.ts` that does NOT read from `process.env.CYPRUS1_PK` — force the operator to supply mainnet credentials through a different (more secure) path
6. Document the mainnet deployment playbook in a new doc section (not in this audit report)

**Fix safety** — checked against existing workflows:

- ✅ Hardhat configuration variables are a drop-in replacement. Existing scripts check `process.env.CYPRUS1_PK`, which `hardhat vars` transparently supplies. No code changes needed.
- ✅ Generating a separate e2e deployer key is a one-line change in `.env.e2e`. All e2e tests read from `DEPLOYER_PK`, which is independent of `CYPRUS1_PK`.
- ✅ Pre-commit scanners have no runtime overhead and never touch production code paths.
- ✅ None of these changes modify any Solidity code or deployment logic on-chain. Pure tooling/operational.
- ⚠️ If the team ever commits to using `hardhat vars` broadly, update `.env.example` and `README.md` to document the new onboarding flow so new contributors don't waste time on the old one.

---

## 7. Informational Findings

### I-1: `totalShares` / `totalLoot` Cache Is Architecturally Safe

**Originally filed as**: H-2 (High) — "cache desync risk (mitigated, fragile)"
**Status**: Reclassified to Informational after validation

**Validation**

The initial audit claimed the cache was mitigated only "implicitly and fragile". Validation shows it is actually **architecturally impossible** to desync:

1. `SharesERC20.mint/burn/pause/unpause` are all `onlyOwner` ([SharesERC20.sol:70,81,90,98](../contracts/tokens/SharesERC20.sol#L70)).
2. The token owner is `DAOShip` (set via `initialize` in the launcher).
3. The vault (avatar) is never granted token ownership — there is no code path that calls `sharesToken.transferOwnership(avatar)`.
4. A governance proposal that tries to DelegateCall MultiSend → Call `sharesToken.mint(...)` executes with `msg.sender == vault` at the token, which fails the `onlyOwner` check.
5. A governance proposal that calls `DAOShip.mintShares(...)` via `executeAsGovernance` goes through the normal DAOShip mint path, which updates the cache.

**Conclusion**

No exploit path exists under the current architecture. The only way to desync would be to first transfer token ownership away from DAOShip, which no code path enables. Framing this as "fragile" was also imprecise — it is as robust as any `onlyOwner`-guarded state in the codebase.

**Recommendation**

Add a prominent comment at the top of `DAOShip.sol` documenting the invariant for future maintainers:

```solidity
// INVARIANT: SharesERC20 and LootERC20 ownership must never be transferred away
// from this DAOShip contract. All mint/burn paths rely on DAOShip being the sole
// owner so that totalShares / totalLoot remain in sync with token.totalSupply().
// There is currently no code path that can violate this invariant.
```

No code change is required.

---

### I-2: Ragequit Callback Defense via Balance Snapshot (Documented)

**Originally filed as**: H-3 (High) — "ragequit callback during transfer phase"
**Status**: Reclassified to Informational after validation

**Validation**

The initial audit flagged this as a high-severity issue "mitigated by snapshot". Validation shows it is already:

1. **Fully documented** in the contract at [DAOShip.sol:1509-1518](../contracts/core/DAOShip.sol#L1509) (ragequit function NatSpec) and [DAOShip.sol:1473-1478](../contracts/core/DAOShip.sol#L1473) (executeAsGovernance NatSpec).
2. **Defended via balance snapshot**: `fairShares[]` is pre-computed at lines 1575-1593 **before** any transfers begin. Even if the recipient's `receive()` callback triggers `mintShares`/`burnShares` via a MANAGER navigator, the pre-computed withdrawal amounts are authoritative.
3. **Tested** — the test suite includes a `MockRagequitCallback` contract and explicit reentrancy tests at [CoverageGaps.test.ts:3423-3725](../test/unit/CoverageGaps.test.ts#L3423) including "H-1: Ragequit balance snapshot" coverage.

**Conclusion**

This is not an unresolved issue. The snapshot-first architecture is the correct defense, it is implemented, it is documented in the source, and it is tested. No changes are required.

**Optional hardening**

A minor documentation improvement: add an inline comment right next to the snapshot loop pointing readers to the NatSpec rationale:

```solidity
// REENTRANCY DEFENSE: fairShares[] is computed from the pre-transfer balance snapshot
// (see function NatSpec). Even if `to`'s receive() triggers a MANAGER navigator mid-loop,
// the pre-computed amounts are authoritative — no economic exploit is possible.
for (uint256 i = 0; i < tokens.length; i++) {
```

---

### I-3: Navigator Locks Are Grant-Only by Design

**Originally filed as**: M-3 (Medium) — "lock bypass"
**Status**: Reclassified to Informational — documented intentional behavior

**Validation**

The initial audit flagged this as a "design risk if misunderstood". Validation shows the behavior is **extensively documented**:

- [DAOShip.sol:693-696](../contracts/core/DAOShip.sol#L693) (onlyAdmin modifier): "Locks are NOT checked here — they are enforced in setNavigators() only, matching upstream MolochV3 behavior."
- [DAOShip.sol:1425-1433](../contracts/core/DAOShip.sol#L1425) (lockAdmin): "Existing ADMIN navigators retain their powers."
- [DAOShip.sol:1435-1443](../contracts/core/DAOShip.sol#L1435) (lockManager): same.
- [DAOShip.sol:1445-1454](../contracts/core/DAOShip.sol#L1445) (lockGovernor): same.

**Conclusion**

This is documented intentional behavior matching the MolochV3 reference implementation. An operator who reads the NatSpec cannot misunderstand it. To revoke an existing navigator, governance calls `setNavigators([addr], [0])`.

**Optional improvement**

Add an explicit `revokeNavigator(address)` helper purely for readability — it would compile to the same bytecode as the current `setNavigators` pattern but make intent clearer in proposal calldata. Not required.

---

### I-4: Navigator `pause`/`unpause` by Avatar Is Intentional

**Originally filed as**: M-4 (Medium) — "multisig bypass of governance"
**Status**: Reclassified to Informational — documented intentional design

**Validation**

Verified at [BaseNavigator.sol:116-134](../contracts/navigators/BaseNavigator.sol#L116):

```solidity
/// @notice Pause onboarding
/// @dev Requires GOVERNOR navigator permission (navigators[msg.sender] & 4 != 0)
///      OR the DAO avatar. Symmetric with unpause to prevent unilateral griefing.
function pause() external {
    if ((daoShip.navigators(msg.sender) & 4) == 0 && msg.sender != daoShip.avatar()) revert NotAuthorized();
    // ...
}
```

This is explicitly commented as intentional: pause and unpause are symmetric, and the avatar — which *is* the DAO's root of authority in the Zodiac model — is authorized for both. Calling this a "multisig bypass" was a mistaken framing: in the Zodiac module pattern, the avatar is the governance authority, and the DAOShip module is the *delegated* governor for specific actions.

**Conclusion**

No change required. The design is intentional and documented.

---

### I-5: ERC-777 Tribute Already Defended by Balance-Delta Check

**Originally filed as**: M-5 (Medium) — "ERC-777 tribute token callback risk"
**Status**: Reclassified to Informational — already mitigated

**Validation**

Verified at [ERC20TributeNavigator.sol:211-217](../contracts/navigators/ERC20TributeNavigator.sol#L211):

```solidity
uint256 balanceBefore = tributeToken.balanceOf(vault);
tributeToken.safeTransferFrom(msg.sender, vault, tributeAmount);
uint256 actualReceived = tributeToken.balanceOf(vault) - balanceBefore;
if (actualReceived < tributeAmount) revert InsufficientAmount();
```

The navigator:

1. Uses `SafeERC20` for the transfer.
2. Measures `balanceOf(vault)` before and after, rejecting fee-on-transfer and many ERC-777-style tokens that divert tokens.
3. Applies `nonReentrant` to all external entry points (lines 88, 97, 131).
4. Sends tribute **directly to the vault**, not to the navigator. The vault is a standard Gnosis-Safe-derived contract with no `tokensReceived` hook, so ERC-777 callbacks have no meaningful target.

**Conclusion**

No exploit path exists. The defense is already in place and tested (see [DAOShipGaps.test.ts:1409](../test/unit/DAOShipGaps.test.ts#L1409) "ERC20TributeNavigator: fee-on-transfer (dust tribute) protection"). A documentation note recommending standard ERC-20 tokens is still worthwhile but not security-critical.

---

### I-6: `proposalCount` uint32 Overflow Is Unreachable

**File**: [DAOShip.sol:103, 915-918](../contracts/core/DAOShip.sol#L103)

`proposalCount` is `uint32` with an explicit overflow guard at line 915 (`revert ProposalLimitReached()`). 4.29 billion proposals is not reachable by any real DAO, and the guard is tested at [DAOShipGaps.test.ts:1092](../test/unit/DAOShipGaps.test.ts#L1092) using `hardhat_setStorageAt`. No action needed.

---

### I-7: `_effectiveSponsorThreshold` Zero Behavior Is Documented

**File**: [DAOShip.sol:1639-1646](../contracts/core/DAOShip.sol#L1639)

When `totalSupply == 0`, the function returns 0 (meaning anyone can sponsor, but no one has voting power). This is explicitly documented in the NatSpec at line 1631: "returns 0 to avoid deadlock on empty DAOs". A DAO in this state is effectively dead; no economic exploit is possible because there is no voting power to exploit. Documented intentional behavior.

---

### I-8: Front-Running `sponsorProposal` Already Mitigated

**File**: [DAOShip.sol:956-959](../contracts/core/DAOShip.sol#L956)

`sponsorProposal` uses `getPriorVotes(msg.sender, block.timestamp - 1)`, forcing the voting power snapshot to be from the previous second. Same-block manipulation is impossible. This is the explicit "H-4" mitigation documented at line 957 in the source. No action needed.

---

### I-9: Launcher Full Decode/Re-encode Gas Overhead

**Files**: [DAOShipLauncher.sol:116-167](../contracts/core/DAOShipLauncher.sol#L116), [DAOShipAndVaultLauncher.sol:299-341](../contracts/core/DAOShipAndVaultLauncher.sol#L299)

Both launchers decode all 13 fields of `initializationParams`, replace one or two addresses, and re-encode. An inline-assembly splice would save ~10K gas per deploy at the cost of readability.

**Fix safety**: assembly-based splice is correct only if the encoding is guaranteed to place the replaced fields at fixed offsets. With ABI-encoded dynamic arrays following fixed addresses, the offsets ARE fixed for the address fields themselves — but this makes the code much harder to reason about. **Recommend leaving as-is** unless deployment gas becomes a measurable concern. Deployment is a one-time cost per DAO.

---

### I-10: `yesVotes` / `noVotes` uint32 Theoretical Overflow

**File**: [DAOShip.sol:193-194](../contracts/core/DAOShip.sol#L193)

These count the *number of voters*, not vote weight (weight is `yesBalance`/`noBalance` as `uint256`). uint32 overflow would require ~4.29 billion individual voters on a single proposal, which is unreachable. Solidity 0.8.22 checked arithmetic would revert rather than wrap. Documentation-only observation.

---

### I-11: Correctly Implemented Flash-Loan Protection

Verified at [DAOShip.sol:891-894, 956-958, 1034, 1166-1170](../contracts/core/DAOShip.sol#L891):

- `submitProposal` uses `getPriorVotes(msg.sender, block.timestamp - 1)` for self-sponsor.
- `sponsorProposal` same.
- Voting at `_submitVote` uses `getPriorVotes(msg.sender, prop.votingStarts)`.
- `cancelProposal` uses `getPriorVotes(prop.sponsor, block.timestamp - 1)` to check sponsor retention.

Together these prevent flash-loan borrowers from manipulating voting power in the same block. Labeled "H-4" / "M-6" in-source.

---

### I-12: Correctly Implemented Quorum Snapshot (Denominator)

The quorum **denominator** (`maxTotalSharesAtSponsor`) is correctly snapshotted at sponsor time ([DAOShip.sol:988](../contracts/core/DAOShip.sol#L988), labeled "C-1 fix"). The percentage factor (`quorumPercent`) is read live at evaluation time — this is an intentional design decision documented in `SECURITY_GUIDE.md §M-4`. See [I-17](#i-17-live-read-of-governance-parameters-is-documented-design) for the full rationale.

---

### I-13: Correctly Implemented OOG Griefing Protection

Verified at [DAOShip.sol:1122-1131](../contracts/core/DAOShip.sol#L1122). If `processProposal`'s try/catch catches a revert and `gasleft() < 50_000`, it reverts the entire transaction with `InsufficientProcessGas` rather than marking `actionFailed`. This prevents a griefing caller from bricking a proposal by starving it of gas. Labeled "M-1 fix" in-source.

---

### I-14: Correctly Implemented Post-Execution Module Check

Verified at [DAOShip.sol:1139-1145](../contracts/core/DAOShip.sol#L1139). After proposal execution, the contract verifies it is still an enabled module on the vault. This prevents a proposal from removing DAOShip as a module (which would permanently brick governance). The offending proposal reverts; the DAO stays operational. Labeled "M-7 fix" in-source.

---

### I-15: Correctly Implemented Permit for EIP-1167 Clones

Verified at [DAOShipPermit.sol:79-83](../contracts/tokens/DAOShipPermit.sol#L79):

```solidity
function _domainSeparatorV4() internal view returns (bytes32) {
    return keccak256(
        abi.encode(_TYPE_HASH, keccak256(bytes(name())), _HASHED_VERSION, block.chainid, address(this))
    );
}
```

Recomputes from storage-based `name()` rather than caching in an immutable — correct for clones. Uses `ECDSA.recover` (returns `address(0)` for invalid signatures, failing the `signer != owner` check) and `Nonces._useNonce()` for replay protection. The ~2K gas per call is an accepted tradeoff.

---

### I-16: Correctly Implemented Merkle Proof Double-Hashing, CREATE2 Salt, and Singleton Bricking

**Merkle allowlist** — [BaseNavigator.sol:147](../contracts/navigators/BaseNavigator.sol#L147):
```solidity
keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))
```
OpenZeppelin-recommended double-hash pattern.

**CREATE2 salt** — [DAOShipLauncher.sol:139,140,143](../contracts/core/DAOShipLauncher.sol#L139):
```solidity
keccak256(abi.encodePacked(msg.sender, sharesSalt))
```
Includes `msg.sender`, preventing front-running of deterministic addresses.

**Singleton bricking** — [DAOShip.sol:527-530](../contracts/core/DAOShip.sol#L527), [SharesERC20.sol:45](../contracts/tokens/SharesERC20.sol#L45), [LootERC20.sol:49](../contracts/tokens/LootERC20.sol#L49). DAOShip singleton constructor sets `avatar = 0xdead` (blocks setUp); token singletons call `renounceOwnership()` (blocks initialize). Clones have zeroed storage and initialize normally.

All three patterns confirmed correct. No action needed.

---

### I-17: Live-Read of Governance Parameters Is Documented Design

**Originally filed as**: M-1 (Medium) — "`quorumPercent` not snapshotted at sponsor time"
**Status**: Reclassified to Informational after design-intent pass — explicitly documented in [SECURITY_GUIDE.md §M-4](../SECURITY_GUIDE.md)

**Validation**

The initial audit flagged `quorumPercent` being read live (not snapshotted) in `_didProposalPass` ([DAOShip.sol:1195](../contracts/core/DAOShip.sol#L1195)) as a governance-integrity concern. The design-intent pass revealed this was already documented as an intentional decision in the team's own `SECURITY_GUIDE.md`.

**What the design doc says**

From `SECURITY_GUIDE.md` section **M-4: Governance config changes retroactively affect in-flight proposals**:

> Governance parameters are read from live storage at evaluation time, not snapshotted at sponsor time. This means changes to `quorumPercent`, `votingPeriod`, `gracePeriod`, `defaultExpiryWindow`, and `minRetentionPercent` retroactively affect all in-flight proposals. This matches upstream MolochV3 (Baal) behavior.
>
> **Why this is accepted:** This is the GOVERNOR trust model — GOVERNOR navigators (and governance proposals that change config) are explicitly trusted to manage parameters. Snapshotting each parameter at sponsor time would deviate from MolochV3 and add significant storage overhead (multiple new fields per Proposal struct). The scenario requires a GOVERNOR config change during an active vote, which is an explicit trust delegation.

**The full list of live-read parameters**

It is not just `quorumPercent` — five parameters follow the same live-read pattern, all by design:

| Parameter | Read at | Behavior when changed mid-flight |
|-----------|---------|----------------------------------|
| `quorumPercent` | `_didProposalPass` ([line 1195](../contracts/core/DAOShip.sol#L1195)) | Raising can defeat a passing proposal; lowering can pass a failing one |
| `minRetentionPercent` | `processProposal` retention check ([line 1097](../contracts/core/DAOShip.sol#L1097)) | Raising can defeat a proposal that would have survived the old threshold |
| `defaultExpiryWindow` | `state()` auto-expiry ([line 775](../contracts/core/DAOShip.sol#L775)) | Shortening can expire Ready proposals; lengthening can revive expired ones |
| `votingPeriod` / `gracePeriod` | `state()` auto-expiry fallback ([line 777](../contracts/core/DAOShip.sol#L777)) | Same auto-expiry impact as `defaultExpiryWindow` |

The `Proposal` struct DOES snapshot the **denominator** (`maxTotalSharesAtSponsor`) for quorum — that's the "C-1 fix" labeled in the source. The percentage factors are deliberately left live. This is a consistent, considered design choice, not an oversight.

**Why the team's decision is defensible**

1. **Trust model coherence** — GOVERNOR exists specifically to change governance parameters. If you don't trust your GOVERNOR, don't grant the role. The guardrail is on *who holds* GOVERNOR, not on what GOVERNOR can do.
2. **MolochV3 parity** — Baal behaves the same way. Divergence adds review surface for auditors familiar with the Moloch lineage, for no net security gain under the stated trust model.
3. **Storage cost** — snapshotting all five parameters per proposal would add meaningful slot cost (roughly 5 extra slots per proposal unless aggressively packed). My initial fix proposal glossed over this by assuming only `quorumPercent` needed snapshotting.
4. **Operator escape hatch documented** — the guide tells operators to use explicit `expiration` timestamps on proposals if they want immunity from the `defaultExpiryWindow` variant.

**Correction to my prior recommendation**

My original M-1 fix was flawed in three ways, now acknowledged:

1. **Incomplete**: I only proposed snapshotting `quorumPercent`. To be consistent, all five live-read parameters would need the same treatment.
2. **Storage claim wrong**: I claimed the fix could fit "at zero additional slot cost" by packing a `uint32` into slot-3 padding. That's true for one parameter. Five parameters do not fit.
3. **Missed the trust model argument**: the team's design is *coherent* — the answer to "what if GOVERNOR front-runs the proposal" is "GOVERNOR is trusted; if you don't trust GOVERNOR, don't grant the role." That's a defensible position for a MolochV3 successor.

**Conclusion**

No action required. This is documented, intentional, and internally consistent. The recommendation is purely that future auditors cross-reference `SECURITY_GUIDE.md §M-4` before re-filing this finding.

---

### I-18: Mint/Burn Batch Arrays Are Intentionally Uncapped

**Originally filed as**: L-2 (Low) — "mint/burn batch size inconsistent with other caps"
**Status**: Reclassified to Informational after a deeper analysis of fix cost vs. benefit
**Applied**: NatSpec documentation added to all four functions

**What the deep validation revealed**

The four batch functions (`mintShares`, `mintLoot`, `burnShares`, `burnLoot`) accept unbounded array inputs. This initially looked like a consistency gap versus `MAX_NAVIGATORS_PER_CALL = 20` on `setNavigators`. A full caller enumeration and threat analysis showed that:

1. **No exploit path exists.** Every scenario I could construct resolved to "tx reverts atomically, no state corruption":
   - Malicious MANAGER passes huge array → caller pays gas, self-harm only, no DoS vector
   - Governance proposal bundles oversized mint → `processProposal` try/catch handles it via `actionFailed = true` (worst case: one wasted proposal slot; DAO is never bricked)
   - Partial-loop OOG → EVM atomicity reverts the entire tx, including the `totalShares += total` cache update after the loop
   - `totalShares` / `totalLoot` cache desync → impossible, cache is updated outside the loop and reverts atomically
2. **No real caller needs a cap.** Caller enumeration across contracts, tests, and scripts found a maximum batch size of 2 anywhere in the codebase (and that's only in negative tests exercising `LengthMismatch`). `BaseNavigator._mintSharesAndLoot` hardcodes length-1 arrays. No script builds larger batches.
3. **A cap would add a subtle trap.** Any future navigator or off-chain proposal builder that exceeds the cap would silently fail with `actionFailed = true`, burning a governance proposal slot. This replaces unpredictable OOG failures with predictable-but-irreversible ones — a wash.
4. **Capping diverges from MolochV3 / Baal.** Upstream has no such cap; adding one would be another divergence to track in `DAOSHIPS_VS_ZODIAC_BAAL.md` for no concrete security gain.

**Why the `MAX_NAVIGATORS_PER_CALL` analogy doesn't hold**

`setNavigators` caps its batch because each entry manipulates critical permission state (~50K+ gas per entry with bitmask writes and event emission), and a large batch could legitimately affect gas-sensitive governance paths. Mint/burn is cheaper per-entry and less privileged — MANAGER navigators are specifically trusted to mint and burn. The structural similarity is superficial.

**Applied documentation**

Rather than adding a code cap, the NatSpec on all four functions now explicitly documents:

- The intentional uncapping decision
- The gas-bounding and atomicity guarantees that make it safe
- Operator guidance for large batches via governance proposals (split into MultiSend sub-calls)
- A cross-reference from `mintLoot` / `burnShares` / `burnLoot` to `mintShares` for the full rationale

See [DAOShip.sol:1208-1218](../contracts/core/DAOShip.sol#L1208), [DAOShip.sol:1232-1239](../contracts/core/DAOShip.sol#L1232), [DAOShip.sol:1254-1262](../contracts/core/DAOShip.sol#L1254), and [DAOShip.sol:1283-1291](../contracts/core/DAOShip.sol#L1283).

**Conclusion**

No code cap is warranted. The unbounded arrays are safe under every constructed scenario. Future auditors should not re-file this finding without first constructing a concrete exploit path (I could not).

---

## 8. Scalability Analysis

**Rating: Good** (unchanged from initial audit)

### Storage Patterns

- `Proposal` struct is well-packed across 3 storage slots. Slot 3 retains 21 bytes of padding — available for future additions if needed.
- `proposals` mapping provides O(1) access.
- `_guildTokenList` is bounded at 20 entries.
- `navigators` mapping uses bitmask permissions for compact storage.

### Loop Bounds

| Location | Bound | Notes |
|----------|-------|-------|
| Navigator setup | `MAX_NAVIGATORS_PER_CALL = 20` | Enforced |
| Guild tokens | `MAX_GUILD_TOKENS = 20` | Enforced |
| Ragequit token iteration | `tokens.length` | Caller-controlled, validated against `guildTokens` map |
| `mintShares` / `mintLoot` / `burnShares` / `burnLoot` | Unbounded by design | See [I-18](#i-18-mintburn-batch-arrays-are-intentionally-uncapped) — gas-bounded via caller budget + block limit; safe under all constructed scenarios |

### Proxy Pattern

EIP-1167 minimal proxies for DAOShip, SharesERC20, LootERC20 clones. ~300K gas per clone vs ~4M for full deployment. `setUp()` guarded by `avatar != address(0)`; singleton constructor sets `avatar = 0xdead`. Token singletons `renounceOwnership()` in constructor.

### Checkpoint Growth

`DAOShipVotes._checkpoints` grows unboundedly over time, but same-timestamp checkpoints collapse ([DAOShipVotes.sol:245](../contracts/tokens/DAOShipVotes.sol#L245)) — growth limited to one checkpoint per block per account. Binary search in `_checkpointsLookup` is O(log n). Not a concern.

---

## 9. Stability Analysis

**Rating: Excellent** (unchanged from initial audit)

### State Machine Correctness

The proposal lifecycle (Unborn → Submitted → Voting → Grace → Ready → Processed / Defeated / Expired) is correctly implemented in `state()` ([DAOShip.sol:738-783](../contracts/core/DAOShip.sol#L738)) with correct priority ordering.

### Invariants

1. `totalShares == sharesToken.totalSupply()` — architecturally enforced (see [I-1](#i-1-totalshares--totalloot-cache-is-architecturally-safe))
2. `totalLoot == lootToken.totalSupply()` — same
3. `_guildTokenList` mirrors `guildTokens` mapping — maintained by `setGuildTokens` and `setUp`
4. `proposalCount` is monotonically increasing — enforced by increment-only logic with overflow revert

### Test Coverage

The validation pass confirmed the test suite covers every edge case initially listed as "missing":

- ✅ Delegation after ragequit and rejoin — [DAOShip.test.ts:803-848](../test/unit/DAOShip.test.ts#L803) ("Gap 7: auto-delegation fix on re-join")
- ✅ Proposal expiration exactly at boundary — [DAOShip.test.ts:988-993](../test/unit/DAOShip.test.ts#L988)
- ✅ ERC20 tribute with fee-on-transfer tokens — [DAOShipGaps.test.ts:1409](../test/unit/DAOShipGaps.test.ts#L1409)
- ✅ `proposalCount` uint32 overflow — [DAOShipGaps.test.ts:1092-1142](../test/unit/DAOShipGaps.test.ts#L1092) (uses `hardhat_setStorageAt` to force the boundary)
- ✅ `convertSharesToLoot` — [DAOShip.test.ts:1126-1210](../test/unit/DAOShip.test.ts#L1126)
- ✅ Multi-ERC20 ragequit — [CoverageGaps.test.ts:780](../test/unit/CoverageGaps.test.ts#L780)
- ✅ Ragequit reentrancy — [CoverageGaps.test.ts:3423](../test/unit/CoverageGaps.test.ts#L3423)
- ✅ Ragequit balance snapshot (H-1 fix) — [CoverageGaps.test.ts:3723](../test/unit/CoverageGaps.test.ts#L3723)

The initial audit's L-7 "missing tests" finding was **invalidated** — the suite already covers everything suggested.

---

## 10. Efficiency Analysis

**Rating: Good** (unchanged)

### Storage Layout

Well-packed across all contracts. The `Proposal` struct has 21 bytes of padding in slot 3, available for future additions if needed. (The design-intent pass confirmed that governance parameters are intentionally *not* snapshotted per proposal — see [I-17](#i-17-live-read-of-governance-parameters-is-documented-design).)

### Optimization Opportunities (unchanged)

| # | Opportunity | Estimated Savings | Priority |
|---|-------------|-------------------|----------|
| 1 | `unchecked { ++i; }` in bounded loops | ~30 gas/iteration | Low |
| 2 | Assembly-based avatar field replacement in launchers | ~10K gas/deploy | Skip (see [I-9](#i-9-launcher-full-decodere-encode-gas-overhead)) |
| 3 | Cache `daoShip.avatar()` in `_onboard` when called multiple times | ~200 gas/call | Low |
| 4 | Cache `totalShares`/`totalLoot` sums across `submitVotes` batch | Variable | Skip — added complexity |

---

## 11. Succinctness Analysis

**Rating: Very Good** (unchanged)

- Clear section headers and comprehensive NatSpec on every public/external function
- Security mitigations are labeled inline (`H-1`, `C-1`, etc.) cross-referencing prior review cycles
- Bit-flag `statusFlags` pattern for compact proposal state
- Bitmask navigator permissions (clean, gas-efficient, extensible)
- Custom errors throughout
- No dead code identified
- Defensive-but-not-redundant checks (e.g., `prop.id == 0` early return in `cancelProposal` is a gas optimization, not redundancy)

---

## 12. Priority Action Items

### Applied in this audit session

1. **[C-1 — RESOLVED]** Deleted legacy staged deploy scripts `001_deploy_poster.ts`, `002_deploy_singletons.ts`, `003_deploy_factories.ts`. Removed corresponding npm entries from `package.json`. Updated README file-structure diagram. Preserved `004_deploy_navigators.ts` (which correctly uses `quais.ContractFactory`). The canonical `scripts/deploy-all.ts` + `scripts/deploy/004_deploy_navigators.ts` deployment flow is unchanged and was never broken.
2. **[I-18 — APPLIED]** Added NatSpec to all four batch mint/burn functions documenting why the arrays are intentionally uncapped, the gas-bounding and atomicity guarantees, and operator guidance for large batches via MultiSend sub-call splitting. See [DAOShip.sol:1208-1218](../contracts/core/DAOShip.sol#L1208).

### Out of scope (explicitly dismissed)

3. **[L-1 — DISMISSED]** Plaintext private keys in `.env` / `.env.e2e` are out of scope: testnet-only values, properly gitignored, not used in production. Forward-looking guidance for future mainnet deployment is retained in the [L-1 section](#l-1-plaintext-private-keys-in-env-and-enve2e-dismissed) as reference material.

### Documentation polish (optional, non-blocking)

4. Add an invariant comment at the top of `DAOShip.sol` ([I-1](#i-1-totalshares--totalloot-cache-is-architecturally-safe)) stating that token ownership must remain with DAOShip.
5. Add an inline comment above the `ragequit` snapshot loop ([I-2](#i-2-ragequit-callback-defense-via-balance-snapshot-documented)) pointing to the NatSpec for the reentrancy rationale.

### Optional (safe to skip)

- `unchecked { ++i; }` in bounded loops for minor gas savings.
- Assembly splice in launchers — not recommended (readability loss outweighs gas savings on a one-time cost path).

### Explicitly NOT recommended

- **Do not snapshot `quorumPercent` or other governance parameters per proposal.** The team has considered and rejected this, documented in [SECURITY_GUIDE.md §M-4](../SECURITY_GUIDE.md). See [I-17](#i-17-live-read-of-governance-parameters-is-documented-design) for the rationale. Changing this would break MolochV3 parity and add significant storage overhead for a benefit that is not present under the stated trust model.
- **Do not add a `MAX_MINT_BURN_BATCH` cap to the batch mint/burn functions.** Deep validation showed no exploit path exists under the current unbounded design; adding a cap would replace unpredictable OOG failures with predictable-but-irreversible `actionFailed` states for no security gain, and would add a subtle trap for future callers. See [I-18](#i-18-mintburn-batch-arrays-are-intentionally-uncapped) for the full analysis. The NatSpec on all four functions now documents the design decision inline.
- **Do not cap `_initMembers` in `setUp()`.** One-shot call, no DoS vector, and capping would block legitimate large-community airdrop launches.
- **Do not resurrect `001_deploy_poster.ts` / `002_deploy_singletons.ts` / `003_deploy_factories.ts`.** They were deleted for cause — wrong SDK (`ethers` instead of `quais`), missing IPFS metadata, missing `--network` flag, and in the case of 003, a missing constructor argument. If the team ever needs a partial-redeploy capability (redeploy factories without touching singletons), it should be built fresh on top of the `deploy-all.ts` / `004_deploy_navigators.ts` patterns, not by reviving the deleted rot.

---

## Appendix A: Removed Findings

During the validation and design-intent passes, the following initial findings were removed because they did not hold up against the code or against documented design decisions. They are documented here so future reviewers know they were considered and why they were dismissed.

### Removed: H-1 (initial severity) — Private Key in `.env`

**Reason for removal**: Severity overstated. Reclassified as [L-1](#l-1-plaintext-private-key-in-env). The `.env` file is correctly gitignored, and this is the standard Hardhat development pattern. The finding is retained but demoted — the operational recommendation still applies.

### Removed: H-2 (initial severity) — `totalShares` / `totalLoot` Cache Desync Risk

**Reason for removal**: Framing was incorrect. Reclassified as [I-1](#i-1-totalshares--totalloot-cache-is-architecturally-safe). Validation showed the cache is architecturally protected by the `onlyOwner` modifiers on the tokens combined with the fact that no code path transfers token ownership away from DAOShip. The "fragile" descriptor was also imprecise — this invariant is as robust as any other `onlyOwner`-guarded state.

### Removed: H-3 (initial severity) — Ragequit Callback During Transfer Phase

**Reason for removal**: Already fully documented and mitigated. Reclassified as [I-2](#i-2-ragequit-callback-defense-via-balance-snapshot-documented). The snapshot-first pattern is the correct defense, implemented at [DAOShip.sol:1575-1593](../contracts/core/DAOShip.sol#L1575), documented in the function NatSpec, and tested in `CoverageGaps.test.ts`.

### Removed: M-3 (initial severity) — Navigator Lock Bypass

**Reason for removal**: Documented intentional MolochV3-compatible behavior. Reclassified as [I-3](#i-3-navigator-locks-are-grant-only-by-design). The behavior is explicitly commented on every modifier and every `lockXxx` function.

### Removed: M-4 (initial severity) — Navigator Pause Multisig Bypass

**Reason for removal**: The framing was wrong. In the Zodiac module pattern, the avatar **is** the DAO's authority — calling this a "multisig bypass of governance" misrepresents the architecture. Reclassified as [I-4](#i-4-navigator-pauseunpause-by-avatar-is-intentional). The code comment explicitly documents the symmetric design.

### Removed: M-5 (initial severity) — ERC-777 Tribute Token Callback Risk

**Reason for removal**: Already defended. Reclassified as [I-5](#i-5-erc-777-tribute-already-defended-by-balance-delta-check). The balance-delta check after `safeTransferFrom` rejects any token that doesn't deliver the exact amount, including most ERC-777 weirdness. Tested at `DAOShipGaps.test.ts:1409`.

### Removed: L-2 (initial severity) — `_effectiveSponsorThreshold` Returns 0 on Empty DAO

**Reason for removal**: Documented intentional behavior. Reclassified as [I-7](#i-7-_effectivesponsorthreshold-zero-behavior-is-documented). The NatSpec at [DAOShip.sol:1631](../contracts/core/DAOShip.sol#L1631) explicitly says "returns 0 to avoid deadlock on empty DAOs". An empty DAO cannot pass proposals anyway (no voting power).

### Removed: L-3 (initial severity) — Front-Running `sponsorProposal`

**Reason for removal**: Already mitigated. Reclassified as [I-8](#i-8-front-running-sponsorproposal-already-mitigated). The `block.timestamp - 1` snapshot pattern is the standard defense and is explicitly labeled "H-4" in source.

### Removed: L-5 (initial severity) — `setGuildTokens` O(n) Linear Removal Scan

**Reason for removal**: Non-issue. The scan is bounded to `MAX_GUILD_TOKENS = 20` entries, which is well within gas budgets. Listing it as a finding was noise.

### Removed: L-6 (initial severity) — `OnboarderNavigator` Refund Failure Edge Case

**Reason for removal**: Already handled. If the refund fails, the entire `_onboard` call reverts (no ETH accumulates), and [OnboarderNavigator.sol:121](../contracts/navigators/OnboarderNavigator.sol#L121) provides `withdrawStuckETH` as a recovery safety valve. The scenario described in the initial finding was non-exploitable and already gracefully handled.

### Removed: L-7 (initial severity) — Missing Edge-Case Test Scenarios

**Reason for removal**: All the suggested tests already exist. See [Stability Analysis § Test Coverage](#test-coverage) for specific file/line references. The initial finding was speculation; the validation pass confirmed every item on the list was already covered by `DAOShip.test.ts`, `DAOShipGaps.test.ts`, or `CoverageGaps.test.ts`.

### Removed: M-1 (validation-pass severity) — `quorumPercent` Not Snapshotted at Sponsor Time

**Reason for removal**: Documented intentional design. Reclassified as [I-17](#i-17-live-read-of-governance-parameters-is-documented-design). The design-intent pass invalidated it.

The team's own [SECURITY_GUIDE.md §M-4](../SECURITY_GUIDE.md) explicitly documents that governance parameters are read live from storage at evaluation time, not snapshotted at sponsor time, and that this is a deliberate decision based on:
1. MolochV3 / Baal parity
2. The GOVERNOR trust model (GOVERNOR is trusted to manage parameters)
3. Storage overhead (snapshotting all five live-read parameters per proposal would add significant per-proposal cost)

My original M-1 fix proposal had three errors: it only addressed `quorumPercent` (ignoring the four other parameters that follow the same pattern), it incorrectly claimed the fix could fit in slot-3 padding at zero cost (true for one parameter, not five), and it missed the trust-model argument entirely. See I-17 for the full rationale.

**Lesson**: Future auditors should read `SECURITY_GUIDE.md` and `DAOSHIPS_VS_ZODIAC_BAAL.md` *before* filing governance-design findings, not after. Those docs are the team's record of deliberate divergences and acceptances.

### Removed: L-2 (deep-dive severity) — Mint/Burn Batch Size Not Capped

**Reason for removal**: The deep-dive pass on Low findings revealed that the "unbounded array is bad" pattern match did not translate to any concrete exploit or correctness issue. Every scenario I could construct — malicious MANAGER, governance proposal OOG, partial-loop failure, cache desync — resolved to "tx reverts atomically, no corruption, DAO not bricked". Reclassified as [I-18](#i-18-mintburn-batch-arrays-are-intentionally-uncapped).

Crucially, adding a cap would have been **worse than doing nothing** in one specific way: it would replace unpredictable OOG failures (sometimes you're lucky, sometimes you're not) with predictable-but-irreversible `actionFailed` states that consume a governance proposal slot. That's a wash at best, a regression at worst. It would also add a subtle trap for any future navigator or off-chain tooling that doesn't know about the cap.

Instead of a code change, the four batch functions now have NatSpec documentation explaining the intentional uncapping decision, the gas-bounding guarantees, and operator guidance for large batches via MultiSend sub-call splitting. See [DAOShip.sol:1208-1218](../contracts/core/DAOShip.sol#L1208).

**Lesson**: "Consistency with an existing cap" is not by itself a reason to add a cap. The existing `MAX_NAVIGATORS_PER_CALL = 20` exists because navigator permission manipulation is gas-heavy and privileged; mint/burn is neither. Pattern-matching on "similar shape" across functions with different semantics produces noise findings.

---

## Conclusion

After five review passes — initial audit, code validation, design-intent check, Low-severity deep dive, and C-1 structural validation — every finding has been resolved, dismissed, or explicitly justified as out of scope:

- **C-1** (originally flagged Critical) was **resolved** in this session. Deep validation revealed it was not a production deployment bug but rotting legacy scripts that duplicated `deploy-all.ts`. Cleanup applied: three staged scripts deleted, `004_deploy_navigators.ts` preserved (it was always correct), `package.json` tidied, README updated.
- **L-1** was **dismissed** as out of scope: testnet-only values, properly gitignored, not used in production. The project owner confirmed the scope.
- **L-2** was **reclassified to Informational ([I-18](#i-18-mintburn-batch-arrays-are-intentionally-uncapped))** after deep analysis showed no exploit path exists and that adding a cap would introduce a subtle trap for future callers. NatSpec was added to all four batch functions to document the design decision inline.
- **M-1** was **invalidated by the design-intent pass**: the live-read of governance parameters is explicitly documented in [SECURITY_GUIDE.md §M-4](../SECURITY_GUIDE.md) as an intentional decision (MolochV3 parity + GOVERNOR trust model + storage cost).
- All **High and Medium findings** from the initial audit were reclassified to Informational after validation against the actual code.

**Final Summary Score**:

| Severity | Unresolved | Notes |
|----------|------------|-------|
| Critical | **0** | — |
| High | **0** | — |
| Medium | **0** | — |
| Low | **0** | — |
| Informational | 18 | Recognition of correctly-implemented patterns + documented design decisions |

**Zero unresolved findings at any severity.**

This is an unusually clean result for a governance framework of this complexity. It reflects the maturity of both the codebase and the supporting design documentation (`SECURITY_GUIDE.md`, `DAOSHIPS_VS_ZODIAC_BAAL.md`). The team has clearly invested heavily in iterative security review — every labeled in-source mitigation (`H-1`, `C-1`, `M-1` through `M-7`, etc. — the team's own scheme) corresponds to a concrete threat they identified and addressed. The audit did not uncover anything they had not already considered.

**The codebase is suitable for mainnet deployment on Quai Network** once standard operational-security practices are applied at the deployment layer (hardware wallet signing or KMS-backed keys, not plaintext `.env` — see the preserved L-1 section for guidance when that time comes).

### Changes applied in this audit session

1. **Deleted legacy staged deploy scripts**: `scripts/deploy/001_deploy_poster.ts`, `002_deploy_singletons.ts`, `003_deploy_factories.ts` (used wrong SDK, duplicated `deploy-all.ts`, never successfully run on cyprus1).
2. **Preserved**: `scripts/deploy/004_deploy_navigators.ts` (correctly uses `quais.ContractFactory`, referenced by E2E tests and documented workflows).
3. **Updated [package.json](../package.json)**: removed `deploy:poster`, `deploy:singletons`, `deploy:factories` script entries; kept `deploy:all` and `deploy:navigators`.
4. **Updated [README.md](../README.md)** file-structure diagram to show only the surviving scripts with clarifying comments.
5. **Added NatSpec** to [DAOShip.sol:1208-1291](../contracts/core/DAOShip.sol#L1208) (`mintShares`, `mintLoot`, `burnShares`, `burnLoot`) documenting the intentional uncapping decision, gas-bounding guarantees, and operator guidance for large batches.

No Solidity logic was modified. All changes are either cleanup of legacy rot or inline documentation. The production deployment path and on-chain behavior are unchanged.
