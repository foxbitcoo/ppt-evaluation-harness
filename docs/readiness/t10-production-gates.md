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
`commit:<jobId>`. The unprefixed domain identity remains in the canonical
payload. Recovery, attachment readback, replay, and marker lookup use the same
physical identity. A single-table acceptance fake retains all entity kinds
simultaneously and proves replay does not add duplicates.

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
--doc-format markdown`, then a full Markdown `docs +fetch`. Success requires:

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
egress authorization is used. `PRODUCTION_REPLAY` remains eligible only through
its registered, hash-verified replay package. For `LIVE_PRODUCTION`, the
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
    `fb2b6b35789e59c885cf4d2aee12475809dd67b2c10df580e638122fd6b3438e`
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

Production spawns the 43 MB native binary directly. It never executes the
`bin/lark-cli` symlink or its download-capable JavaScript wrapper and never
runs `lark-cli update`. Native hash, exact `--version` output, symlink target,
and wrapper-script hash must all match the reviewed installation; any drift
fails closed.

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
targets. The currently reviewed closure digest is
`sha256:4e5ea60511a1d9f11c5bbfd796f634c672d5ec6af23408a43e0a9b7a591d9fdc`;
any dylib, plugin, configuration, font, color profile, mode, or symlink drift
fails closed.

Canonical 16-page, 1920x1080, sRGB raster structure is necessary but not enough
for visual fidelity. A `faithful` render additionally requires strict
native-frozen evidence at
`<private-evidence-root>/<artifact-sha256-without-prefix>/manifest.json` plus
the 16 ordered PNGs. The manifest is bound to the exact Artifact hash, native
surface class, viewport/resolution, crop and completion-frame policies, and
each PNG hash. Every native PNG must be a regular non-symlink 1920x1080 file
whose bytes are identical to its canonical renderer page. Missing evidence
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

The local attestation is implementation evidence. A successful real Judge call
and persisted non-Mock score lineage are still required for production
acceptance.

## Lark mutation authorization boundary — implementation ready

Every real Lark mutation is authorized inside the production transport after
any preceding read/search and immediately before the native process is
spawned. This includes Base record upsert, attachment upload, record-share-link
creation, Docx overwrite, Job claim, and commit marker. Each fresh decision is
bound to the exact target account/region, mutation kind, and canonical mutation
payload hash, is audited, and is checked for currentness again with no await
between the final check and runner invocation.

Acceptance coverage advances the clock during `record-search` until the parent
authorization expires and proves that no `record-upsert` command is invoked.

## Recovery and real-provider acceptance — pending

Before any provider adapter runs, production:

- checks Feishu for a Job marker, Job row, or any selected vendor Run row;
- reads durable attempt-1 checkpoints and suppresses retry for submitted or
  unknown states; and
- writes and reads back a stable remote Job claim.

A matching completed marker is never accepted on self-reported marker payload
alone: every Case, Run, Artifact, Score, Comparison, Gap, and workflow row is
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

Therefore the current state is not end-to-end production acceptance: real
provider generation, real Lark mutation/readback, native-frozen evidence for
the resulting Artifacts, and a successful sandboxed Judge call remain pending.
