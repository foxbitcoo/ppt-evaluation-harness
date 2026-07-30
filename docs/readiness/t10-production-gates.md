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

This proves schema availability only. No real evaluation record, page
evidence record, or commit marker has yet been accepted as a production run.

## Report Docx — setup complete, final delivery pending

The pre-provisioned report document is:

- token: `LgCddKprAo7uauxbUdoczeDinxe`
- URL: `https://my.feishu.cn/docx/LgCddKprAo7uauxbUdoczeDinxe`
- latest setup/readback revision observed: `5`

Production writes the document once per projection revision as a complete
report collection: one Chinese H1, then the primary report and every current
auxiliary A/B report as independently identified sections. It does not
overwrite the same Docx once per report. The commit marker stores the complete
collection hash and maps every included report ID to this one Docx.

Delivery uses `docs +update --command overwrite --doc-format markdown`, then a
full Markdown `docs +fetch`. Success requires:

- update success with no warnings and the exact configured origin/token;
- a non-regressing revision;
- exact normalized collection content, every report ID, every per-report
  payload hash, and the collection hash;
- replay readback of the full collection before a matching marker is trusted.

The setup probe succeeded, but the final real three-provider report has not
been written. That remains an external acceptance gate.

## Page evidence — Feishu-native implementation ready

There is no public resolver dependency. Each static page is persisted as:

1. one stable Base record, `artifactId:page:<n>`, in `运行记录`;
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

## Frozen local executables — implementation attested

- Codex Judge:
  `/Applications/ChatGPT.app/Contents/Resources/codex`
  - SHA-256:
    `fb2b6b35789e59c885cf4d2aee12475809dd67b2c10df580e638122fd6b3438e`
- macOS Seatbelt:
  `/usr/bin/sandbox-exec`
  - SHA-256:
    `8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16`
- Lark Node runtime:
  `/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/node`
  - SHA-256:
    `1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8`
- Lark CLI script:
  `/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/scripts/run.js`
  - SHA-256:
    `b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577`

The Judge runs in a fresh temporary root under a pinned Seatbelt profile.
Reads and writes under `/Users`, `/Volumes`, and shared temporary roots are
denied except the invocation root and the two exact Codex bootstrap files
needed for configuration/authentication. Agent shell, unified-exec, code-mode,
app, and plugin tool features are disabled. Preflight proves an allowed read,
a denied outside-root read, and sandboxed login; execution evidence records the
profile and attestation hashes. Any executable or profile drift fails closed.

The local attestation is implementation evidence. A successful real Judge call
and persisted non-Mock score lineage are still required for production
acceptance.

## Recovery and real-provider acceptance — pending

Before any provider adapter runs, production:

- checks Feishu for a Job marker, Job row, or any selected vendor Run row;
- reads durable attempt-1 checkpoints and suppresses retry for submitted or
  unknown states; and
- writes and reads back a stable remote Job claim.

A matching completed marker is never accepted on self-reported marker payload
alone: page records and the complete Doc collection are revalidated against
their remote objects.

Production acceptance still requires one real 16-page volcano run for WPS AI
PPT, Qwen, and Doubao, followed by the Feishu projection and report readback.
Mock outputs cannot enter production lineage. A provider without a captured,
hash-verified PPT remains partial rather than receiving zero. A degraded static
render retains the Artifact, skips the Judge, and reports visual quality as
`NOT_ASSESSABLE`.
