# Doubao real adapter smoke record

Status: `COMPLETED_WITH_RENDER_WARNINGS`

Public harness replay status:
`OBSERVED_REAL_PROVIDER_REPLAY_INGEST_RECOVERED`

Issue: `#10`

Browser: existing signed-in user Google Chrome session only

Run date: `2026-07-27` (`Asia/Shanghai`)

This record contains observations from one production Attempt. It does not
promote the product output to a quality baseline, and it does not expose
cookies, authorization data, personal identifiers, browser storage, or hidden
reasoning.

## Retained historical provider replay

On `2026-07-28`, the retained historical provider PPTX and the same 16 PNGs were ingested
through the public `DoubaoProductionReplayAdapter` as
`PRODUCTION_REPLAY` / `REAL_PROVIDER_CAPTURE`. No browser rerun occurred.

- The OPC validator opened the real PPTX, validated its ZIP records,
  relationships, inactive-content policy, and 16 slide parts.
- The authorized safe-raster path decoded and normalized every real PNG,
  generated a 4×4 contact sheet, and kept capture, rendering, fidelity, and
  scoring as separate states.
- The dual-copy `ArtifactVault` recovered the exact original hash and all 33
  derivatives.
- The `RunSpecification` retained the allowlisted Doubao driver runtime,
  configuration digest, browser-profile digest, replay provenance, and capture
  source.
- Recovery is additionally anchored to the harness-owned, versioned checkpoint
  `doubao-volcano-20260727-real-provider-v1`. The recovered bundle cannot
  nominate its own trusted driver, build, renderer, Artifact hash, or replay
  receipt, and the production CLI rejects the offline validation fixture
  checkpoint before opening any recovery store.
- The recovery CLI reparses the retained original as a safe 16-slide OPC/PPTX
  package. It also verifies each of the 16 slide derivatives and the contact
  sheet as decoded PNG bytes with bounded dimensions before accepting their
  hashes; text with self-consistent hashes cannot stand in for either format.
- Four durable Attempt checkpoints were recovered. The cross-process profile
  lock and the recovery CLI were both exercised.
- The retained slide 9 clipping and slides 2–16 overflow warnings remain
  degraded-fidelity notes. Submit count is 1 and retry count is 0.

Machine-readable evidence:
`docs/smoke/doubao-real-provider-replay-2026-07-28.json`. The later
current-verifier recovery attestation is retained as
`evidence/doubao-v33-current-verifier-recovery.json`; the append-only evidence
history and current pointer are recorded in
`evidence/doubao-recovery-evidence-index.json`. Its `recordedOn` value is
date-only and its `timingBasis` is
`date_only_unobserved_exact_time`: the successful CLI result was retained, but
no independently trustworthy exact CLI-completion timestamp was observed, so
the evidence does not manufacture a midnight timestamp.

The current-verifier evidence distinguishes the exact raw CLI stdout hash from
the stable attested recovery-result hash. The raw hash is associated with the
current-workstation verifier reproducibility identity that appears in that same
CLI result. Because `node --import tsx` performs this source/toolchain check
only after Node and the loader have started, that identity is not an independent
bootstrap, signed attestation, or tamper-proof proof of executed code. “Raw”
means the exact UTF-8 stdout bytes, including the CLI's single terminal LF;
no trimming or whitespace normalization occurs before hashing. The JSON parser
may accept surrounding JSON whitespace, but that does not alter the raw-byte
attestation. The
attested hash uses the versioned
`doubao-recovery-result-attestation-v1` view: it includes every recovery,
lineage, authorization, and binary-validation field, while excluding only the
current verifier build identity that necessarily changes when executable
source is frozen. The evidence records the exact verifier build identity that
produced both hashes and retains the raw post-freeze CLI result as a separate
checked-in evidence file.

The current 2026-08-02 T10 rehearsal used the v2 durable-root registry
`doubao-real-provider-20260802-t10-v33`. Historical v30 through v32 recovery
evidence remains unchanged. v32 binds the same six narrow retained roots to
their canonical path, device, inode, owner, and mode before recovery and binds
the reported current-workstation reproducibility identity to the observed
TypeScript runtime toolchain bytes. This is verifier-side storage and
post-start reproducibility checking, not independent execution attestation, a
new provider generation, or a change to the retained Artifact. A signed
bootstrap or native frozen verifier remains required for stronger execution
provenance.

## Fixed protocol

- Use the current signed-in account.
- Use the default/best path available without accepting an upgrade or making a
  new incremental payment.
- Enable networking/search.
- Submit the frozen `volcano-query-v1` vendor prompt requesting exactly 16
  pages.
- Cap the Run at 30 minutes.
- Retry at most once, and only after observable proof that the first Attempt was
  not submitted.
- Never retry a successful output for quality, and never automatically
  resubmit an unknown submission.
- Do not inspect or persist cookies, authorization data, passwords,
  `localStorage`, `sessionStorage`, browser profiles, or hidden reasoning.

## Observable package evidence

| Field | Result |
|---|---|
| Actual Doubao URL | `https://www.doubao.com/chat/38435879568317954` (query payload omitted) |
| Current-account signed-in evidence | Account control and populated conversation history were visible; the personal account label was omitted |
| Visible plan/tier | Not exposed in the PPT task UI |
| Visible model | Not exposed in the PPT task UI |
| Visible mode | `PPT 生成`; `篇幅 详细`; style left at visible `智能匹配` default |
| Networking/search | Enabled by observable execution: `正在收集 PPT 素材` and the visible statement that the task was passed to a search tool |
| Requested page count | 16 in the submitted prompt; the completion message also stated 16 pages |
| Incremental payment required | No payment, upgrade, quota, or purchase prompt was shown before submission, generation, or export |

The absence of visible plan and model controls is preserved as unknown rather
than inferred from account state. The run used the existing default path and
did not accept any upgrade.

## Attempt and Artifact evidence

| Field | Result |
|---|---|
| Attempt started at | `2026-07-27T18:34:46+08:00` |
| Submission evidence | New conversation created; frozen prompt visibly echoed; status advanced to `思考中` |
| Vendor task reference | Conversation `38435879568317954`; the harness stores this as typed ID `task_38435879568317954` |
| Generation-ready at | Conservatively recorded at the artifact-capture observation, `2026-07-27T18:45:58+08:00`; the UI separately showed `已完成PPT生成(9m 31s)` and a completed 16-page editor before export |
| Export-ready at | `下载` became enabled after the completion message |
| Artifact captured at | `2026-07-27T18:45:58+08:00` |
| Filename and MIME type | `doubao-volcano-16.pptx`; `application/vnd.openxmlformats-officedocument.presentationml.presentation`; 5,184,523 bytes |
| Artifact SHA-256 | `ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4` |
| Exported page count | 16 slide XML parts in a valid OOXML ZIP package |
| Static render count | 16 PNG files, each 1600×900 |
| Artifact directory | `/Users/chenyifan/Downloads/doubao-volcano-16-smoke-20260727-1845` |
| Manual actions | `open a new Doubao task`; `select PPT mode`; `select detailed length`; `retain intelligent matching`; `enter the frozen 16-page Volcano prompt`; `submit exactly once`; `observe vendor completion label: 9m 31s`; `observe completed 16-page editor and enabled Download control`; `choose Download -> PPTX exactly once`; `validate the one retained PPTX after the download listener timed out`; `do not click export again; do not retry` |
| Terminal reason | Generation, PPTX capture, hash, page-count validation, and 16 static renders completed; no retry |

The browser download-event listener did not emit a completion event within its
timeout, but the PPTX appeared in the Downloads directory with the current run
timestamp. Validation used that one downloaded file; export was not clicked a
second time.

The retained Trace deliberately uses only two exact wall-clock observations
that were actually captured: Attempt start/submission at
`2026-07-27T18:34:46+08:00`, and Artifact capture at
`2026-07-27T18:45:58+08:00`. Because no separate trustworthy wall-clock
timestamp was retained for the completion transition, `generation_ready` uses
the latter as a conservative upper bound. The vendor's `9m 31s` label is kept
verbatim as vendor-reported elapsed time and is not subtracted to manufacture
an exact milestone. The retained source/completion URL and raw vendor task
reference are both
`https://www.doubao.com/chat/38435879568317954` /
`38435879568317954`; the Trace's schema-prefixed `vendorTaskId` is
`task_38435879568317954`.

Trace `ui://doubao/*-audit-anchor` values are opaque, secret-free anchors back
to this manually reviewed observation record. They are not URLs or filesystem
paths for retained screenshots, and this evidence package does not claim that
downloadable screenshot files exist.

Recovery canonicalizes the complete ordered four-event checkpoint Trace,
rejects every non-schema field, and requires its hash to match the
harness-owned recovery checkpoint before returning trusted recovery output.
The retained PPTX must also decode as exactly 16 safe OPC slides, and both the
driver metadata and decoded slide count must independently equal 16.
Artifact, execution-evidence, receipt, Run Specification, product/driver,
render-manifest, derivative, and recovery-result objects all use explicit
exact-key schemas. The trusted checkpoint also pins the complete frozen
evaluation Case hash, vendor-prompt hash, Case version/track, protocol, and
Reference Pack mode, so a self-hashed replacement Query is not recoverable.

## Static render hashes

| Slide | SHA-256 |
|---:|---|
| 1 | `e2063561a936f7a181a0808f74b9a7d64bdc57e03e16b3fe787218146ede8c8d` |
| 2 | `0a7385084c380152b3dbed2d96f6ba6b7f8a15df43aabc162bf6a15433ec54e9` |
| 3 | `3a00b03117a90afb7312dc0d22f24d9b42e39aa371c87b008c2b9901b5646672` |
| 4 | `03aa342ded31f76055e554af0cf47f7397dd9d70aed727118746c99756aff3e5` |
| 5 | `bc4ab9e21eb5f7b896cb4567c54a030e572d7db48c2b2391131e2ff09ffa8675` |
| 6 | `e16f0992813309063679273f0195e308ef4f57890b2f60ec08bde7990cac9b50` |
| 7 | `8b39e064a51918c560546892042b6739ae97f9e250650152093070ecf7f3c0b7` |
| 8 | `709d40c631e46957a0dbb24e003d7d8a8c38c3b6cfcae06c929edcdcd2af0cb9` |
| 9 | `cdaa13805309f4adbcd508eb11db1117752f74c51938751e904ce0e1d314d617` |
| 10 | `9d66a0fd7fbabad81b67f3d29e5186f6e4ea315afe96ce720c5701e38a4780fc` |
| 11 | `39bdb80dfcdfd8527837fa481955bf0ffb16950d045dab3da5fca6a315c580d9` |
| 12 | `7fd3bd1e9fe7128242c1a42f1d8016f578149d4699b43acefdd6b5ea43ace31b` |
| 13 | `d4e2beafee1a2f4efe59cf6f8a4999f174427271e3b042ebbe7623496729cd33` |
| 14 | `4e624bbe6c84dc74b8a70835f196f6094a3a38dd53d395c0942b235534bd6189` |
| 15 | `824683a2bdbcdcb84266f1a09a86711fedc99a5ce8de0727b5f4cad79598127d` |
| 16 | `6a0f7fd6f6ca4a95d120a7af50579ad546982b9c89221375a8f0697695bf7bfa` |

## Render observations

- All 16 slides produced readable, non-empty static PNG renders.
- Slide 9's title is visibly clipped above the slide canvas.
- Several slides contain dense text or awkward wrapping. The presentation
  overflow checker reported content outside the original canvas on slides
  2–16.
- These are evaluation observations, not reasons for a quality retry. The one
  successful vendor output remains the captured Artifact.

## Stop conditions

Stop without submission on authentication, CAPTCHA, payment, quota, or
configuration ambiguity. After a submitted Attempt, stop without resubmission
when submission state becomes unknown. Keep export, download, render, and
page-count failures distinct from vendor-generation success.
