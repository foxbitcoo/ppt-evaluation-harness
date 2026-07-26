# AI PPT Evaluation Framework

Status: Proposed — experimental, not yet calibrated  
Version: 0.2  
Updated: 2026-07-27

## 1. Purpose and claim boundary

### Short term

Serve the WPS AI PPT team with a Live Bake-off: submit the same versioned Evaluation Case to selected products, capture observable execution evidence and immutable Artifacts, evaluate each Artifact, and expose dynamic comparisons. WPS is a stakeholder and candidate, not a permanently fixed baseline.

The short-term output must help the team answer:

1. What observable quality or delivery gap exists?
2. On which pages and cases does it occur?
3. Which product-pipeline stage may be responsible?
4. What experiment should be run next?

### Long term

Build a user-facing PPT Selection Evaluation. It must distinguish three evidence layers:

- **Artifact Quality**: what quality the generated presentation exhibits;
- **Human Preference**: what defined user groups actually prefer in blind research;
- **Selection Utility**: which product best fits a user's scenario, budget, latency, editability, collaboration, privacy, and export constraints.

LLM scoring or LLM Pairwise Judgment alone must never be described as “what users like.”

### Claim levels

| Level | Minimum evidence | Allowed claim |
|---|---|---|
| Case sample | One Attempt for one Case × Product Package | “This captured output exhibited…” |
| Exploratory comparison | A small declared set of Cases or fewer than 3 independent Attempts per cell | “In this pilot sample…” |
| Stable case comparison | At least 3 policy-compliant Attempts per Case × Package, including failures | Case-level distribution, success rate, and uncertainty |
| Suite comparison | A preregistered, scenario-stratified Benchmark Suite with repeat runs and calibrated Judges | Suite-level findings with confidence intervals |
| User recommendation | Suite evidence plus segmented human preference and utility inputs | Recommendation for the declared user/scenario |

Single-run MVP evidence cannot be promoted into a general vendor ranking.

## 2. Evaluation tracks

Each Evaluation Case belongs to exactly one track. Scores and rankings never cross tracks.

### Query Generation Track

The product plans and generates a presentation from a short user request without a source document. It is evaluated for task interpretation, content correctness and substance, coverage and selection, narrative, audience fit, and presentation design.

### Document Generation Track

The product transforms a supplied source document into a presentation. It is evaluated for source fidelity, key-information completeness, selection and compression, narrative transformation, audience fit, and presentation design.

The two tracks use separate rubrics and separate Benchmark Suites even if they share rendering and visual-design dimensions.

## 3. Evaluation Case manifest

A prompt string alone is not an Evaluation Case. Every versioned Case records:

- `case_id`, `case_version`, `track`, language, and scenario;
- normalized input text hash or source-document binary hash;
- audience, use occasion, presentation objective, expected speaking duration, and target page range;
- required facts, reference evidence, and allowed external knowledge;
- hard constraints and soft preferences;
- information-density, style, brand, editability, and delivery requirements;
- expected fact-check strategy;
- sensitivity classification and retention policy;
- author, review state, and change log.

Query cases should include a small reference fact pack when factual correctness is judgeable. When no defensible reference is available, the corresponding factual criterion is `NOT_ASSESSABLE`; the system must not claim “no fabrication.”

## 4. Product Package and fairness protocol

A **Product Package** is a versioned record of the experience actually tested:

- vendor, product, visible product/version evidence, model/tier, and paid plan;
- networking/search mode, page setting, template/style, image policy, language, and region;
- browser, viewport, account type, and key UI configuration evidence;
- `vendor_adapter_version` and capture timestamp;
- expected configuration and observed effective configuration.

Two benchmark protocols are supported and are never merged into one ranking:

1. **Default Experience / Comparable User Cost** — the experience a comparable user receives at the declared budget and intervention level.
2. **Best Available Capability** — the best reproducible package available to the test account, with paid access and manual choices disclosed.

Every protocol declares:

- controlled dimensions;
- intentional treatment dimensions;
- incidental environment variables;
- comparability breakers;
- allowed manual actions;
- retry, timeout, and successful-output selection policy.

Capacity, payment, authentication, CAPTCHA, and quota outcomes are retained as reachability evidence. They are not silently retried until a favorable output appears.

## 5. Execution and provenance model

```text
Benchmark Suite
  └─ Evaluation Case
      └─ Run
          └─ Attempt
              └─ Artifact
                  ├─ Original blob or frozen cloud snapshot
                  ├─ Render manifest and slide renders
                  ├─ Extracted text
                  └─ Contact sheet
                      └─ Evaluation[]
```

### Run and Attempt

- A **Run** is one logical Case × Product Package task.
- An **Attempt** is one real interaction with the vendor product.
- Every Attempt has its own status, timestamps, observable trace, manual actions, cost evidence, error classification, and resulting Artifact.
- Browser execution is treated as at-least-once. A stable idempotency key, vendor task ID when observable, submit evidence, and downloaded Artifact hash are used to detect duplicate submission.
- The default result-selection rule is the first policy-compliant successful Attempt. Cherry-picking the best output is forbidden. Repeat-sampling protocols retain and analyze all Attempts.

Attempt state machine:

```text
queued -> preflight -> submitting -> generating -> export_pending
       -> succeeded | blocked | timed_out | failed | canceled
```

The runner is asynchronous. Each vendor/account has a concurrency limit and profile lock. Login preflight, submission, generation, and export have separate timeouts. Capacity, payment, quota, CAPTCHA, and invalid authentication are non-retriable unless the underlying condition is explicitly changed. One vendor failure does not block other vendors; a bake-off may end `completed_with_partial_results`.

### Observable Trace

Trace means observable UI, network-task metadata, screenshots, timestamps, downloads, and declared human actions. It does not claim access to hidden model reasoning or chain-of-thought.

Structured events carry at least:

`case_id`, `run_id`, `attempt_id`, `job_id`, `artifact_id`, `vendor_adapter_version`, event type, timestamp, and evidence reference.

### Artifact immutability

An Artifact is not complete until it has a stable identity and a captured representation:

- `artifact_id`, SHA-256, MIME type, byte size, page count, and capture time;
- original binary or a frozen, exportable cloud snapshot;
- source URL only as provenance, never as the sole Artifact;
- a hash for every render, contact sheet, and extracted-text derivative;
- renderer, extractor, font-pack, resolution, color-profile, animation, and external-asset policies.

Artifacts and Evaluations are append-only. Re-exporting or re-evaluating creates a new entity; it never overwrites history.

## 6. Canonical evaluation input

Every Evaluation points to an `evaluation_input_manifest` containing:

- Artifact hash;
- render-pipeline, renderer, extractor, and font-pack versions;
- viewport, resolution, color profile, crop policy, and load-complete rule;
- animation/video frame policy and external-asset policy;
- slide-render hashes, contact-sheet hash, and extracted-text hash;
- anonymization policy and any remaining vendor-identity leakage.

The original Artifact and canonical render are both preserved. Rendering or extraction failure is diagnosed separately from an Artifact design defect. Untrusted downloads are type/size checked and rendered in a sandbox with network disabled by default.

## 7. Quality gates

Quality gates describe delivery state; they do not masquerade as aesthetic scores.

Each gate stores:

- `status`: `PASS | CONDITIONAL | FAIL | NOT_ASSESSABLE`;
- `severity`: `blocking | major | warning`;
- `effect`: `exclude_from_quality | score_with_cap | score_normally_with_flag`;
- page/evidence references and ownership classification.

Required gates include:

- Artifact can be opened and completely browsed;
- required delivery format is present;
- sufficient canonical visual input exists for scoring;
- no blocking overlap, clipping, missing font, or unreadable rendering;
- page-count and material instruction compliance;
- source corruption or serious factual error, when assessable.

An unopenable or unrenderable Artifact remains a delivery result but is `not_scorable`; it is not assigned a zero aesthetic score. Reports show delivery success rate and quality conditional on scorable delivery together, preventing survivor bias.

## 8. Experimental Artifact Scorecard

### 8.1 No universal total in the uncalibrated MVP

Version 0.2 reports three separate score families:

1. **Task Success**
2. **Presentation Design**
3. **Delivery Quality**

No universal `70 visual + 30 task` total is authoritative. A scenario-specific composite may be shown only when its versioned weight profile is explicitly labeled **experimental**. Different profile versions are not ranked together. Final weights require human preference and task-success calibration; a reviewer-proposed 50/50 split is also only a hypothesis.

Raw judgments use a 1–5 ordinal scale. The UI may map a family average to 0–100 for readability using `(raw - 1) / 4 × 100`, but raw ordinal values remain authoritative.

### 8.2 Task Success — Query Generation

| Dimension | 1 anchor | 3 anchor | 5 anchor |
|---|---|---|---|
| Intent and constraint compliance | Misses the requested task or critical constraint | Meets the main request with minor omissions | Satisfies the explicit task and constraints without material deviation |
| Correctness and substance | Contains material falsehoods or empty filler | Mostly defensible, useful content with limited depth | Accurate, specific, decision-useful content supported by the Case evidence |
| Coverage and selection | Omits core topics or spends space on irrelevant material | Covers core topics with uneven prioritization | Covers and prioritizes the information needed for the stated objective |
| Narrative organization | Pages feel unordered or repetitive | Understandable beginning, development, and close | Deliberate argument/story progression with effective transitions |
| Audience and occasion fit | Tone, depth, or call to action conflicts with the audience | Broadly usable for the audience | Content, density, terminology, and conclusion are purpose-built for the audience |

### 8.3 Task Success — Document Generation

| Dimension | 1 anchor | 3 anchor | 5 anchor |
|---|---|---|---|
| Source fidelity | Materially alters or fabricates source meaning | Mostly faithful with minor distortions | Preserves claims, numbers, attribution, and uncertainty |
| Key-information completeness | Omits information required to understand the source | Retains most essential information | Retains all decision-critical information without source corruption |
| Selection and compression | Copies indiscriminately or removes essential context | Reasonable compression with local imbalance | Selects and compresses according to audience, objective, and page budget |
| Presentation narrative transformation | Document order is pasted into slides without presentation logic | Basic slide narrative is present | Source is transformed into a clear spoken-presentation arc |
| Audience and occasion fit | Transformation is unusable for the stated audience | Broadly usable | Density, explanation, and emphasis are purpose-built for the occasion |

### 8.4 Presentation Design — shared dimensions

| Dimension | 1 anchor | 3 anchor | 5 anchor |
|---|---|---|---|
| Visual aesthetics and finish | Distracting, visibly unfinished, or stylistically incoherent | Competent and mostly polished | Deliberate, refined visual language that supports the presentation purpose |
| Layout, hierarchy, and readability | Reading order is unclear or material text is hard to read | Clear hierarchy with isolated density or alignment issues | Effortless reading order, spacing, scale, and emphasis across the deck |
| Visual-expression choice and execution | Visuals are misleading, decorative noise, or absent when necessary | Choices are generally appropriate with uneven execution | Each chart/image/diagram—or deliberate text-only choice—adds truthful information value |
| Deck consistency and professional delivery | Components, spacing, or styles vary without purpose | Mostly consistent with a few breaks | Cohesive system with purposeful variation and production-ready detail |

The visual-expression dimension rewards appropriateness, not the number of charts or images. A deck that correctly needs no chart can receive a 5. Misleading charts are evaluated for truthfulness as well as craft.

### 8.5 Delivery Quality

Delivery Quality is reported separately and combines gate status with measurable capabilities:

- export availability and loss;
- text, image, shape, chart/data, theme/master, and animation editability;
- whole-slide bitmap proportion;
- actual page count and instruction compliance;
- openability and cross-render integrity.

It is never inferred from a screenshot alone.

### 8.6 Scoring rules

- Every dimension requires page or source evidence; unsupported scores are invalid.
- Judges assess one construct per dimension and must not double-penalize the same defect across dimensions.
- `NOT_APPLICABLE` is allowed only where the rubric declares it; family normalization excludes it and records the denominator.
- Page roles/semantic sections are aligned before comparison; same page number does not imply the same narrative role.
- A score is a deck-level ordinal judgment supported by representative and worst-material page evidence, not a false-precision average of arbitrary page scores.
- The full raw Judge response, evidence, rubric version, model, prompt, preprocessing input, and timestamp are preserved.

## 9. Judge reliability and calibration

### Independent assessment

For a scored Artifact:

1. vendor identity is hidden where feasible and residual identity leakage is recorded;
2. slide order is preserved, while Artifact evaluation order is randomized;
3. two independent Judge passes score the same canonical input;
4. a two-point or larger disagreement on any 1–5 dimension, invalid evidence, or contradictory gate result triggers a third adjudication pass or human review;
5. the stored result includes all raw passes and the aggregation decision.

Model self-reported confidence is explanatory metadata, not a reliability measure.

Before stable comparisons, a fixed Human Anchor Set must establish:

- rubric interpretation examples and counterexamples;
- Judge repeatability;
- human–human agreement;
- model–human agreement;
- drift when the Judge, rubric, renderer, or prompt changes.

The initial acceptance target is that at least 80% of repeated dimension judgments are within one ordinal point and that automated agreement is not materially below the measured human–human baseline. These are pilot targets to validate, not permanent universal constants.

### Pairwise Judgment

Pairwise is supplementary and is scoped to one declared subjective construct:

- A/B identity is hidden where feasible;
- left/right placement is randomized and then swapped at least once;
- presentation order, random seed, input hashes, and masking policy are stored;
- inconsistent swapped outcomes are `inconclusive` or sent to human arbitration;
- a Pairwise result never mutates the independent Artifact Scorecard;
- disagreement between absolute and Pairwise evidence is reported as measurement disagreement, not silently reconciled;
- on-demand pairs explain local differences; they do not produce a global ranking.

A global preference ranking would require a preregistered comparison graph and a model such as Bradley–Terry or Thurstone, plus human calibration. Automatically comparing only against the highest independent score is avoided; the internal view may use a user-selected candidate, adjacent confidence set, or randomized audit opponent.

## 10. Compatibility and aggregation

Direct comparison requires equality of:

- Evaluation Case manifest hash and input/source hash;
- track and normalized core-constraint hash;
- benchmark protocol and run-protocol version;
- scorecard and scenario-weight-profile version;
- Judge policy, model family, and prompt version;
- render/extraction/evaluation-input pipeline version.

Product Package differences are displayed as treatments. A declared comparability breaker moves the result into a separate group rather than a footnote.

Aggregation order is:

```text
Judge passes -> Artifact
Artifacts/Attempts -> Case × Product Package
Cases -> scenario stratum
Scenario strata -> declared Suite profile
```

Reports include sample count, delivery/failure rate, distribution, uncertainty, and missingness. Suite-level comparisons use stratification and confidence intervals; scenario weights are declared for the target user rather than silently averaged. Rubric or Judge changes create a new series. An Anchor Artifact set may be dual-evaluated to build an explicit bridge, but old and new versions are never assumed equivalent.

## 11. Comparison View and WPS Gap Cards

A Comparison View dynamically selects compatible Artifacts; it has no fixed baseline. The WPS internal default may conveniently open:

- current WPS package vs previous WPS package;
- current WPS package vs user-selected competitors.

This is a view default, not a data-model baseline.

The report presents:

- family and dimension profiles, not only a total;
- delivery/failure outcomes beside conditional quality;
- semantically aligned section/page evidence;
- uncertainty and claim level;
- configuration differences and comparability warnings;
- **Gap Cards** for actionable findings.

Each Gap Card contains:

- affected dimension, severity, Cases, and pages;
- competitor and WPS evidence;
- a clearly labeled cause hypothesis: outline/content, layout selection, layout execution, imagery, charting, rendering, or export;
- observed scope: page, deck, scenario, or repeatable pattern;
- proposed experiment and acceptance metric;
- confidence/evidence strength and human-review requirement.

Observed output cannot prove an internal pipeline cause. Gap Card attribution remains a hypothesis until an experiment validates it.

## 12. Operational metrics and long-term utility

Operational metrics do not alter Artifact Quality. They are displayed separately:

- `queued_at`, `submitted_at`, `first_preview_at`, `generation_ready_at`, `export_ready_at`, and `artifact_captured_at`;
- queue, vendor generation, export, and human-wait durations;
- currency, pricing unit, quota before/after, and `observed | inferred | unknown` cost evidence;
- manual action and Attempt counts;
- editability capability vector;
- export format and loss;
- payment, capacity, authentication, quota, CAPTCHA, and automation blockers.

Long-term Selection Utility may combine Artifact Quality, Human Preference, and Operational Metrics only through an explicit user/scenario utility profile. It is a different output from Artifact Quality.

## 13. SSOT and storage authority

### Current MVP

| Data | Authority |
|---|---|
| PRD, ADR, schema, rubric, adapter spec, and task status | Private GitHub repository |
| Run, Attempt, event, Artifact metadata, and evaluation records | Feishu Base, under append-only system-field rules |
| Original PPT/cloud snapshot and derivatives | Feishu attachment/drive storage with hashes recorded in Base |
| Local files and browser downloads | Disposable working cache, never authority |

In Feishu, automated identity, hash, timing, and score fields are not manually overwritten. Human-editable fields are limited to review status, annotation, and adjudication. Every record carries stable external IDs, version fields, `created_at`, and `last_synced_at`.

### Scale target

Before unattended or high-volume operation, Run/Attempt/events/scores move to a transactional runtime database and Artifacts move to immutable object storage. Feishu becomes a human-facing projection. The migration preserves IDs and hashes and defines one-way synchronization and conflict handling.

## 14. Security, privacy, and retention

- Credentials are read on demand from the approved secret source and never enter GitHub, Feishu, prompts, screenshots, HAR, or logs.
- Vendor browser profiles are isolated and locked per account.
- Cookies, authorization headers, personal data, and sensitive source content are redacted from retained Trace.
- Source documents, screenshots, and Trace receive access controls and explicit retention periods.
- Downloaded files are checked for declared type, size, archives, macros, and external links before sandboxed rendering.
- Private GitHub status does not make it acceptable to store secrets.
- Vendor terms-of-service, automation, account, and suspension risk are recorded.

## 15. Observability and service objectives

Failure classes include authentication, CAPTCHA, payment, quota, capacity, vendor timeout, UI drift, export, download, render, extraction, and Judge failure.

Dashboards track:

- Attempt and Artifact-capture success;
- stage latency by Product Package and adapter version;
- duplicate-submission, retry, and manual-intervention rates;
- render, extraction, and scoring failure;
- cost/quota evidence;
- Judge drift and disagreement.

MVP service objectives are declared per release and measured before unattended operation. Harness failure, product delivery failure, unsupported capability, and payment blockage are always separate result classes.

## 16. Phased MVP

### M0 — capture and provenance

- Query Generation only;
- 3–5 selected products;
- assisted browser execution is allowed and disclosed;
- immutable Artifact package, Attempt lineage, and structured failure;
- Feishu operational record and GitHub specification.

Exit evidence:

- every submitted interaction has a Run/Attempt lineage and terminal state;
- every captured Artifact has a hash and provenance manifest;
- duplicate submission, manual action, and failure classifications are auditable;
- a partial bake-off report can be produced without treating missing vendors as zero quality.

### M1 — experimental evaluation and comparison

- canonical render/extraction;
- versioned rubric anchors;
- repeated Judge policy and Human Anchor Set;
- dimension-profile Comparison View and Gap Cards;
- optional local Pairwise explanation.

Exit evidence:

- scoring repeatability reaches the declared pilot threshold;
- every score has page/source evidence and a reproducible input manifest;
- WPS reviewers confirm that Gap Cards yield testable product hypotheses.

### M2 — Document Generation

- separate source-aware Case schema and rubric;
- source fidelity/completeness evidence;
- privacy and document-retention controls;
- separate Document Benchmark Suite.

### M3 — user preference and selection utility

- segmented blind human studies;
- scenario-specific utility profiles;
- calibrated recommendation rather than LLM-only preference claims.

## 17. Review disposition from version 0.1

Accepted:

- replace the uncalibrated 70/30 total with separate task, design, and delivery families;
- add content correctness, observable ordinal anchors, `NOT_ASSESSABLE`, and non-duplicative evidence rules;
- treat visual choice as appropriateness rather than rewarding chart/image count;
- formalize gates, repeat runs, Judge reliability, Pairwise swap tests, version bridges, and uncertainty;
- add Product Package fairness protocols, phased MVP, WPS Gap Cards, and long-term utility;
- add immutable provenance, Run/Attempt separation, idempotency, asynchronous partial success, canonical rendering, SSOT, security, and observability.

Accepted with modification:

- repeated stable claims require at least 3 Attempts, while a single Attempt remains allowed only as a Case sample;
- a scenario weight profile may exist, but no reviewer-proposed 50/50 or previous 70/30 split is authoritative before calibration;
- Feishu remains the temporary operational source for the current MVP because the working process already uses it; the scale architecture moves computation to a runtime database and immutable object store.

Not accepted:

- no exact replacement weight is adopted merely because a reviewer proposed it;
- no hidden internal pipeline cause is asserted from output evidence alone.
