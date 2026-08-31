# T10 production readiness gates

This file separates implementation readiness, external setup evidence, and
real-provider acceptance. Mock tests and schema probes are not provider
acceptance.

## Lark Base physical schema — external setup complete

The 2026-07-30 migration was applied and read back:

| Logical kind | Physical table |
|---|---|
| `cases` | `题库` (`tblgCGNkvK6taXB4`) |
| `runs`, `artifacts`, `commit_markers` | `运行记录` (`tblXeULVGlrkD6Zt`) |
| `scores` | `产物评分` (`tblVFOzP8y5PSZgb`) |
| `comparisons`, `workflow_events` | `产品差距卡` (`tblxG3ItdJiBWiO5`) |

`竞品收费与档位` remains reference/configuration data and is not part of a
transactional projection.

Each new evaluation table has the three required text fields `稳定ID`, `载荷`,
and `载荷哈希`. `运行记录` now exposes 20 fields, including those three fields
and `产物附件`. `VerifiedLarkCliTransport.preflight()` reads every mapped table
with the frozen CLI and fails before provider execution if any table or field
drifts.

Because multiple logical entities share a physical table, `稳定ID` is a
namespaced physical identity: `job:<id>`, `run:<id>`, `attempt:<id>`,
`artifact:<id>`, `page:<artifactId>:<n>`, `claim:<jobId>`, and
`commit:<jobId>`, plus typed comparison/workflow identities such as
`comparison:<comparisonId>`, `gap:<gapCardId>`, and
`gap-workflow:<workflowEventId>`. The unprefixed domain identity remains in the canonical
payload. Recovery, attachment readback, replay, and marker lookup use the same
physical identity. A single-table acceptance fake retains all entity kinds
simultaneously and proves replay does not add duplicates.

Pre-T10 rows that used `gap:<comparisonId>` or another parent ID for a child
entity are not auto-migrated: those IDs can collide and cannot prove a complete
collection. Durable auxiliary-report refresh detects the legacy gap form and
fails closed with an operator-migration requirement. The operator must remove
or rewrite the colliding legacy rows to the typed IDs above before retrying;
the harness does not silently treat them as compatible.

Production Base mutation is deliberately limited to one workstation. Verified
production accepts only the build-reviewed machine-global lock root
`/Users/Shared/ppt-evaluation-harness-lark-locks-v1`; a caller cannot select a
different root. Before registration and every later mutex or lease-sentinel
operation, the root must resolve to itself, be a non-symlink directory owned by
the current user with mode `0700`, and retain the originally registered
device/inode/owner/mode identity. Production never derives it from `TMPDIR` or
another process-scoped directory. The mutex is the reviewed `/usr/bin/lockf` OS
advisory lock, attested by canonical path, exact executable hash, and exact
usage/version contract before acquisition. The lock holder emits a no-shell
handshake only after `lockf` owns the lock; release waits for the holder to
exit, and an owner crash closes its pipe so the OS releases the lock without
stale-file deletion. If an acquired holder exits before an explicit release,
the owner process immediately fail-stops; it cannot continue a critical
section after another worker can acquire the OS lock.

Lock names do not depend on operation scope, Job ID, caller labels such as
`targetAccount`, or on a raw URL spelling. Claim, whole-projection, and
stable-record operations therefore contend on the same physical resource
locks even across different Jobs. The Base resource boundary acquires one
deterministic lock for each configured Base-token/physical-table-ID pair, in
sorted order; reentrant calls inside the same critical section reuse the
already-held physical locks. Two
configurations with only a partially overlapping table mapping therefore still
serialize on every shared physical table. Claim and report-bearing projection
locks also acquire a deterministically ordered Docx resource lock bound to the
exact document token and canonical Feishu origin. Production rejects Base URLs
with a trailing slash, query, fragment, non-canonical spelling, or an origin
alias.
It covers each stable-ID search, create, and readback; an
already-corrupt duplicate set fails closed and is never “repaired” by deleting
a record another process may already use. The same boundary covers a complete
Job projection from marker read through Docx CAS, Base rows and attachments,
and the final marker. This does not claim distributed multi-host transaction
safety.

This proves schema availability only. No real evaluation record, page
evidence record, or commit marker has yet been accepted as a production run.

## Report Docx — per-Job provisioning required, final delivery pending

The previously pre-provisioned report document is:

- token: `LgCddKprAo7uauxbUdoczeDinxe`
- URL: `https://my.feishu.cn/docx/LgCddKprAo7uauxbUdoczeDinxe`
- last setup/readback revision observed: `5`

The current configuration exposes one Docx token, so the transport treats that
token as a single-Job slot. The first production claim atomically binds an
empty document to one Job with an exact remote revision compare-and-swap.
The claim payload and document owner use a versioned claim-v3 state machine
with an execution lease, process identity, per-lease OS advisory sentinel, and
monotonic epoch. PID and process-start fields remain audit metadata;
cross-process liveness comes from the sentinel, so same-second PID reuse cannot
keep or steal a lease. A live lease cannot yield a second winner; after a dead
local owner is observed, one new lease can take over under the durable Job
mutex and increments the epoch.
Before provider submission, the active owner can transition its current lease
to `aborted_before_submission` only when every selected attempt has at least
one durable checkpoint and every checkpoint is still `not_submitted`. The
abort records the exact not-submitted attempt IDs, abort time, claim epoch,
owner token, PID, and OS process-start identity. A later claimant must create a
new epoch; an old owner cannot revive or overwrite the aborted epoch.
The sentinel holder and all of its pipes are explicitly released after a
durable commit marker, a persisted safe pre-submission abort, or explicit
transport disposal. Unknown or submitted attempt state is not converted to a
safe abort; durable checkpoints continue to suppress unsafe provider retry
after disposal or process loss.
After that binding, production writes the document once per projection
revision as a complete report collection: one Chinese H1, then the primary
report and every current auxiliary A/B report as independently identified
sections. A different Job is rejected and cannot overwrite the document.
This is deliberately fail-closed: each production Job needs its own newly
provisioned empty Docx token (or a future configuration that supplies a token
per Job). The revision-5 setup document predates the owner-binding format and
must not be reused for a new Job without explicit external reprovisioning.

Both the owner claim and report delivery use
`docs +update --command overwrite --revision-id <exact-read-revision>
--doc-format markdown --content -`; the authorized immutable Markdown is sent
over the spawned process stdin and is never exposed through a pre-authorization
temporary file. A full Markdown `docs +fetch` follows. Success requires:

- update success with no warnings and the exact configured origin/token;
- a revision that advances the exact compared revision;
- a fetched revision exactly equal to the update response revision;
- the same owner Job in the document, report write, and commit marker;
- exact normalized collection content, every report ID, every per-report
  payload hash, and the collection hash;
- the commit marker’s exact report-document revision; and
- replay readback of that exact revision and full collection before a matching
  marker is trusted.

The old setup probe proved only that the document was readable. A fresh empty
per-Job document, owner-CAS claim, and final real three-provider report
readback remain external acceptance gates.

## Page evidence — Feishu-native implementation ready

There is no public resolver dependency. Each static page is persisted as:

1. one stable Base record, `page:<artifactId>:<n>`, in `运行记录`, whose
   payload retains logical record ID `artifactId:page:<n>`;
2. exactly one PNG attachment on that record; and
3. one native Feishu record share URL returned by the frozen
   `base +record-share-link-create` command.

A read-only live probe confirmed the real envelope shape:
`data.record_share_links[record_id] = https://my.feishu.cn/record/<token>`.
The transport accepts only the exact requested record-ID mapping, configured
Feishu origin, `/record/<token>` path, and no query or fragment.

Before a matching marker is replayed, every page record is read back by stable
ID, its canonical lineage payload and payload hash are checked, its sole PNG
is downloaded and hash-verified, and its newly resolved share URL must equal
the marker URL. Placeholder page URLs are replaced before Gap Cards, reports,
and changed Base payloads are written.

The implementation and read-only command probe are ready. Creating all page
records and opening their share URLs from the final real run remain external
acceptance gates. `capture_only` creates no scores, comparisons, Gap Cards, or
report, but retained captures still require hash-verified Artifact storage.

## Selected LIVE adapter preflight — implementation ready

Production validates every selected adapter's execution mode against its
Product Package provenance before durable claims, provider execution, or any
egress authorization is used. Every Mock, WPS, Qwen, and Doubao adapter must
return the exact deep-equal Product Package registered by the harness for its
product, mode, and implementation; caller-supplied or internally reconstructed
near-matches fail closed. `PRODUCTION_REPLAY` remains eligible only through its
harness-owned immutable capture receipt and registered, hash-verified replay
package. The WPS receipt allowlist binds the known retained Artifact, Trace,
render, and package identity. Qwen currently has no complete captured PPTX
receipt, so its retained partial attempt cannot become a production replay
Artifact. Caller-provided sessions and Mock bytes cannot mint either receipt.
For `LIVE_PRODUCTION`, the
selected harness-owned executable or bridge must already be embedded and pass
its fixed-file/hash readiness check.

This is a selection-scoped, fail-before-egress gate: an unavailable adapter
does not affect an unselected product, but selecting its LIVE mode aborts the
whole run before any network egress. The trusted WPS live bridge is checked at
preflight and again immediately before spawn. The harness-owned Qwen LIVE
executable and trusted Doubao LIVE bridge are not currently embedded, so
selecting either LIVE adapter deterministically fails this gate. Replay
coverage does not make either LIVE adapter available.

These checks prove only that unavailable LIVE implementations cannot fall
through to a caller-supplied browser or later network action. A successful
real WPS, Qwen, or Doubao run has not yet been accepted.

## Frozen local executables and renderer — implementation attested

- Codex Judge:
  `/Applications/ChatGPT.app/Contents/Resources/codex`
  - SHA-256:
    `d96ae1ca1ff6fc8587842fa04c92d3ee4d31651a811c2f89b65fcfd9c28473e2`
- macOS Seatbelt:
  `/usr/bin/sandbox-exec`
  - SHA-256:
    `8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16`
- Native Lark CLI `1.0.72`:
  `/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/bin/lark-cli`
  - SHA-256:
    `4b38c877ec833fe72c370dad3768d0564ff678fde1a488910be3e38b0a1e1238`
- Prohibited wrapper target, attested for drift detection only:
  `/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/scripts/run.js`
  - SHA-256:
    `b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577`

Production first opens and hashes the 43 MB native binary as one file object,
copies those reviewed bytes into a private executable snapshot whose directory
is mode `0500`, and then executes only that snapshot. It never executes the
`bin/lark-cli` symlink or its download-capable JavaScript wrapper and never
runs `lark-cli update`. Native hash, exact `--version` output, symlink target,
and wrapper-script hash must all match the reviewed installation; any drift
fails closed. Immediately before every read or mutation egress, one handle to
the executable snapshot supplies both `fstat` metadata and the complete bytes
for rehashing. The protected directory and executable device/inode/mode are
rechecked, that exact handle stays open, and the target spawn begins
synchronously before the handle is released. Snapshot-path replacement,
directory drift, and original-package replacement all fail closed or preserve
the already captured original bytes.

Every Lark CLI subprocess, including identity checks and the version probe, has
a hard deadline, a 16 MiB stdout raw-byte cap, and a 1 MiB stderr raw-byte cap
(the version probe uses smaller 64 KiB caps). A deadline, abort, or cap breach
terminates the whole process group and does not return until that group is
confirmed absent. Cleanup confirmation timers remain referenced so an orphan
descendant cannot let the supervisor exit early. A spawn failure is observed
through the child error event and never calls `kill` without a valid child PID.
Output is bounded before UTF-8 decoding or JSON parsing.

The Artifact renderer runs each fixed LibreOffice or Poppler command under a
deny-default Seatbelt profile. The profile grants no network operation,
permits process execution only for the exact selected binary (plus the frozen
LibreOffice executable subtree when LibreOffice itself is selected), denies
data reads from user, volume, and shared-temporary roots except the exact
canonical invocation root and frozen renderer/font roots, and permits writes
only inside that invocation root and `/dev/null`. Acceptance coverage executes
the real profile and proves that an invocation input is readable while a
repository file, a Codex home file, and `/bin/sh` are denied.

Entrypoint hashes alone are insufficient. Renderer startup and every render
recompute the deterministic dependency-closure digest over the complete frozen
LibreOffice and Poppler roots, system/local/user fonts, and system/local color
profiles, including directory and file modes, file contents, and symlink
targets. Renderer identity also binds the macOS build, `/usr/lib/dyld` code
directory, architecture-specific dyld shared-cache identities, and the system
runtime closure. Every Mach-O runtime object is verified with
`codesign --verify --strict --all-architectures`; its code-directory identity
and CDHash are bound into the attestation and rechecked immediately before
render. Same-size byte mutation is therefore rejected. Any dylib, plugin,
configuration, font, color profile, OS runtime, mode, signature, or symlink
drift fails closed.

Canonical 16-page, 1920x1080, sRGB raster structure is necessary but not enough
for visual fidelity. A `faithful` render additionally requires a
harness-owned, pre-registered native capture receipt plus strict native-frozen
evidence at
`<private-evidence-root>/<artifact-sha256-without-prefix>/manifest.json` plus
the 16 ordered PNGs. The receipt and manifest bind the exact Artifact hash,
native capture-tool identity, native surface class, viewport/resolution, crop
and completion-frame policies, each retained PNG byte hash, the ordered
16-page derivative set, and its aggregate digest. The WPS retained capture
receipt is subject to the same binding and cannot attest only a source PPTX or
an unverified render directory. Every native PNG must be a regular non-symlink
1920x1080 file whose bytes are identical to its canonical renderer page.
Copying canonical PNGs into a caller-selected directory cannot register a
receipt. Missing evidence
always yields `degraded` and prohibits Judge visual scoring; malformed,
misbound, or tampered evidence fails closed rather than degrading silently.

The Judge runs in a fresh temporary root under a pinned Seatbelt profile.
Reads and writes under `/Users`, `/Volumes`, and shared temporary roots are
denied except the invocation root and the two exact Codex bootstrap files
needed for configuration/authentication. Agent shell, unified-exec, code-mode,
app, and plugin tool features are disabled. Preflight proves an allowed read,
a denied outside-root read, and sandboxed login; execution evidence records the
profile and attestation hashes. Any executable or profile drift fails closed.

Every Judge subprocess also has a hard ten-minute deadline and independent
raw-byte caps of 16 MiB for stdout and 1 MiB for stderr. Exceeding the deadline
or either cap terminates the whole subprocess group, waits for termination,
and returns a bounded failure without persisting the overflowing output.
The `result.json` channel has its own 1 MiB raw-byte limit. Codex and
`sandbox-exec` identities are revalidated at every execution boundary; Codex
runs from the private, read-only verified snapshot, and a limit error is not
returned until the process group is confirmed absent within the cleanup
deadline.

The local attestation is implementation evidence. A successful real Judge call
and persisted non-Mock score lineage are still required for production
acceptance.

The recovery CLIs run as `node --import tsx`, so their embedded source/archive
check occurs only after the current workstation's Node and `tsx` loader have
already started the TypeScript program. The recorded
`verifierBuildIdentity`, `rawResultVerifierBuildIdentity`, and
`attestedResultVerifierBuildIdentity` fields are therefore
**current-workstation reproducibility identities only**: they identify the
source and local TypeScript toolchain bytes observed by that run and catch
accidental drift. They are not an independent bootstrap, signed execution
attestation, or tamper-proof proof of which code executed. Production assurance
at that stronger level requires a separately trusted signed bootstrap or a
native frozen executable whose identity is verified before any verifier code
runs. The current recovery evidence does not claim that stronger property.

## Comparison compatibility and concurrent reports — implementation ready

Every Artifact is scored independently and comparisons are derived only from
compatible score lineages. Compatibility requires equal Case and evaluation
mode, scoring schema and rubric, static-render contract, source/capture
provenance, and Judge execution identity. Judge identity includes the exact
binary, fixed arguments, Seatbelt binary and profile hashes, and sandbox
configuration. A `LIVE_PRODUCTION` capture and a `PRODUCTION_REPLAY` capture
are never treated as the same provenance merely because their PPTX bytes
match.

Unless the caller selects explicit pairs, the report includes every unordered
compatible vendor pair. It therefore still emits a Qwen–Doubao comparison when
WPS is absent or incompatible; no vendor is a hard-coded baseline.

Concurrent auxiliary-report publication stages each writer against the exact
locally committed report collection and its cached remote marker hash. Marker
publication is compare-and-swap. A stale writer rereads the committed
collection, performs a deterministic three-way merge, restages the complete
collection, and retries the marker CAS. It cannot silently overwrite a report
that another writer committed after its original read.

## Lark mutation authorization boundary — implementation ready

Every real Lark mutation is authorized inside the production transport after
any preceding read/search and immediately before the native process is
spawned. This includes Base record upsert, attachment upload, record-share-link
creation, Docx overwrite, Job claim, and commit marker. Each fresh decision is
bound to the exact target account/region, mutation kind, and canonical mutation
payload hash, is audited, and is checked for currentness again with no await
between the final check and runner invocation.

Attachment authorization hashes a cloned immutable byte snapshot; only after
the final authorization, executable attestation, and current CLI
profile/app/user/tenant revalidation does the transport materialize a
read-only file snapshot in a private invocation directory and synchronously
spawn the runner. The invocation-directory path also forwards
the disposal `AbortSignal`, so an attachment upload cannot outlive transport
shutdown. Docx writes use the equally bound stdin path.
Transport disposal is irreversible: it aborts all active process groups,
waits for every in-flight invocation to reject and disappear, then releases
the execution lease and removes the executable snapshot. All later reads,
mutex acquisition, claims, commits, and other egress fail closed; a running
mutation cannot silently report success after disposal.

An explicit CLI identity binding is mandatory for a verified production
transport. Production preflight and every subsequent target egress bind
`whoami` to the configured CLI profile,
application ID, Feishu/Lark brand, identity source, and user Open ID. The
current-user contact read must return that same Open ID and the configured
tenant key. The projection destination must exactly match that verified user
account and the brand-derived region (`feishu`/`cn` or `lark`/`global`);
caller labels cannot retarget a verified transport.

Acceptance coverage advances the clock during `record-search` until the parent
authorization expires and proves that no `record-upsert` command is invoked.

## Recovery and real-provider acceptance — pending

Before any provider adapter runs, production:

- checks Feishu for a Job marker, Job row, or any selected vendor Run row;
- creates or reads stable control checkpoints for both allowed attempts;
- computes a canonical attempt-1/attempt-2 submission-state summary and binds
  its hash into the stable remote Job claim;
- rereads that exact summary immediately after claim acquisition; and
- rereads all allowed attempt states again immediately before each vendor
  egress, suppressing retry whenever any applicable state is submitted or
  unknown.

Attempt state is monotonic: `submitted` can never be downgraded, while an
explicit durable `not_submitted` observation may resolve a prior `unknown`
control state. Replay consumes retained evidence and never writes a live
submission intent.

Only a terminal `query_not_submitted` checkpoint with an ordered
`not_submitted@N` state and matching writer/adapter identity is such an
observation. A WPS `configuration_observed` event remains non-terminal even if
its legacy payload says `not_submitted`; it cannot authorize Attempt 2. If a
confirmed non-submission does permit re-entry, all three adapters persist a new
explicit submission epoch and idempotently reuse it on repeated recovery.

The WPS production recovery CLI is bound to one harness-owned trusted
checkpoint, not to identities supplied by the bundle being recovered. It
authenticates the complete canonical Artifact, Render manifest, Run
Specification, and checkpoint payloads; verifies every retained derivative and
the safe 16-slide PPTX; and cross-binds job, Case, Run, Attempt, local Artifact,
provider Artifact reference, task, adapter, driver, renderer, and ordering. It
also independently recomputes the capture receipt's event Trace, retained-page
digest, derivative-set digest, and browser-package identity. The evaluated
historical runner identity and the current-workstation reproducibility identity
of the post-start TypeScript verifier are reported separately. The latter is
not an independent or tamper-proof execution proof. Any missing payload, extra
field, reordered checkpoint, digest drift, or lineage mismatch fails closed.

A marker-only recovery read reports
`commit_marker_present_unverified`, never `committed`. A matching completed
marker is accepted only after every Case, Run, Artifact, Score, Comparison,
Gap, and workflow row is
searched by its namespaced stable ID and must match the exact payload and
payload hash; page records and the exact-revision Doc collection are also
revalidated against their remote objects. Every `record-upsert` result is
strictly bound to create/update mode and record ID, then immediately searched
and read back before the projection continues.

Production acceptance still requires one real 16-page volcano run for WPS AI
PPT, Qwen, and Doubao, followed by the Feishu projection and report readback.
Mock outputs cannot enter production lineage. A provider without a captured,
hash-verified PPT remains partial rather than receiving zero. A degraded static
render retains the Artifact, skips the Judge, and reports visual quality as
`NOT_ASSESSABLE`.

`assertT10ProductionAcceptanceReady()` is the final code-level lineage and
closure gate. It accepts only a completed `LIVE_PRODUCTION` Job and Report with
three distinct LIVE Artifacts, faithful renders, Scorecards, and an exact HTTPS
report binding. `PRODUCTION_REPLAY` is rejected before those completeness
checks: replay may validate recovery and reporting behavior, but can never
satisfy T10 production readiness.

Therefore the current state is not end-to-end production acceptance: real
provider generation, real Lark mutation/readback, native-frozen evidence for
the resulting Artifacts, and a successful sandboxed Judge call remain pending.
