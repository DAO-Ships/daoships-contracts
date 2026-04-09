# IPFS-Based Navigator Allowlist Architecture

How the DAO Ships launcher, indexer, and frontend coordinate to store, verify, and serve Merkle allowlists via IPFS.

---

## Problem

Navigator allowlists are currently posted inline via the Poster contract (EIP-3722). The full Merkle tree dump (`@openzeppelin/merkle-tree` `StandardMerkleTree.dump()`) is included as JSON in the event data. This works for small allowlists but hits a practical ceiling around **~150 addresses (~16 KB)**. Larger allowlists — common for token-gated communities, airdrop-based onboarding, or multi-phase launches — cannot be posted on-chain.

## Solution

Move the full allowlist data to IPFS. The Poster post becomes a lightweight pointer (CID) to the pinned document. The on-chain `allowlistRoot` (immutable in the navigator constructor) remains the sole trust anchor. IPFS provides transport; the indexer provides persistence and serving.

---

## Trust Model

```
On-chain (immutable)          Off-chain (supplementary)
─────────────────────         ────────────────────────
navigator.allowlistRoot()  ←  verification anchor
                               │
                               ├── Poster event (CID pointer)
                               │     └── msg.sender == deployer
                               │
                               └── IPFS document (addresses + treeDump)
                                     └── rebuilt root MUST match on-chain root
```

**The on-chain root is the only source of truth.** IPFS content is convenience data for proof generation. Every consumer (indexer, frontend) MUST verify the IPFS content by rebuilding the Merkle root from the tree dump and comparing it against the on-chain `allowlistRoot()`. A valid CID does not imply a valid allowlist — someone could pin a well-formed JSON with a different tree.

**CID integrity:** IPFS CIDs are content-addressed (SHA-256 hash of the DAG). It is computationally infeasible to produce different content with the same CID. If a CID resolves, the content is authentic. A gateway can fail or be slow, but it cannot serve wrong content for a given CID.

---

## Schema

### Poster Post (on-chain event)

Tag: `daoships.navigator.allowlist`

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...",
  "navigatorAddress": "0x00...",
  "root": "0xabcdef...",
  "ipfsCid": "bafybei..."
}
```

When `ipfsCid` is present, `addresses` and `treeDump` are omitted from the Poster post. The two formats are mutually exclusive — a post with both `ipfsCid` and inline `addresses`/`treeDump` is rejected.

**Backward compatibility:** Old posts with inline `addresses` and `treeDump` (no `ipfsCid`) continue to work. The indexer branches on field presence. `schemaVersion` stays `"1.0"` since `ipfsCid` is a new optional field, not a breaking change.

### IPFS Document

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...",
  "navigatorAddress": "0x00...",
  "root": "0xabcdef...",
  "addresses": ["0x00abc...", "0x00def...", "..."],
  "treeDump": { "format": "standard-v1", "tree": ["..."], "values": [...] }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `daoAddress` | Yes | Must match the Poster post |
| `navigatorAddress` | Yes | Must match the Poster post |
| `root` | Yes | Must match Poster post AND on-chain `allowlistRoot()` |
| `addresses` | Yes | Full allowlisted address array (checksummed hex) |
| `treeDump` | Yes | Output of `StandardMerkleTree.dump()` — contains full tree for client-side proof generation |

**Size:** At 10K addresses, the JSON is ~500 KB. At 50K addresses, ~3-5 MB. Both are well within IPFS gateway fetch limits. Beyond 100K addresses, consider chunked loading or indexer-served proofs.

---

## Frontend Flow

### Flow 1: Navigator Deployer (creating an allowlist)

A 4-step sequential pipeline. Each step depends on the previous — do not parallelize.

```
[1. Build Tree] → [2. Pin to IPFS] → [3. Deploy Navigator] → [4. Post CID to Poster]
```

**Step 1 — Build Tree (instant, client-side)**

User inputs addresses via textarea (CSV paste) or file upload. The frontend:
- Validates each address with `quais.isAddress()`
- Deduplicates
- Builds the tree: `StandardMerkleTree.of(addresses.map(a => [a]), ["address"])`
- Displays the address count and root hash preview

**Step 2 — Pin to IPFS**

Upload the JSON document (including `treeDump` from `tree.dump()`) to IPFS via **web3.storage** (`@web3-storage/w3up-client`). Free tier, content-addressed, no API key for reads.

- On failure: retry 2x with exponential backoff, then offer Pinata as fallback
- Show spinner: "Pinning allowlist to IPFS..."
- On success: display the CID and a gateway link for verification

**Step 3 — Deploy Navigator**

Send the deploy transaction with the Merkle root from step 1. Standard transaction UX (pending → mining → confirmed). On revert: stop the pipeline, show the error, let the user retry from this step.

**Step 4 — Post CID to Poster**

Call `Poster.post(json, "daoships.navigator.allowlist")` where `json` contains the CID and metadata. Same transaction UX. On success: show summary with navigator address, CID link, and block explorer link.

**Cache:** Store the tree dump in `localStorage` keyed by root hash. This lets the deployer generate proofs locally without re-fetching from IPFS.

### Flow 2: Member Onboarding (proving allowlist membership)

The member wants to onboard through an allowlisted navigator.

**Recommended approach: client-side proof generation (Option A)**

The tree JSON is typically under 500 KB even at 10K addresses. Fetching it from an IPFS gateway and generating the proof client-side eliminates an indexer dependency and keeps the stack decentralized. `StandardMerkleTree.load()` + `getProof()` runs in under 50ms.

```
[1. Fetch tree] → [2. Verify root] → [3. Check eligibility] → [4. Generate proof] → [5. Submit tx]
```

1. **Fetch tree:** Get the CID from the indexer API (`GET /navigators/:addr/allowlist`). Fetch the IPFS document from the primary gateway (`w3s.link`) with 10s timeout, fallback to `dweb.link`.
2. **Verify root:** Load the tree with `StandardMerkleTree.load(treeDump)`. Compare `tree.root` against the on-chain `navigator.allowlistRoot()`. If mismatch, show error — do not use the data. **This check is mandatory.**
3. **Check eligibility:** Attempt `tree.getProof([userAddress])`. If a proof exists, the user is eligible.
4. **Generate proof:** The proof is the return value from step 3 — an array of bytes32 hashes.
5. **Submit transaction:** Call `navigator.onboard(proof, { value: tributeAmount })`.

**UX states:** Loading allowlist → Verifying → Eligible / Not eligible → Transaction pending → Complete

**Fallback:** If IPFS fetch fails after retries, the frontend can fall back to the indexer's cached copy via `GET /navigators/:addr/allowlist` (which returns the full `treeDump`). The root verification in step 2 applies regardless of source.

---

## Indexer Flow

### Event Handler

When the indexer processes a `daoships.navigator.allowlist` Poster event:

1. Parse the JSON content
2. **If `ipfsCid` present** (new format): store the CID and metadata in `ds_navigator_allowlists` with `status = 'pending'`. Enqueue an async IPFS fetch job. Do not block event processing.
3. **If `addresses` and `treeDump` present** (legacy inline): process as today — verify root, store addresses, set `status = 'verified'`.
4. **If both present**: reject the post.

### IPFS Fetch Job

Runs outside the event-processing loop:

| Step | Details |
|------|---------|
| **Primary fetch** | Project-controlled IPFS node or gateway. 10s timeout. |
| **Fallback 1** | `dweb.link`. 15s timeout. |
| **Fallback 2** | `w3s.link`. 15s timeout. |
| **Retry** | 3 attempts, exponential backoff (5s, 15s, 45s). |
| **Size guard** | Abort if response exceeds 5 MB. |
| **On failure** | Set `status = 'fetch_failed'`. Periodic sweep retries every 30 min up to 24 hours, then `status = 'permanently_failed'`. |

### Verification (after successful fetch)

1. Parse JSON. Reject if malformed.
2. Confirm `daoAddress`, `navigatorAddress`, and `root` in the IPFS doc match the Poster event exactly.
3. Rebuild the tree: `StandardMerkleTree.of(addresses.map(a => [a]), ["address"])`. Compare computed root against the `root` field. Mismatch = reject, `status = 'root_mismatch'`.
4. Load `treeDump` with `StandardMerkleTree.load()`, confirm its root matches too.
5. Verify `msg.sender` from the Poster event matches `navigator.deployer()` via RPC.
6. On success: store addresses in `ds_navigator_allowlist_members`, store `treeDump`, set `status = 'verified'`.

### Pinning

After successful verification, the indexer pins the CID to the project's IPFS node. This provides redundancy — if the deployer's pin disappears, the indexer's copy survives. Long-term, the **database is the persistence layer**. IPFS is the transport.

### Database

```sql
-- Existing table, extended
ALTER TABLE ds_navigator_allowlists ADD COLUMN ipfs_cid TEXT;
ALTER TABLE ds_navigator_allowlists ADD COLUMN status TEXT DEFAULT 'verified';
-- status: 'pending', 'verified', 'fetch_failed', 'root_mismatch', 'permanently_failed'
```

The existing `addresses` and `tree_dump` columns hold the verified data regardless of whether the source was inline or IPFS.

### API Endpoints

| Endpoint | Returns | Purpose |
|----------|---------|---------|
| `GET /navigators/:addr/allowlist` | `{ root, addresses, treeDump, ipfsCid, status }` | Frontend loads `treeDump` for client-side proof generation |
| `GET /navigators/:addr/allowlist/check/:address` | `{ isAllowlisted: bool }` | Lightweight eligibility check before loading full tree |

If `status` is not `verified`, the frontend shows a loading or error state. `treeDump` is only returned when `status = 'verified'`.

---

## Security Considerations

### IPFS Availability

If the pinned content goes offline, no one can generate Merkle proofs, effectively disabling onboarding. The on-chain root still works — anyone who independently has the tree can submit a valid proof. Mitigations:

- Pin to multiple providers (web3.storage + project IPFS node)
- Indexer caches the validated tree in its database — once verified, the cached copy is equally authoritative
- The database, not IPFS, is the persistence layer for serving proofs

### Gateway Manipulation

Public gateways can rate-limit, serve stale content, or go down. They **cannot** serve wrong content for a CID (content-addressed). Mitigations:

- Never trust a single gateway — fetch from multiple with fallback chain
- Always verify fetched content against the on-chain root
- Use `ipfs://<CID>` references with a configurable gateway, not hardcoded URLs

### Privacy

Publishing the full address list on IPFS (or on-chain — the current design already exposes this) reveals allowlist membership. For most DAOs this is acceptable. If membership privacy matters:

- The Merkle tree provides some obscurity (only the root is on-chain), but the IPFS document exposes all leaves
- No practical mitigation within this architecture — if privacy is required, deliver proofs out-of-band (direct message from deployer)
- This is not IPFS-specific — the current inline Poster approach has the identical exposure

### Frontrunning

Knowing the allowlist does not help an attacker onboard. The Merkle proof requires `msg.sender` to match a leaf: `keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))`. You must BE an allowlisted address. **No frontrunning risk.**

Information disclosure (e.g., leaking future airdrop eligibility) is a separate concern — see Privacy above.

---

## Practical Limits

| Allowlist Size | IPFS Document Size | Gateway Fetch Time | Recommended Approach |
|---------------|-------------------|--------------------|---------------------|
| 1-150 | < 16 KB | < 1s | Inline Poster (legacy) or IPFS — either works |
| 150-10,000 | 50 KB - 500 KB | 1-3s | IPFS (this architecture) |
| 10,000-50,000 | 500 KB - 5 MB | 3-10s | IPFS with loading indicator |
| 50,000-100,000 | 5-10 MB | 10-30s | IPFS with indexer-served proofs (skip client-side tree load) |
| 100,000+ | 10+ MB | 30s+ | Indexer-served proofs via API; chunked tree loading |

For the DAO launcher use case, 50K addresses covers all realistic scenarios.

---

## Migration Plan

1. **No breaking changes.** The Poster tag remains `daoships.navigator.allowlist`. The `schemaVersion` stays `"1.0"`.
2. **Indexer update:** Add the `ipfsCid`/`status` column migration and the IPFS fetch job. Deploy before the frontend update.
3. **Frontend update:** Add the IPFS upload step to the navigator deployment flow. The onboarding flow already works — it just needs to handle the CID-based fetch path alongside the existing inline path.
4. **Old allowlists:** Continue to work as-is. No re-posting required.
5. **New allowlists > 150 addresses:** Must use IPFS. The frontend enforces this — if the address count exceeds 150, it skips inline Poster and uses the IPFS flow automatically.
