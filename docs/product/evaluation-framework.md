# AI PPT Evaluation Framework

Status: Proposed — experimental, not yet calibrated  
Version: 0.5  
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
| Stable case comparison | At least 3 independent, policy-compliant Runs per Case × Package, including failures | Case-level distribution, success rate, and uncertainty |
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

A prompt string alone is not an Evaluation Case. Each Case separates:

- `vendor_input_contract`: every instruction and input actually submitted to the product;
- `evaluator_reference`: fact-check material, research labels, expected patterns, and analysis metadata not submitted to the product.

Only the vendor input contract may create a compliance requirement. An evaluator-only audience, style, or coverage label may be used for slicing and research, but not for deducting quality. If the test intentionally measures whether a product infers an unstated requirement, that inference target is declared as the treatment variable rather than treated as a hidden instruction.

Every versioned Case records:

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

Stable and Suite comparisons additionally use time blocks. For the same Case, Product Package Runs are scheduled inside the same declared time window and vendor order is randomized within each block. The estimator uses within-block paired contrasts. Runs that cannot be placed in a valid block remain exploratory because time, product rollout, or load may confound the vendor effect.

Capacity, payment, authentication, CAPTCHA, and quota outcomes are retained as reachability evidence. They are not silently retried until a favorable output appears.

## 5. Execution and provenance model

```text
Benchmark Suite
  └─ Evaluation Case
      └─ Bakeoff Job
          └─ Run
              └─ Attempt
                  └─ Artifact [0..n]
                      ├─ Original blob or frozen cloud snapshot
                      ├─ Render manifest and slide renders
                      ├─ Extracted text
                      └─ Contact sheet
                          └─ Evaluation[]
```

### Bakeoff Job, Run, and Attempt

- A **Bakeoff Job** is one user-triggered multi-product batch. It freezes the selected Run set, shared protocol snapshot, deadline, and cancellation policy, and ends `completed | partial | failed | canceled`.
- The Bakeoff Job records each selected Run as `not_scheduled | active | terminal`; `partial` cannot conceal a product that was never scheduled.

- A **Run** is one logical Case × Product Package task.
- An **Attempt** is one real interaction with the vendor product.
- Every Attempt has its own status, timestamps, observable trace, manual actions, cost evidence, error classification, and zero or more resulting Artifacts.
- Browser execution is treated as at-least-once. A stable idempotency key, vendor task ID when observable, submit evidence, and downloaded Artifact hash are used to detect duplicate submission.
- The default result-selection rule is the first policy-compliant captured Artifact within a Run. Cherry-picking the best output is forbidden. Repeat-sampling protocols use independent Runs and retain all failures; retry Attempts are nested recovery events and do not increase statistical sample size.

Attempt state machine:

```text
queued -> preflight -> submitting -> generating -> export_pending
       -> waiting_for_human
       -> submission_unknown -> reconciling
       -> terminal
```

`submission_unknown` is never auto-resubmitted. Recovery first reconciles vendor history, visible task ID, page evidence, and captured hashes; unresolved ambiguity requires a human decision. `waiting_for_human` pauses vendor-generation timing.

Attempt terminal state is derived from orthogonal outcomes rather than one overloaded success flag:

- `vendor_outcome`: generated, blocked, timed_out, failed, canceled, unknown;
- `capture_outcome`: captured, no_artifact, partial, failed, unknown;
- `render_outcome`: renderable, degraded, failed, not_attempted.

“Vendor generated successfully,” “Artifact was captured,” and “Artifact is scorable” are separate facts. One Attempt may yield zero, one, or multiple Artifacts; duplicates and alternate exports remain linked and are never silently discarded.

The runner is asynchronous. Each vendor/account has a concurrency limit and profile lock. Login preflight, submission, generation, and export have separate timeouts. Capacity, payment, quota, CAPTCHA, and invalid authentication are non-retriable unless the underlying condition is explicitly changed. One vendor failure does not block other vendors; a Bakeoff Job may end `partial`.

### Observable Trace

Trace means observable UI, network-task metadata, screenshots, timestamps, downloads, and declared human actions. It does not claim access to hidden model reasoning or chain-of-thought.

Structured events carry at least:

`event_id`, `job_id`, `case_id`, `run_id`, `attempt_id`, `artifact_id`, `attempt_seq`, `state_version`, `vendor_adapter_version`, event type, `source_at`, `observed_at`, `writer_id`, and evidence reference.

Current state is derived from idempotently upserted events. Duplicate IDs are ignored, and stale or illegal state transitions are rejected. A state update without its causal event is invalid.

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

Before Presentation Design scoring, a render-fidelity check compares the canonical render with the frozen native completion view. If material layout, font, asset, crop, animation-frame, or color differences are introduced by capture/export/rendering, the system either:

- uses a verified native frozen view for design judgment and records the canonical incompatibility; or
- marks Presentation Design non-comparable.

Renderer-introduced loss is recorded as Delivery/export evidence and is not double-penalized as design quality.

## 7. Quality gates

Quality gates describe delivery state; they do not masquerade as aesthetic scores.

Each gate stores:

- `status`: `PASS | CONDITIONAL | FAIL | NOT_ASSESSABLE`;
- `severity`: `blocking | major | warning`;
- `effect`: `exclude_from_quality | score_normally_with_flag | route_to_dimension`;
- page/evidence references and ownership classification.

Version 0.3 fixes the gate decision table:

| Gate | FAIL effect | Score ownership |
|---|---|---|
| Artifact captured and openable | `exclude_from_quality` | Delivery outcome only |
| Sufficient faithful visual input | `exclude_from_quality` | Harness/render diagnosis; not product design |
| Required delivery/export format | `score_normally_with_flag` | Delivery Quality only |
| Deck globally unreadable or materially incomplete | `exclude_from_quality` | Delivery outcome; page-local defects stay in the relevant design dimension |
| Page count and explicit instruction compliance | `route_to_dimension` | Task Success only |
| Factual correctness or source fidelity | `route_to_dimension` | Task Success only |

`CONDITIONAL` and `NOT_ASSESSABLE` follow the table's declared score ownership and remain visible. A defect is owned by one score dimension or one gate outcome; it is never deducted twice. Only a catastrophic defect that prevents reliable judgment excludes quality.

An unopenable or unrenderable Artifact remains a delivery result but is `not_scorable`; it is not assigned a zero aesthetic score. Reports show delivery success rate and quality conditional on scorable delivery together, preventing survivor bias.

## 8. Experimental Artifact Scorecard

### 8.1 No universal total in the uncalibrated MVP

Version 0.2 reports three separate score families:

1. **Task Success**
2. **Presentation Design**
3. **Delivery Quality**

No universal `70 visual + 30 task` total is authoritative. A scenario-specific composite may be shown only when its versioned weight profile is explicitly labeled **experimental**. Different profile versions are not ranked together. Final weights require human preference and task-success calibration; a reviewer-proposed 50/50 split is also only a hypothesis.

Raw judgments use a 1–5 ordinal scale. Dimension distributions are the primary result. A UI may map an individual dimension to 0–100 for readability using `(raw - 1) / 4 × 100`, but raw ordinal values remain authoritative.

Any family index—including equal weighting—requires a named, versioned, explicitly experimental weight profile. The system does not compute an undeclared family average.

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
- openability and cross-render integrity.

Actual page count remains an Operational Metric. A deviation from an explicit page or instruction requirement is scored only under Task Success, according to the gate ownership table. It is never inferred from a screenshot alone or scored again under Delivery Quality.

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
3. two context-isolated Judge passes use the frozen model revision, parameters, prompt, input hashes, and declared randomization policy;
4. if a single Artifact value is required and the two ordinal values differ at all, a third independent pass is run and the median is used; invalid evidence or contradictory gate results trigger human review;
5. exploratory runs may display the two raw values without resolving them, but cannot present a single stable value;
6. the stored result includes all raw passes and the deterministic aggregation decision.

Model self-reported confidence is explanatory metadata, not a reliability measure.

Before stable comparisons, a fixed Human Anchor Set must establish:

- rubric interpretation examples and counterexamples;
- Judge repeatability;
- human–human agreement;
- model–human agreement;
- drift when the Judge, rubric, renderer, or prompt changes.

Judge calibration uses a versioned protocol with:

- a development set and untouched holdout set spanning vendors, scenarios, and the intended quality range;
- preregistered ordinal agreement, systematic-bias, and high/low-quality discrimination metrics;
- thresholds and uncertainty bounds declared before holdout evaluation;
- separate repeatability and validity decisions.

The initial repeatability target is that at least 80% of repeated dimension judgments are within one ordinal point. This target alone is insufficient: the Judge may support Stable or Suite claims only when the holdout protocol also shows that agreement is not materially below the human–human baseline, systematic bias remains inside its preregistered bound, and the Judge discriminates the anchor quality levels. Failed holdout calibration restricts outputs to exploratory raw judgments.

### Pairwise Judgment

Pairwise is supplementary and is scoped to one declared subjective construct:

- A/B identity is hidden where feasible;
- left/right placement is randomized and then swapped at least once;
- presentation order, random seed, input hashes, and masking policy are stored;
- inconsistent swapped outcomes are `inconclusive` or sent to human arbitration;
- each pass must return `A | B | tie | not_assessable`; no observable material difference means `tie`, and insufficient faithful evidence means `not_assessable`;
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
- exact Judge model revision, parameters, policy, and prompt version;
- render/extraction/evaluation-input pipeline version.

Product Package differences are displayed as treatments. A declared comparability breaker moves the result into a separate group rather than a footnote.

Aggregation order is:

```text
Judge passes -> Artifact
retry Attempts -> one Run outcome
independent Runs -> Case × Product Package
Cases -> scenario stratum
Scenario strata -> declared Suite profile
```

Every Suite preregisters a versioned estimator profile:

- primary dimensions/endpoints and primary Product Package contrasts;
- secondary exploratory dimensions, slices, and Gap Card searches;
- a multiplicity policy for the declared family of primary comparisons;
- the paired Case-level estimand for each dimension;
- how independent Runs become one Case distribution;
- Case—not retry Attempt—as the sampling/cluster unit for Suite uncertainty;
- treatment of vendor failure, missing Artifact, `NOT_APPLICABLE`, and `NOT_ASSESSABLE`;
- ordinal-appropriate interval or resampling method rather than an automatic normal-theory CI;
- scenario weights and practical tie band.

Reports include sample count, delivery/failure rate, ordinal distribution, uncertainty, and missingness. Dimension results remain primary; an index requires its explicit weight profile. Rubric or Judge changes create a new series. An Anchor Artifact set may be dual-evaluated to build an explicit bridge, but old and new versions are never assumed equivalent.

Unregistered, uncorrected, or post-hoc findings are labeled exploratory. They cannot support a stable ranking or a claim that a gap is repeatable until confirmed in a new preregistered evaluation.

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

Accepted Gap Cards enter a WPS-private Gap Backlog with impact, recurrence, evidence strength, user value, controllability, priority, owner, target version, experiment link, result, and state. Vendor-neutral Artifact findings remain separable from private WPS diagnosis. M1 is not complete until at least one item closes the loop `finding -> diagnosis -> experiment -> result`.

## 12. Operational metrics and long-term utility

Operational metrics do not alter Artifact Quality. They are displayed separately:

- `queued_at`, `submitted_at`, `first_preview_at`, `generation_ready_at`, `export_ready_at`, and `artifact_captured_at`;
- queue, vendor generation, export, and human-wait durations;
- currency, pricing unit, quota before/after, and `observed | inferred | unknown` cost evidence;
- manual action and Attempt counts;
- editability capability vector;
- export format and loss;
- payment, capacity, authentication, quota, CAPTCHA, and automation blockers.

Long-term human evidence has two distinct forms:

- blind output preference;
- hands-on workflow usability covering requirement entry, iteration, local editing, collaboration, export, and failure recovery.

Selection Utility must disclose which evidence forms are available. Without hands-on task evidence, it may produce only an “output selection suggestion,” not a complete product recommendation.

Recommendation is a three-step decision:

1. apply eligibility hard filters such as region, platform, budget, privacy, required format, and current availability;
2. validate package/version age, evidence freshness, sample coverage, and missingness;
3. calculate the declared utility profile only across eligible candidates and return trade-offs/tie sets.

No eligible candidate, stale evidence, or insufficient coverage returns `NO_RECOMMENDATION`.

## 13. SSOT and storage authority

### Current MVP

| Data | Authority |
|---|---|
| PRD, ADR, schema, rubric, adapter spec, and task status | Private GitHub repository |
| Run, Attempt, event, Artifact metadata, and evaluation records | Feishu Base, under append-only system-field rules |
| Original PPT/cloud snapshot and derivatives | A primary Feishu attachment/drive copy plus a second controlled, recoverable copy, both hash-verified |
| Local files and browser downloads | Disposable working cache, never authority |

In Feishu, automated identity, hash, timing, and score fields are not manually overwritten. Human review, annotation, and adjudication are appended as immutable `ReviewEvent` / `AdjudicationEvent` records containing actor, timestamp, reason, prior reference, and decision. A convenient current-review status is a derived projection, never the only history. Every record carries stable external IDs, version fields, `created_at`, and `last_synced_at`.

Upload is followed by read-back hash verification, and an existing blob is never replaced in place. Until retention-locked object storage exists, M0 keeps a second controlled recoverable copy outside the individual Base attachment entry. A hash without a recoverable blob is not an immutable Artifact.

### Scale target

Before unattended or high-volume operation, Run/Attempt/events/scores move to a transactional runtime database and Artifacts move to immutable object storage. Feishu becomes a human-facing projection. The migration preserves IDs and hashes and defines one-way synchronization and conflict handling.

## 14. Security, privacy, and retention

- Credentials are read on demand from the approved secret source and never enter GitHub, Feishu, prompts, screenshots, Trace, or logs.
- Vendor browser profiles are isolated and locked per account.
- Full HAR and request bodies are not captured by default. Network Trace is allow-listed metadata only.
- Screenshots and Trace are redacted before persistence/upload; redaction failure sends evidence to an isolated quarantine, never the normal store.
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

### M0 — Query-track capture and provenance

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
- for one declared supported Case, at least 3 supported Product Packages yield captured, openable Artifacts;
- at least one Package completes a second independent Run without one-off rescue.
- a recovery drill deletes/ignores the disposable local cache and makes the primary copy unavailable, then reconstructs the complete Artifact package from stable IDs, manifests, and the second copy with all original and derivative hashes verified.

Blocked or paid-only products remain valuable reachability evidence but do not count toward the three captured Artifacts.

### M1 — Query-track experimental evaluation and comparison

- canonical render/extraction;
- versioned rubric anchors;
- repeated Judge policy and Human Anchor Set;
- dimension-profile Comparison View and Gap Cards;
- optional local Pairwise explanation.

Exit evidence:

- scoring repeatability reaches the declared pilot threshold;
- every score has page/source evidence and a reproducible input manifest;
- WPS reviewers confirm that Gap Cards yield testable product hypotheses.
- at least one Gap Card completes `finding -> diagnosis -> experiment -> result`.

### M2 — Document Generation

- separate source-aware Case schema and rubric;
- source fidelity/completeness evidence;
- privacy and document-retention controls;
- separate Document Benchmark Suite.

M2 is part of the short-term WPS dual-track objective, not part of the long-term recommendation phase. Query and Document tracks each have independent readiness and exit status. Only after both pass their own capture and evaluation exits may the project claim a “short-term dual-track release.”

### M3 — user preference and selection utility

- segmented blind human studies;
- scenario-specific utility profiles;
- calibrated recommendation rather than LLM-only preference claims.
- hands-on workflow evidence, eligibility filters, evidence freshness, and `NO_RECOMMENDATION`.

## 17. Reproducibility pinning

Every Run freezes:

- `spec_commit_sha`;
- Case, Product Package, run-policy, adapter, and schema content hashes;
- runner code/image digest and environment evidence.

Every Evaluation additionally freezes:

- exact Judge model ID/revision and parameters;
- prompt, rubric, anonymization, estimator, and weight-profile hashes;
- render/extraction image or code digest and all evaluation-input hashes.

A Git branch or `main` reference alone is never a reproducibility identifier.

## 18. Review disposition

Accepted:

- replace the uncalibrated 70/30 total with separate task, design, and delivery families;
- add content correctness, observable ordinal anchors, `NOT_ASSESSABLE`, and non-duplicative evidence rules;
- treat visual choice as appropriateness rather than rewarding chart/image count;
- formalize gates, repeat runs, Judge reliability, Pairwise swap tests, version bridges, and uncertainty;
- add Product Package fairness protocols, phased MVP, WPS Gap Cards, and long-term utility;
- add immutable provenance, Run/Attempt separation, idempotency, asynchronous partial success, canonical rendering, SSOT, security, and observability.

Accepted with modification:

- repeated stable claims require at least 3 independent Runs, while retry Attempts remain nested recovery evidence;
- a scenario weight profile may exist, but no reviewer-proposed 50/50 or previous 70/30 split is authoritative before calibration;
- Feishu remains the temporary operational source for the current MVP because the working process already uses it; the scale architecture moves computation to a runtime database and immutable object store.

Not accepted:

- no exact replacement weight is adopted merely because a reviewer proposed it;
- no hidden internal pipeline cause is asserted from output evidence alone.

Version 0.3 additionally closes second-round ambiguities in vendor-visible instructions, independent sampling units, Judge aggregation, explicit estimator/weight profiles, fixed gate ownership, render fidelity, Pairwise ties, Bakeoff Job state, orthogonal vendor/capture/render outcomes, event replay, recoverable binary copies, reproducibility pins, workflow research, recommendation hard filters, and track-specific MVP completion.

Version 0.4 closes third-round boundaries in randomized time-block execution, holdout validity calibration, preregistered primary endpoints and multiplicity, tested Artifact recovery, and append-only human adjudication.

Version 0.5 removes duplicated page-count/instruction scoring: the observation remains operational evidence and compliance belongs only to Task Success.
