# Log compaction with PingRoom

Compact a sealed key/value changelog after its source owner declares what a null event value means. Code keeps the last mutation for each key, preserves their relative order, and checks that replay produces the same final state from the supplied initial snapshot.

Use this between a changelog export and a downstream replay or snapshot review. The starter writes local JSON only; it never contacts a broker, changes a database or overwrites the source log.

## Try it offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional paper-catalog demo covers null-as-data, null-as-deletion and Unknown. Tests and demos use published `@pingroom/sdk` 0.8.0 through local mock transports. After installation they need no credentials or network and send no live pings. Dependencies are pinned in the lockfile; `.npmrc` requests a 14-day release age where supported by npm.

## Prepare a sealed log

```sh
cp examples/log.json log.json
cp config.example.json config.json
npm run preview
```

Map your retained export into `log.json` before starting:

| Field | Contract |
| --- | --- |
| `logId` | Stable ID, 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line descriptions, at most 40 and 80 UTF-16 code units. Identify the source format documentation. |
| `initial` | 0–64 `{key, value}` entries representing the state immediately before the first event. Keys must be unique. |
| `events` | 0–256 `{id, key, value}` events in authoritative application order. Event IDs must be unique; keys may repeat. |
| Entry `key`, event `id` | 1–24 characters using the `logId` alphabet. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. |
| `value` | `null`, a boolean, a safe integer, or a well-formed string of at most 256 UTF-16 code units. Empty strings are valid. Nested objects/arrays, fractional numbers, negative zero and unsafe integers are rejected. |

The union of initial and event keys must contain at most 64 distinct keys. The input file must also fit 64 KiB. Extra fields, sparse arrays, duplicate initial keys, duplicate event IDs and malformed Unicode are rejected. Scalar strings are preserved exactly, including escaped whitespace. Metadata is trimmed and cannot contain control or format characters.

Initial entries canonicalize by key. Event order is never sorted, deduplicated or inferred from IDs. Combine partitions only if your source provides one authoritative order; this starter does not resolve concurrent writes or establish that an export is complete.

## Connect and declare null semantics

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a standard private room containing the source owner, with room-list and Question create/read permissions. Verify the person in the app and enter their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity.

For an existing granted connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be mixed.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Preview is local and shows the complete source, policy, recipient and visible Question. Each run creates at most one direct, 15-minute Question or reads the original Question once. Select:

- **Null is data:** a null event stores a present key whose value is null.
- **Null deletes:** a null event removes the key.
- **Unknown:** withhold the entire compaction result.

Nulls in the **initial snapshot always mean stored data**. The selected policy applies only to events. If the source uses different deletion markers, conditional updates, patches or transactions, adapt its semantics before using this model.

PingRoom receives the log ID, title/context, policy explanation, owner UUID and input/initial/policy hashes. Event keys, values and the initial snapshot stay local. Missing, Unknown, expired, cancelled, invalid or misattributed answers block export. There is no background polling or replacement Question.

## Read and export

```sh
npm run status
npm run report
npm run export
```

These commands are local and need no credentials. `report` writes private `.compaction/report.json`, including the full source and partial answer evidence. A completed `export` writes `.compaction/compacted.json`, containing the last event per key, final state, policy, hashes and attributed answer evidence. **The handoff excludes the original event array, superseded values and the initial snapshot.** Keep the independently retained initial snapshot when replaying the compacted events; its hash is included.

The calculation keeps retained events in their original relative order. Final null events remain in the compacted log even when their key was absent initially. Under deletion semantics these are tombstones; omitting them could leave stale values in a downstream state. Empty logs are valid and preserve the supplied initial snapshot.

The output records `retainedIndices` as zero-based original positions, event counts, `compactedEvents`, key-sorted `finalState`, `finalNullKeys`, `tombstoneKeys`, and initial/final/source hashes. Values retain their types: `0`, `"0"`, `false` and `null` remain distinct. `finalStateEquivalent` compares replay of the original and compacted events from the supplied initial snapshot.

This preserves final state under the declared rules, not intermediate history, emitted side effects, transaction boundaries or event subscriptions. Event count can decrease; JSON byte size may increase because the handoff includes evidence and a snapshot. It is not a historical archive or a byte-compression format. Apache Kafka's [log compaction design](https://kafka.apache.org/41/design/design/#log-compaction) explains the latest-value and tombstone concepts; this bounded offline model does not reproduce Kafka retention, partitioning or cleaner behavior.

## Adapt and resume

Write an adapter that exports a sealed ordered log and its initial snapshot. Use `compactLog(rawInput, nullPolicy)` in `src/model.js` for the pure calculation; CLI export additionally requires the attributed owner declaration. Read the compact handoff in your replay or review tool. No broker, database, deployment or other external-action adapter is included.

Real inputs, configuration, credentials, state and outputs are ignored by Git. Keep `.compaction/` and `.pingroom/` private. Writes are atomic under a local lock; changed input, owner, room or credentials cannot reuse the session.

A lost creation response leaves `create_unknown` and never triggers an automatic resend:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Keep the original source and session while resolving uncertainty.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report return 0 even for incomplete states; inspect their JSON status.

Tests cover independent replay, null/tombstone behavior, empty and maximum logs, idempotent compaction, exact scalar types, export omission, recovery, pairing and real CLI subprocesses. GitHub Actions runs Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
