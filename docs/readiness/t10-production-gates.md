# T10 production readiness gates

This file records fail-closed external gates. Passing unit or Mock acceptance
tests does not satisfy them.

## Lark Base physical schema

A live read on 2026-07-30 observed only these physical tables:

- `运行记录` (`tblXeULVGlrkD6Zt`)
- `竞品收费与档位` (`tblNIFSZEjm9nsp5`)

The required `题库`, `产物评分`, and `产品差距卡` tables do not yet exist.
The current `运行记录` table also does not contain the generic structured
payload and payload-hash fields required by the production projection.
No production run may start until the migration is applied and read back.

The intended mapping uses four evaluation tables, not one physical table per
logical record kind:

| Logical kind | Physical table |
|---|---|
| `cases` | `题库` |
| `runs`, `artifacts`, `commit_markers` | `运行记录` |
| `scores` | `产物评分` |
| `comparisons`, `workflow_events` | `产品差距卡` |

`竞品收费与档位` remains reference/configuration data and is not part of the
transactional projection batch.

Every mapped table must expose the configured stable-ID, structured-payload,
and payload-SHA256 fields. `运行记录` must also expose the configured PPT
attachment field. `VerifiedLarkCliTransport.preflight()` reads every mapped
physical table with `base +field-list` and fails before provider execution
when a table or field is absent.

## Report document

The concise report is a real Feishu Docx document, not a fifth Base table and
not a Base record URL. Production requires a pre-provisioned Docx token in the
configured environment variable. Preflight reads the document. Delivery uses
the reviewed `lark-cli docs +update --command overwrite --doc-format markdown`
command, then `docs +fetch` and verifies that the remote content contains the
stable report ID and projected payload hash.

Pre-provisioning is deliberate: it gives retries one fixed document identity
and prevents a crash between document creation and token persistence from
creating duplicate reports. Creating and granting access to that document is
an external setup gate.

## Page evidence resolver

A Base URL cannot be treated as a page-evidence URL. Comparison reports need a
deployed resolver that maps:

- `artifactId + pageNumber` to the readable uploaded page attachment or its
  Base record; and
- uploaded attachment tokens to readable evidence.

Production configuration must provide both the resolver base URL and a health
URL. Preflight requires an HTTPS `200` JSON response:

```json
{
  "service": "ppt-evaluation-evidence-resolver",
  "status": "ready"
}
```

Until that resolver is deployed and its returned links are opened successfully
under the evaluation account, evaluation mode is blocked. `capture_only` does
not create scores, comparisons, product-gap cards, or a report and therefore
does not require the report document or evidence resolver.

The Base web URL is configured separately and is used only for real Base
record links. It must never be synthesized from the resolver URL. Likewise,
the report URL is taken from the `docs +fetch` readback, must match the
configured Feishu origin and exact Docx token, and is not constructed from a
caller-provided display host.

## Frozen local executables

- Codex Judge executable:
  `/Applications/ChatGPT.app/Contents/Resources/codex`
- Reviewed version: `codex-cli 0.146.0-alpha.3.1`
- Reviewed SHA-256:
  `fb2b6b35789e59c885cf4d2aee12475809dd67b2c10df580e638122fd6b3438e`
- Lark executable:
  `/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/lark-cli`
- Reviewed SHA-256:
  `b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577`

Any executable drift requires explicit review and a new frozen digest. The
runtime must not silently accept it.

The Judge runs from a new isolated temporary cwd, treats slide content as
untrusted data, and rejects any Codex JSONL event other than reasoning and one
final agent message. Command, MCP, browser, and file-read events fail closed.
This is detection, not an operating-system guarantee that a read-only child
cannot inspect files outside its cwd. An OS-level allowlist sandbox for the
Codex subprocess has not yet been attested, so production evaluation preflight
currently blocks after login verification. This gate must not be bypassed on a
machine that contains unrelated user or credential files.

## Real-provider acceptance

Production readiness still requires a real WPS AI PPT, Qwen, and Doubao run.
Mock outputs cannot enter production lineage. A provider without a captured,
hash-verified PPT Artifact remains partial; it is not assigned a zero score and
does not borrow another provider's output. A degraded or otherwise
unreviewable render remains `NOT_ASSESSABLE` for visual dimensions until a
faithful static rendering surface is available.
