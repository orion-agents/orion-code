# Orion Code managed update contract v1

This directory is the Orion Code producer slice of `UP-CON-01`. It mirrors the consumer types and validation rules in Orion Studio's `orion_code_update` crate. The JSON Schemas are standalone Draft 7 schemas so release tooling can validate output without importing Studio code.

The contract files are:

- `update-index-v1.schema.json`: channel, rollout, compatibility, target, pause, revoke, and rollback policy.
- `signature-envelope-v1.schema.json`: detached Ed25519 signature metadata.
- `artifact-manifest-v1.schema.json`: file-level evidence embedded in a platform archive.
- `install-receipt-v2.schema.json`: durable evidence accepted by Studio for current and previous installations.
- `golden/`: structurally valid interoperability examples.
- `invalid/`: one-fault fixtures that a producer or consumer must reject.

Every instance object is closed with `additionalProperties: false`. Dynamic target names are admitted only through the target-name `patternProperties` rule, with all unmatched names rejected.

The Schemas freeze the producer contract. Any populated digest, target, or path evidence is validated even where a legacy `npx` install receipt would not use it. Rust length limits are UTF-8 byte limits; producers must enforce byte length in addition to JSON Schema `maxLength`, which counts Unicode characters. Adding fields such as separate build-toolchain metadata requires a synchronized schema/consumer version change rather than an unknown v1 property.

The Studio consumer and this producer contract both omit `release_receipt_sha256` from `ArtifactManifestV1`. The field would create a circular digest dependency, so the external final release receipt alone binds the completed archive and manifest digests.

## Exact-bytes signature contract

`orion-code-update-index-v1.json.sig` is an envelope, not a signed copy of parsed JSON. The Ed25519 input is the exact byte sequence of the separately published `orion-code-update-index-v1.json` file.

The consumer order is normative:

1. Enforce the 4 KiB signature-envelope and 1 MiB index byte limits before parsing.
2. Parse only the closed signature envelope and require schema `1`, algorithm `ed25519`, a known `key_id`, and a base64 value that decodes to exactly 64 bytes.
3. Select an already trusted public key by `key_id`.
4. Verify the detached signature over the untouched index bytes.
5. Only after verification, parse and validate the index schema and semantic rules.

The producer must write the final UTF-8 index bytes first, then hash and sign those same bytes. It must not pretty-print, canonicalize, reorder keys, normalize line endings, add a byte-order mark, or otherwise reserialize the index after signing. CDN content encoding is acceptable only when the HTTP client exposes the original decoded representation byte-for-byte; release verification must compare the downloaded payload digest with the producer receipt.

`golden/valid-signature-envelope.json` is deliberately identified by `key_id=schema-fixture-not-a-real-key`. Its base64 value has the correct decoded length but is not a cryptographically valid signature and does not authenticate `golden/valid-index.json`.

## One-way archive evidence

The archive manifest and the final release receipt form a directed evidence chain, never a cycle:

```text
archive payload files -> manifest.json -> final archive bytes -> external final release receipt
```

- `manifest.json` lists normalized archive payload paths and their byte counts, modes, and SHA-256 values. It also names and hashes the in-archive SBOM and notices files.
- `manifest.json` does not contain `release_receipt_sha256`, `archive_sha256`, or any pointer to the final release receipt.
- `manifest.json` does not hash itself. Its exact bytes are bound externally as `manifest_sha256`.
- The final release receipt is generated only after the archive bytes are final. It is outside the archive and binds the recomputed `archive_sha256`, `manifest_sha256`, `sbom_sha256`, and `notices_sha256` values in one direction.
- Repacking the archive changes `archive_sha256` and therefore requires a new final release receipt. Regenerating the receipt does not change the archive or manifest.

## macOS app-like archive layout

`darwin-aarch64` candidates use one frozen app-like bundle layout below the archive root:

```text
OrionCodeSidecar.app/
└── Contents/
    ├── Info.plist
    ├── MacOS/orion-code-acp
    └── Resources/
        ├── NODE_LICENSE
        ├── runtime/node
        └── app/
```

- The artifact manifest and update-index target both use the exact relative command `OrionCodeSidecar.app/Contents/MacOS/orion-code-acp`. The manifest Schema remains platform-neutral, while this target-specific semantic rule is enforced by the producer and Studio's macOS verifier. The release fixture and golden index use the same value.
- The bundle identifier is a required release input. The builder has no product default and must not infer or invent the production identifier. Tests use the explicit non-production identifier `invalid.example.orion-code-sidecar.fixture`.
- `Info.plist` is emitted with deterministic UTF-8 XML bytes. `CFBundleIdentifier` comes from the required input, `CFBundleExecutable` is `orion-code-acp`, `CFBundleShortVersionString` is the numeric core of the package SemVer, and `CFBundleVersion` is the decimal `SOURCE_DATE_EPOCH` value. The full exact SemVer remains bound by `manifest.json` and the external receipt.
- The external release receipt records `artifact.bundle_id`. Receipt replay regenerates the expected `Info.plist` bytes from the bound version, source epoch, and bundle ID, and rejects any mismatch.
- The embedded Node executable, its license, the ACP launcher entry, application modules, dependencies, and runtime resources are all inside the app bundle. Root-level `manifest.json`, `SBOM.cdx.json`, `THIRD_PARTY_NOTICES`, and `LICENSE` remain archive verification evidence rather than executable bundle contents.

## Sequence, lifetime, and replay

- `sequence` is a non-zero unsigned 64-bit monotonic value. A consumer accepts it only when it is greater than its highest accepted sequence.
- A release pipeline must allocate sequence values from a durable monotonic ledger. It must never reuse a sequence for different bytes after that sequence has been signed.
- `generated_at` may be at most five minutes ahead of the consumer clock.
- `expires_at` must be later than `generated_at` and later than the consumer's current time.
- Expiry blocks discovery of new candidates; it does not invalidate an already verified, non-revoked local installation.
- Changing Stable/Beta or Automatic/Manual settings does not reset the highest accepted sequence.

The Schema checks field shape and `sequence >= 1`; clock ordering and replay require state and are semantic checks.

### Same-version policy transitions

An immutable version and its artifacts may be carried into a higher-sequence index without rebuilding or duplicating the archive. Every transition still supplies the original external receipt and archive so the producer can replay all artifact bindings before copying the existing target object unchanged.

Only these release-policy fields may change for an existing version:

- `rollout_basis_points`: may stay equal or increase, including the standard `500 -> 2500 -> 5000 -> 10000` progression; it must never decrease.
- `status`: `active` may become `paused` or `revoked`; `paused` may resume `active` or become `revoked`; `revoked` is absorbing and can never return to `paused` or `active`.
- `rollback_to`: may be added only while `paused` or `revoked`. Once non-null, it cannot be changed or cleared. It must name a strictly lower, non-revoked release in the same index with at least one common target.

The following fields are immutable for the version: `version`, `channel`, `published_at`, `studio_version_requirement`, `acp_protocol`, `rollout_salt`, `release_notes_url`, the complete target set, `archive_url`, archive filename, `archive_bytes`, `archive_sha256`, `format`, `command`, `manifest_sha256`, `sbom_sha256`, and `signing_requirement`. Supplying any immutable release input during a policy transition is optional, but a supplied value must exactly match the previous index. The new `sequence` and `generated_at` must both be greater than the previous index values.

## Key rotation

The v1 index cannot grant trust to a key named inside its own unverified payload. A `key_id` only selects a public key already embedded in Studio.

Rotation therefore requires one of these paths:

1. Ship a Studio version that embeds the new public key, retain the old key for an overlap window, and begin signing with the new `key_id` only after the compatible Studio population is eligible.
2. Introduce a separately versioned delegation contract authenticated by an already trusted key, then add explicit delegation verification to Studio before using it.

This v1 schema does not define delegation. A release job must not place a public key, key URL, or trust instruction in the update index, and unknown keys remain a fail-closed `signature.unknown_key` result.

## Index selection and semantic validation

After Schema validation, producers and consumers apply the same semantic rules:

- Versions and rollback targets are exact SemVer values; Stable versions cannot contain prerelease identifiers.
- Every version string is unique across the index, even when two release objects otherwise differ.
- Studio version requirements must parse as SemVer requirements, and `acp_protocol` must be supported.
- Active releases contain at least one target. Candidate resolution still returns `candidate.no_match` when the current platform target is absent.
- Runtime archive host allowlists are applied in addition to the Schema's HTTPS, no-credentials, no-query, and no-fragment rules.
- Archive, manifest, SBOM, notices, and file digests are recomputed from final bytes rather than trusted from build-time temporary values. The external final release receipt is generated last from those recomputed values.
- Artifact paths are normalized relative slash-separated paths. Extraction additionally rejects links, duplicate destinations, device files, case-folding collisions, and decompression bombs.
- `rollout_basis_points` is in `0..=10000`. Eligibility is local and deterministic; no installation identifier or cohort value is uploaded.
- A non-null `rollback_to` is valid only on a paused or revoked source release, names a strictly lower version present in the same higher-sequence index, and resolves to a non-revoked compatible target. It never authorizes an arbitrary downgrade.
- Artifact manifests must contain unique normalized file paths, even when differing metadata would evade JSON Schema's whole-object `uniqueItems` check.

JSON Schema cannot compare two timestamps or SemVer values, enforce uniqueness by one object property, apply a runtime host allowlist, or consult local sequence state. Those checks are mandatory after Schema validation and before candidate selection.

## Error classification

Error identifiers are stable machine categories; human messages may add detail. A failure must retain its original layer and must not be remapped to a signature failure merely because updating cannot continue.

| Identifier                            | Meaning                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.fetch`                     | DNS, TLS, timeout, redirect, HTTP status, or body transfer failure before cryptographic verification.                                       |
| `envelope.too_large`                  | Signature envelope exceeds 4 KiB.                                                                                                           |
| `envelope.invalid_json`               | Envelope is not valid JSON or contains unknown/missing fields.                                                                              |
| `envelope.unsupported_schema`         | Envelope `schema_version` is not `1`.                                                                                                       |
| `envelope.unsupported_algorithm`      | Envelope algorithm is not `ed25519`.                                                                                                        |
| `envelope.invalid_signature_encoding` | Signature is not canonical base64 for exactly 64 bytes.                                                                                     |
| `signature.unknown_key`               | `key_id` is not in Studio's trusted key set.                                                                                                |
| `signature.invalid`                   | Ed25519 verification of the exact index bytes failed.                                                                                       |
| `index.too_large`                     | Index exceeds 1 MiB.                                                                                                                        |
| `index.invalid_json`                  | Verified bytes are not valid closed-schema JSON.                                                                                            |
| `index.unsupported_schema`            | Index `schema_version` is not `1`.                                                                                                          |
| `index.zero_sequence`                 | Sequence is zero.                                                                                                                           |
| `index.sequence_replay`               | Sequence is not greater than the highest accepted sequence.                                                                                 |
| `index.generated_in_future`           | Generation time exceeds the five-minute clock-skew allowance.                                                                               |
| `index.expired`                       | Expiration is not later than the current time.                                                                                              |
| `index.invalid_lifetime`              | Expiration is not later than generation.                                                                                                    |
| `release.invalid_contract`            | SemVer, requirement, rollout, URL, target, digest, command, Stable signing, duplicate-version, or rollback rule failed.                     |
| `candidate.no_match`                  | A valid index has no release matching channel, version, compatibility, target, rollout, or revocation policy; this is not index corruption. |
| `artifact.invalid_manifest`           | Manifest Schema or semantic file-list validation failed.                                                                                    |
| `artifact.digest_mismatch`            | Archive, manifest, SBOM, notices, or nested file bytes differ from the declared digest.                                                     |
| `artifact.unsafe_archive`             | Extraction encountered traversal, link escape, duplicate entry, device entry, or an enforced size limit.                                    |
| `artifact.platform_trust`             | Required Developer ID/notarization, Authenticode, or platform verification failed.                                                          |
| `artifact.preflight`                  | Isolated ACP startup/health validation failed after artifact verification.                                                                  |
| `release_receipt.invalid_binding`     | The external final release receipt does not match recomputed archive, manifest, SBOM, or notices digests.                                   |

## Fixture expectations

All invalid fixtures use the update-index schema and isolate the named failure:

| Fixture                          | Expected rejection                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid/rollout-10001.json`     | `release.invalid_contract`: rollout exceeds 10,000 basis points.                                                                          |
| `invalid/unknown-field.json`     | `index.invalid_json`: closed root object rejects `authority`.                                                                             |
| `invalid/http-url.json`          | `release.invalid_contract`: archive URL is not HTTPS.                                                                                     |
| `invalid/path-traversal.json`    | `release.invalid_contract`: command contains `..`.                                                                                        |
| `invalid/stable-prerelease.json` | `release.invalid_contract`: Stable uses prerelease SemVer.                                                                                |
| `invalid/rollback-abuse.json`    | `release.invalid_contract`: active release claims rollback authority.                                                                     |
| `invalid/duplicate-version.json` | `release.invalid_contract`: duplicate release version. The fixture repeats the complete release so Draft 7 `uniqueItems` also rejects it. |
| `invalid/missing-target.json`    | `release.invalid_contract`: active release has no targets.                                                                                |

## Cross-repository digest gate

The Orion Code producer copy and the Studio consumer copy must contain byte-identical JSON contract files. CI computes a deterministic manifest over every `*.json` file below this directory:

1. Use paths relative to `orion-code-update-v1/`, with `/` separators.
2. Sort paths by raw UTF-8 byte order.
3. For each file, append lowercase SHA-256, two ASCII spaces, the relative path, and `\n`.
4. SHA-256 the resulting manifest bytes for the aggregate contract digest.

The following command emits the per-file manifest and aggregate digest without parsing or rewriting JSON:

```bash
CONTRACT_DIR=docs/architecture/orion-code-update-v1
node - "$CONTRACT_DIR" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2]);
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(absolute);
  }
}

collect(root);
files.sort((left, right) =>
  Buffer.compare(Buffer.from(path.relative(root, left)), Buffer.from(path.relative(root, right))),
);

const manifest = files
  .map(file => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${digest}  ${relative}\n`;
  })
  .join('');

process.stdout.write(manifest);
process.stderr.write(
  `contract-sha256 ${crypto.createHash('sha256').update(manifest).digest('hex')}\n`,
);
NODE
```

Run it once against each repository, redirect stdout to separate temporary manifests, and require both `cmp` on the manifests and equality of the reported aggregate digest. A mismatch blocks index generation and release publication.

## Local validation

Parse every contract document without building Orion Code:

```bash
find docs/architecture/orion-code-update-v1 -type f -name '*.json' -print0 \
  | xargs -0 -n1 jq empty

node -e "const fs=require('fs'); const path=require('path'); const root='docs/architecture/orion-code-update-v1'; for (const dir of ['', 'golden', 'invalid']) for (const name of fs.readdirSync(path.join(root, dir || '.'))) if (name.endsWith('.json')) JSON.parse(fs.readFileSync(path.join(root, dir, name), 'utf8'));"
```

Schema tests must compile all four schemas, accept both golden fixtures against their respective schemas, and reject every file under `invalid/` against `update-index-v1.schema.json`. Cryptographic tests must generate a real key and signature at test time; they must not treat the schema-only signature fixture as authentication evidence.
