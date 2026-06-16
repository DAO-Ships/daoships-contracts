# DAO Ships Poster Protocol

Poster (EIP-3722) is a shared, permissionless on-chain event emitter deployed once per network. It has no state — it simply emits `NewPost(address indexed user, string content, string indexed tag)` events. Indexers and frontends listen for these events, filter by `tag`, and attribute content to the `user` (msg.sender).

DAO Ships uses Poster as the metadata layer for data that benefits from **on-chain attribution** — where knowing *who* posted it (verified by msg.sender) adds trust that an off-chain tool cannot provide.

**Poster is NOT for:** project management, accounting, long-form discussion, social commentary, or anything where a forum, wiki, GitHub, or traditional database is a better fit. If the data doesn't benefit from being verifiably posted by a specific wallet, it doesn't belong on-chain.

---

## How It Works

```
Caller (wallet)  ──  post(content, tag)  ──  Poster (EIP-3722)  ──  NewPost event  ──  Indexer
```

- **No access control.** Anyone can post. Indexers filter by `msg.sender` to determine trust.
- **No storage.** Content exists only in event logs — gas-efficient, append-only.
- **Tags are indexed.** The `tag` parameter is `string indexed`, meaning the raw string is keccak256-hashed in the event topic. Indexers must decode the full event data to read the tag — you cannot filter by raw string in topics alone.
- **Content format.** JSON string. All DAO Ships Poster content is JSON.

**Note:** Poster has a `post(string content)` overload that emits an empty-string tag. DAO Ships does not use this overload — all posts must include a tag.

---

## Domain Schema

Tags follow hierarchical dot-notation: `daoships.<context>.<action>`

### Tag Registry

| Tag | Who Posts | Purpose |
|-----|----------|---------|
| `daoships.dao.profile.initial` | Deployer (directly, at launch) | Initial DAO profile before governance exists |
| `daoships.dao.profile` | DAO vault (via governance proposal) | Governance-approved DAO branding and links |
| `daoships.dao.announcement` | DAO vault (via proposal) | Official DAO communications |
| `daoships.member.profile` | Member (directly) | Minimal on-chain identity (name, avatar, bio) |
| `daoships.proposal.vote.reason` | Voter (directly, after voting) | Why they voted the way they did |
| `daoships.navigator.allowlist` | Navigator deployer (directly) | Merkle tree for address-gated onboarding |
| `daoships.dao.navigators` | DAO vault (via governance proposal) | Authenticated allowlist of **read-only** navigators the DAO sanctions (endorsement, grants no permission) |
| `daoships.signal.poll` | Poll creator (directly, after `createPoll`) | Option labels + description / discussion link for a SignalNavigator poll (the index→label map the contract keeps off-chain) |

**That's it.** Eight tags. Everything else belongs off-chain.

### What Does NOT Belong in Poster

| Data | Why Not | Use Instead |
|------|---------|-------------|
| Proposal rationale / discussion | Long-form content is expensive on-chain and doesn't benefit from wallet attribution — the proposer is already identified in `SubmitProposal` | Forum thread linked via `details` field |
| Proposal milestones / deliverables | Project management — no governance-trust benefit | GitHub issues, Notion, forum |
| Treasury address labels | Address book feature — no trust benefit over a frontend-maintained list | Frontend local storage, database |
| Treasury transaction context | Accounting — better tracked in structured tools | Spreadsheet, treasury dashboard |
| Delegation statements | Social commentary — delegate reputation is off-chain | Twitter, forum, blog |
| DAO charter / bylaws | The document lives on IPFS; the governance approval is the proposal itself | Link in proposal `details`, pin on DAO website |
| Navigator metadata (name, description) | Now handled by `NavigatorDeployed` event in `INavigator` — emitted atomically at construction, unforgeable | `NavigatorDeployed` event |
| Navigator upgrade context | Already captured by `NavigatorSet` events + proposal details | Proposal `details` field |
| Cross-DAO endorsements | Political/social — not indexer data | DAO website, social media |
| Signal poll & vote *data* (the question, tally, votes) | Handled on-chain by `SignalNavigator` events (`PollCreated` / `Voted` / `PollCancelled`) — wallet-attributed already | `SignalNavigator` contract events. (Two carve-outs that DO use Poster: *sanctioning* a SignalNavigator address → `daoships.dao.navigators`; and a poll's *option labels* → `daoships.signal.poll`, both below) |
| Member governance statements | Blog post — no trust benefit over a forum profile | Forum, personal site |

---

## Content Schemas

All content is JSON. Fields marked with `*` are required. All schemas include `schemaVersion`.

### Initial DAO Profile (`daoships.dao.profile.initial`)

Posted by the deployer directly after launching a DAO, before governance exists. Once the DAO posts a `daoships.dao.profile` from the vault via governance, it **permanently invalidates** the initial profile — the indexer must reject further `profile.initial` posts for that DAO.

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "name": "My DAO*",
  "description": "A community treasury for builders on Quai Network*",
  "avatar": "ipfs://Qm...",
  "links": {
    "website": "https://mydao.xyz",
    "forum": "https://forum.mydao.xyz"
  },
  "tags": ["defi", "quai"],
  "chainId": 9000
}
```

**Trust verification:** The indexer MUST match `msg.sender` against the deployer wallet:
- For vault-launched DAOs: use the `launcher` field from the `LaunchDAOShipAndVault` event (this is always the deployer wallet).
- For direct launches via `DAOShipLauncher`: use the `launcher` field from the `LaunchDAOShip` event.
- **Rule:** MUST use `LaunchDAOShipAndVault` when available. MUST NOT fall back to `LaunchDAOShip.launcher` for vault-launched DAOs (that field contains the vault launcher contract address, not the deployer).

### DAO Profile (`daoships.dao.profile`)

Posted by the DAO vault via governance proposal. Supersedes any `daoships.dao.profile.initial`.

```json
{
  "schemaVersion": "1.1",
  "daoAddress": "0x00...*",
  "name": "My DAO*",
  "description": "A community treasury for...*",
  "avatar": "ipfs://Qm...",
  "banner": "ipfs://Qm...",
  "links": {
    "website": "https://mydao.xyz",
    "twitter": "https://twitter.com/mydao",
    "discord": "https://discord.gg/mydao",
    "forum": "https://forum.mydao.xyz",
    "github": "https://github.com/mydao"
  },
  "theme": {
    "mode": "dark",
    "primary": "#5B8DEF",
    "secondary": "#22D3AA",
    "accent": "#F59E0B",
    "background": "#0E1116",
    "surface": "#171B22",
    "text": "#E6EAF2"
  },
  "tags": ["defi", "investment", "quai"],
  "chainId": 9000
}
```

**Partial updates:** To update specific fields without reposting everything, post with tag `daoships.dao.profile` and include only the fields being changed plus `daoAddress` and `schemaVersion`. Indexers merge using last-write-wins: a field set to `null` removes it, an omitted field is unchanged, an empty string `""` sets the field to empty.

#### Brand theme (`theme`, schema 1.1+)

Optional palette so a DAO can theme webapps that render it. `avatar` (icon) and `banner` remain the
DAO's images — `theme` adds only **colors**. All fields are optional; the frontend fills any unset
token from its own defaults, using `mode` to choose the light/dark base.

| Field | Notes |
|-------|-------|
| `mode` | `"light"` or `"dark"` — which base the palette targets; drives the fallback for unset tokens |
| `primary` | Brand color: buttons, links, active/selected states |
| `secondary` | Secondary actions / accents |
| `accent` | Highlights, badges, notifications |
| `background` | Page background color |
| `surface` | Cards / panels; defaults to a derived tint of `background` |
| `text` | Primary foreground; defaults from `mode` + contrast |

Only `primary` and `background` meaningfully need setting; the rest are optional refinements. There is
no background *image* — branding imagery is `avatar` + `banner`; `theme` is colors only.

- **Color format — strict hex, enforced.** Every theme color MUST match `^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$`.
  A value that does not match is dropped (the default token is used). This is a security boundary, not a
  nicety — see [Security: Content Rendering](#security-content-rendering), rule 7.
- **Accessibility is the frontend's duty.** A DAO can post unreadable pairs (e.g. `text` == `background`).
  Frontends SHOULD check posted pairs against WCAG AA (4.5:1 for text, 3:1 for UI / large text) and fall
  back to a default token when a pair fails, rather than render unreadable content.
- **`theme` is replaced as a whole**, like `links`: it is a single field. To change one color, repost the
  complete `theme` block you want; `"theme": null` clears it; omitting `theme` leaves the current one
  unchanged. Indexers do **not** deep-merge individual tokens.

The same `theme` block is also valid in `daoships.dao.profile.initial` (same rules), so a deployer may
set a launch palette before governance exists.

### DAO Announcement (`daoships.dao.announcement`)

One active announcement per DAO at a time. Posting a new announcement replaces the previous one. To dismiss, post with `title: ""` or let `expiresAt` pass.

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "title": "Governance vote in progress*",
  "body": "A proposal to upgrade the OnboarderNavigator is up for vote.",
  "severity": "info",
  "url": "https://forum.mydao.xyz/t/vote-on-navigator-upgrade/456",
  "expiresAt": "2026-04-05T00:00:00Z"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `title` | Yes | Short notice. Empty string = dismiss current announcement. |
| `body` | No | Brief context (keep under 500 chars — link to `url` for details) |
| `severity` | No | `info` (default), `warning`, or `critical` |
| `url` | No | Link to forum thread, discussion, or details page |
| `expiresAt` | No | ISO 8601 timestamp. Indexer hides announcement after this time. Omit for no expiry. |

### Member Profile (`daoships.member.profile`)

Minimal on-chain identity. The value of posting this via Poster (vs. a traditional profile service) is that it proves wallet ownership — the `msg.sender` IS the member.

Keep it minimal. Detailed bios, portfolios, and governance platforms belong on personal websites or forum profiles.

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...",
  "name": "alice.quai*",
  "avatar": "ipfs://Qm...",
  "bio": "Smart contract developer"
}
```

`daoAddress` is optional. If omitted, the profile applies globally across all DAOs. If included, it's DAO-specific. A member can have one global profile and multiple DAO-specific profiles.

### Vote Reason (`daoships.proposal.vote.reason`)

Posted by a voter after casting their vote. The value: it proves the reasoning came from someone who actually voted (msg.sender matches the voter in `SubmitVote`).

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "proposalId": 42,
  "vote": true,
  "reason": "The budget is reasonable and the team has delivered before.*"
}
```

**Important:** The `vote` field is informational and MUST NOT be used as the canonical vote direction. The indexer MUST use the on-chain `SubmitVote` event as the source of truth. The `vote` field here is self-reported and could mismatch.

### Navigator Allowlist (`daoships.navigator.allowlist`)

Posted by the navigator deployer immediately after deploying a navigator with an address allowlist. Contains the full Merkle tree so the frontend can generate proofs for allowlisted users to onboard.

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "navigatorAddress": "0x00...*",
  "root": "0xabcdef...*",
  "addresses": ["0x00abc...", "0x00def...", ...],
  "treeDump": { ... }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `daoAddress` | Yes | The DAO's DAOShip contract address |
| `navigatorAddress` | Yes | The navigator contract this allowlist belongs to |
| `root` | Yes | Merkle root (bytes32 hex). Must match the navigator's on-chain `allowlistRoot()` |
| `addresses` | Yes | Full list of allowlisted addresses (valid hex, non-empty) |
| `treeDump` | Yes | Output of `StandardMerkleTree.dump()` from `@openzeppelin/merkle-tree`. Contains the full tree structure for client-side proof generation |

**Trust verification:** Uses `MEMBER` trust level. The deployer posts this before the `setNavigators` governance proposal is processed, so the navigator address is not yet registered in the DAO — `SEMI_TRUSTED` cannot be used. The indexer validates hex format on all address fields and the root.

**Size:** For a 100-address allowlist, the `treeDump` is approximately 8-10 KB. The 16 KB Poster limit supports allowlists of up to ~150 addresses per post.

**Deduplication:** Key: `msg.sender` + `tag` + `daoAddress` + `navigatorAddress`. Last-write-wins. In practice, allowlists are set once (the navigator's `allowlistRoot` is immutable).

### DAO Sanctioned Navigators (`daoships.dao.navigators`)

Posted by the DAO **vault via a governance proposal**. This is the DAO's authenticated allowlist of **read-only navigators** it endorses — the official-onboarding mechanism for navigators that hold no permission and therefore never pass through `setNavigators()` / `NavigatorSet` (today: `SignalNavigator`).

**Why this exists:** A read-only navigator's DAO association is *self-asserted* — `NavigatorDeployed(daoShip, …)` is permissionless, so anyone can deploy a contract claiming association with any DAO and start emitting polls. There is no `NavigatorSet` from the DAO to vouch for it. This post is that missing vouch: because it comes from the vault (`msg.sender == vault`, gated by a governance vote), it is an unforgeable, DAO-consented endorsement — **and it grants zero on-chain permission.** It is purely a trust signal for indexers and frontends; it does not change what the navigator can do on-chain (a read-only navigator works whether sanctioned or not — sanctioning only governs how it is surfaced).

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "navigators": [
    { "address": "0x00...*", "type": "SignalNavigator" }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `daoAddress` | Yes | The DAO's DAOShip contract address. MUST match the vault's DAO. |
| `navigators` | Yes | The **complete** set of sanctioned read-only navigators as of this post (see semantics). May be empty `[]` to clear all sanctions. |
| `navigators[].address` | Yes | Navigator contract address. Must be valid hex. |
| `navigators[].type` | No | Expected `navigatorType` (e.g. `"SignalNavigator"`), for sanity-checking against the on-chain value. |

**Canonical-set, last-write-wins semantics.** The `navigators` array is the **full** sanctioned set, not a delta. The latest post from the vault entirely replaces the previous list:
- An address newly present → `trust_status = 'sanctioned'`.
- An address that was sanctioned but is now **absent** → de-sanctioned (`trust_status = 'unsanctioned'`). Omitting an address revokes it — always re-list everything you still endorse.
- An empty array clears all sanctions for the DAO.

**Trust verification:** Index ONLY when `msg.sender == DAO vault (avatar)`. A `daoships.dao.navigators` post from any other address is spam — discard it. The vault address is the one stored as the DAO's `avatar` (from `LaunchDAOShipAndVault` / `SetupComplete`).

**Scoping guard:** Sanctions are only meaningful for navigators whose own `NavigatorDeployed.daoShip` equals this `daoAddress`. A vault cannot sanction a navigator pointed at a *different* DAO — the indexer MUST ignore any listed address that does not resolve to a read-only navigator bound to this DAO. Sanctioning a permissioned navigator is a no-op (those are already vouched by `NavigatorSet`).

**Ordering:** If a sanction lists an address before the indexer has seen that navigator's `NavigatorDeployed`, hold the intent keyed by `(daoAddress, address)` and apply it when the `NavigatorDeployed` arrives — the same hold-until-discovered pattern used for navigator metadata.

**Deduplication:** Key: `msg.sender` (vault) + `tag` + `daoAddress`. Last-write-wins.

### Signal Poll Options (`daoships.signal.poll`)

Posted by the **poll creator** directly, immediately after `createPoll`. Carries the index→label
mapping the `SignalNavigator` deliberately keeps off-chain — the contract stores only `optionCount`,
so options are bare indices `0..optionCount-1` (see `docs/SIGNAL_NAVIGATOR.md` §4.7) — plus an optional
description and discussion link. The on-chain `PollCreated.question` remains the **canonical headline**;
this post does not duplicate it, it only labels the options and adds context.

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...*",
  "navigatorAddress": "0x00...*",
  "pollId": 0,
  "options": ["Teal", "Magenta", "Slate"],
  "description": "Pick the v2 brand color.",
  "discussionUrl": "https://forum.mydao.xyz/t/brand-color/789"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `daoAddress` | Yes | The DAO's DAOShip address. MUST equal the navigator's `NavigatorDeployed.daoShip`. |
| `navigatorAddress` | Yes | The `SignalNavigator` contract the poll belongs to. |
| `pollId` | Yes | Per-navigator poll id (starts at 0). The poll is keyed by `(navigatorAddress, pollId)` — `pollId` is **not** global. |
| `options` | Yes | Ordered label array; `options[i]` is the label for option index `i`. **`options.length` MUST equal the on-chain `optionCount`** from `PollCreated`, or the post is discarded and the frontend falls back to numeric options. |
| `description` | No | Short context (≤ 1000 chars). Long-form belongs at `discussionUrl`. |
| `discussionUrl` | No | Link to the forum / Discord / GitHub discussion. |

**Trust verification:** Index ONLY when `msg.sender == PollCreated.creator` for that
`(navigatorAddress, pollId)`. A post from any other address is spam — discard it. This is the
poll-creator analogue of the `vote.reason` rule: it proves the labels came from the wallet that
actually opened the poll. (The creator is recorded in `PollCreated.creator`, not derived from a
shares check — a creator who divests after opening the poll can still label it.)

**Validation:** `options.length` MUST match the on-chain `optionCount`; mismatched posts are discarded
(render numeric options instead). Apply the same content-rendering rules as every other tag — escape
all label/description strings, validate `discussionUrl` against the `https`/`http`/`ipfs` scheme
allowlist (§ Security: Content Rendering).

**Ordering (second tx by necessity).** `pollId` does not exist until `createPoll` is mined, so this
post is always a **separate transaction landing after `PollCreated`**. If it ever arrives first
(reorg / out-of-order delivery), hold it keyed by `(navigatorAddress, pollId)` and apply it when
`PollCreated` arrives — the same hold-until-discovered pattern used for `daoships.dao.navigators`
above. Until the labels post is seen, render options numerically (`Option 1..n`).

**Deduplication:** Key: `msg.sender` (creator) + `tag` + `navigatorAddress` + `pollId`.
**Last-write-wins** — the creator may repost to correct a label, the description, or the link. Because
every post persists in event logs the full edit history stays reconstructable; a frontend MAY surface
an "edited" indicator (e.g. if labels change after voting opens) but the standard does **not** mandate
locking edits — the creator-only trust gate is the whole access-control story.

---

## The `details` Field Convention

`submitProposal(bytes proposalData, uint256 expiration, string details)` includes a `details` string stored on-chain in the `SubmitProposal` event. This is the **on-chain proposal identifier** — use it for a short metadata stub, not long-form content.

**Recommended convention:**

```json
{"title": "Fund BudgetNavigator development", "type": "funding", "discussionUrl": "https://forum.mydao.xyz/t/123"}
```

| Field | Purpose |
|-------|---------|
| `title` | Short proposal title for list/card views |
| `type` | Classification: `funding`, `navigator_add`, `navigator_remove`, `governance_config`, `profile_update`, `announcement`, `custom` |
| `discussionUrl` | Link to the forum thread, Discord channel, or GitHub issue where this proposal was discussed |

**Keep it under 256 bytes.** The `details` field is stored in contract storage and emitted in the event — every byte costs gas. Long-form rationale, attachments, and discussion belong at the `discussionUrl`, not on-chain.

Frontends should:
1. Parse `details` as JSON to extract `title` and `type` for list views.
2. Fall back to displaying `details` as plain text if it's not valid JSON.
3. Render `discussionUrl` as a "View Discussion" link.

---

## Integration Patterns

### Pattern 1: DAO Profile via Governance Proposal

```typescript
const posterInterface = new ethers.Interface(["function post(string content, string tag)"]);
const content = JSON.stringify({
  schemaVersion: "1.0",
  daoAddress: daoShipAddress,
  name: "My DAO",
  description: "A community treasury for builders on Quai Network",
  avatar: "ipfs://QmXxx...",
  links: { website: "https://mydao.xyz", forum: "https://forum.mydao.xyz" },
  tags: ["defi", "quai"],
  chainId: 9000
});
const postData = posterInterface.encodeFunctionData("post", [content, "daoships.dao.profile"]);

// Wrap in MultiSend format and submit as proposal
const proposalData = encodeProposalData([posterAddress], [0n], [postData]);
await daoShip.submitProposal(proposalData, 0, JSON.stringify({
  title: "Set DAO profile",
  type: "profile_update"
}));
```

### Pattern 2: Member Profile (Direct)

```typescript
const poster = new ethers.Contract(posterAddress, posterABI, signer);
await poster.post(
  JSON.stringify({
    schemaVersion: "1.0",
    name: "alice.quai",
    avatar: "ipfs://QmYyy...",
    bio: "DAO governance researcher"
  }),
  "daoships.member.profile"
);
```

### Pattern 3: Vote Reason (After Voting)

```typescript
await daoShip.submitVote(proposalId, true);
await poster.post(
  JSON.stringify({
    schemaVersion: "1.0",
    daoAddress: daoShipAddress,
    proposalId: proposalId,
    vote: true,
    reason: "Strong alignment with our Q2 roadmap"
  }),
  "daoships.proposal.vote.reason"
);
```

### Pattern 4: Sanction a Read-Only Navigator (Governance Proposal)

Officially onboard a `SignalNavigator` (or any read-only navigator) by having the vault post the DAO's sanctioned-navigator allowlist. This is a governance action — the post executes from the vault, so it is authenticated and grants no permission.

```typescript
const posterInterface = new ethers.Interface(["function post(string content, string tag)"]);

// Re-list EVERY navigator the DAO still endorses — this is the full set, not a delta.
const content = JSON.stringify({
  schemaVersion: "1.0",
  daoAddress: daoShipAddress,
  navigators: [
    { address: signalNavigatorAddress, type: "SignalNavigator" }
    // ...any other read-only navigators the DAO continues to sanction
  ]
});
const postData = posterInterface.encodeFunctionData("post", [content, "daoships.dao.navigators"]);

// Wrap in MultiSend format and submit as a governance proposal (executes from the vault)
const proposalData = encodeProposalData([posterAddress], [0n], [postData]);
await daoShip.submitProposal(proposalData, 0, JSON.stringify({
  title: "Sanction SignalNavigator for temperature checks",
  type: "navigator_add"
}));
```

To **revoke** a sanction, submit a new proposal that re-posts the list with that address omitted (or an empty `navigators: []` to clear all).

### Pattern 5: Signal Poll Option Labels (After `createPoll`)

The poll creator posts the option labels directly, in a second tx after the poll exists on-chain. The
headline stays on-chain in `PollCreated.question`; this post only labels the indices and adds context.

```typescript
// 1. Create the poll on-chain — the headline lives in `question`, the contract stores only the count.
const tx = await signalNavigator.createPoll("Which color for the v2 brand?", 3, 0, 86400);
const receipt = await tx.wait();
// Recover the assigned pollId from the PollCreated event (ids are per-navigator, start at 0).
const ev = receipt.logs
  .map((l) => { try { return signalNavigator.interface.parseLog(l); } catch { return null; } })
  .find((e) => e && e.name === "PollCreated");
const pollId = ev.args.pollId;

// 2. Post the option labels + meta, attributed to the creator's wallet (msg.sender == creator).
await poster.post(
  JSON.stringify({
    schemaVersion: "1.0",
    daoAddress: daoShipAddress,
    navigatorAddress: await signalNavigator.getAddress(),
    pollId: Number(pollId),
    options: ["Teal", "Magenta", "Slate"], // options.length MUST equal the poll's optionCount (3)
    description: "Pick the v2 brand color.",
    discussionUrl: "https://forum.mydao.xyz/t/brand-color/789"
  }),
  "daoships.signal.poll"
);
```

To **correct** a label or link, repost with the same `(navigatorAddress, pollId)` from the same
creator wallet — last-write-wins.

---

## Trust Model

| `msg.sender` | Trust Level | Tags They Can Post |
|--------------|-------------|-------------------|
| DAO vault address | **Verified** — governance-approved | `dao.profile`, `dao.announcement`, `dao.navigators` |
| Deployer wallet (matches launch event) | **Verified (initial)** — one-time at launch | `dao.profile.initial` |
| Member wallet (shares > 0) | **Member** — verified shareholder | `member.profile`, `proposal.vote.reason`, `navigator.allowlist` |
| Poll creator (matches `PollCreated.creator`) | **Creator** — verified poll opener | `signal.poll` (for their own polls only) |
| Any other address | **Untrusted** — do not index | — |

**Rule: NEVER index a post based on tag alone.** Always verify `msg.sender` against the trust model before writing to the database. A post tagged `daoships.dao.profile` from a random wallet is spam, not a DAO profile.

---

## Deduplication

For mutable content (profiles, labels, announcements):
- Key: `msg.sender` + `tag` + `daoAddress`
- Semantics: **last-write-wins** — newer post replaces older
- Merging: field set to `null` removes it, omitted field is unchanged, empty string sets to empty

For append-only content (vote reasons):
- Every post is unique, keyed by `msg.sender` + `proposalId`
- **One vote reason per voter per proposal.** If a voter posts a second reason for the same proposal, it replaces the first.

For signal poll labels (`daoships.signal.poll`):
- Key: `msg.sender` (creator) + `tag` + `navigatorAddress` + `pollId` — last-write-wins
- Trust gate: accept ONLY when `msg.sender == PollCreated.creator` for that `(navigatorAddress, pollId)`

---

## Content Size and Gas

Poster content is stored in event logs, not contract storage. There is no on-chain size limit, but:

- **Keep JSON content under 4 KB.** This is the practical ceiling for gas-efficient posting.
- **Inline-required fields** (name, title, description, bio, reason, labels): Always include directly in the JSON. These are needed for rendering without an external fetch.
- **Reference fields** (avatar, banner): Use `ipfs://` CIDs. Never inline binary content.
- **Large content** (documents, images): Store on IPFS, reference by CID. If a body field exceeds 4 KB, store it on IPFS and include a truncated preview (first 500 chars) plus the CID.

Indexers MUST enforce a hard size limit. **Discard posts where content exceeds 16 KB** — anything larger is either an attack or a misuse of Poster.

---

## Security: Content Rendering

All Poster content is user-supplied and MUST be treated as untrusted by frontends.

### Mandatory Rules

1. **Never use `innerHTML` or `dangerouslySetInnerHTML`** to render Poster content. All string fields must be escaped before rendering.

2. **URL validation.** All URL fields (`links.*`, `avatar`, `banner`, `discussionUrl`) MUST be validated against an allowlist of schemes: `https://`, `http://`, `ipfs://`. Reject `javascript:`, `data:`, `vbscript:`, and blank schemes.

3. **IPFS content proxying.** Serve IPFS content through a gateway that enforces content-type headers. Never render IPFS-hosted SVGs directly — they can contain embedded JavaScript.

4. **Address validation.** `daoAddress` and `navigatorAddress` fields MUST be valid checksummed hex addresses. Reject malformed addresses before writing to the database.

5. **String length limits.** Enforce maximum lengths on rendered fields:
   - `name`: 100 characters
   - `bio`, `description`: 1000 characters
   - `reason`: 2000 characters
   - `title`: 200 characters

6. **JSON parsing.** Always `JSON.parse()` inside a try/catch. Malformed JSON should be discarded, not partially rendered.

7. **Color validation.** All `theme.*` color fields MUST match `^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$` before being assigned to a CSS variable, `style` attribute, or stylesheet. An unvalidated color string is a CSS-injection vector — a value that closes the declaration can inject arbitrary rules (e.g. `#fff; } body { background: url(...)`). Reject non-conforming values and fall back to the default token; never interpolate a posted color into CSS without this check. (`mode` is constrained to the literals `"light"` / `"dark"`; treat any other value as unset.)

### IPFS Considerations

- IPFS content is only available while pinned. Frontends should display a placeholder when IPFS content is unavailable.
- IPFS CIDs in any Poster content are self-reported. Frontends should label external references accordingly.
- Use CIDv1 (base32) format for consistency: `ipfs://bafybeig...`

---

## Privacy Notice

All Poster content is **permanently stored in event logs on-chain.** It cannot be deleted, modified, or redacted after posting. The "last-write-wins" model allows overwriting with empty data in the indexer, but the original event remains accessible to anyone with an archive node.

**Warn users before posting member profiles.** The `name`, `bio`, and `avatar` fields are visible to every DAO on the network and permanently recorded. Users who need pseudonymity should use wallet-derived identifiers, not real names.

---

## Schema Versioning

All schemas include `"schemaVersion": "1.0"`. Version policy:

| Change | Bump | Example |
|--------|------|---------|
| New optional field | 1.0 -> 1.1 | Adding `banner` to profile |
| New required field | 1.0 -> 2.0 | Making `chainId` required |
| Field renamed or removed | 1.0 -> 2.0 | Renaming `bio` to `description` |

Content without a `schemaVersion` field is treated as version `0.0` (pre-versioning). Indexers must handle both versioned and unversioned content gracefully.

---

## Poster Address

Poster is deployed once per network. All DAOs share the same Poster contract.

| Network | Address |
|---------|---------|
| Cyprus1 (Orchard testnet) | See `deployment-addresses.json` |

---

## Relationship to DAOShip Events

Poster complements DAOShip's built-in events — it does not replace them.

| Data | Source | Why |
|------|--------|-----|
| Proposal submission, votes, processing | `DAOShip` events | On-chain governance state — must be in contract events |
| Proposal title and discussion link | `SubmitProposal.details` field | Short metadata, stored on-chain |
| Detailed proposal rationale | **Off-chain** (forum, linked via `details.discussionUrl`) | Long-form content — too expensive and unnecessary on-chain |
| Member share/loot balances | Token `Transfer` events | On-chain financial state |
| Member identity | **Poster** (`daoships.member.profile`) | Wallet-attributed identity |
| DAO configuration | `SetupComplete`, `GovernanceConfigSet` events | On-chain governance parameters |
| DAO branding and links | **Poster** (`daoships.dao.profile`) | Governance-approved social metadata |
| Permissioned navigator authorization | `NavigatorSet` event | On-chain permission grant — must be contract state |
| Read-only navigator endorsement | **Poster** (`daoships.dao.navigators`) | No permission to grant; authenticated endorsement via the vault is the only DAO-consented signal |
| Signal poll option labels | **Poster** (`daoships.signal.poll`) | Index→label map the navigator keeps off-chain; wallet-attributed to the poll creator (`PollCreated.creator`) |
| Vote reasoning | **Poster** (`daoships.proposal.vote.reason`) | Wallet-attributed commentary |
| Treasury address labels | **Off-chain** (frontend address book) | No trust benefit from on-chain attribution |

**Rule of thumb:** If it affects governance state, it's a DAOShip event. If it's wallet-attributed metadata that benefits from on-chain trust, use Poster. If it's just content, put it on a website.
