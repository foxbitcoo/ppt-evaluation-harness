# Evaluation Framework Adversarial Review Log

Status: Closed  
Baseline: `evaluation-framework.md` v0.8  
Closed: 2026-07-27

## Method

Each round used three independent reviewers:

- measurement science and evaluation methodology;
- AI PPT product and user research;
- engineering, SRE, security, and data governance.

Reviewers were asked to report only material objections that could cause a wrong conclusion, false MVP acceptance, unsafe execution, or unrecoverable evidence. The primary agent adjudicated each objection rather than automatically accepting it. A new round began after every accepted revision. The stop condition was all three reviewers independently returning `NO MATERIAL OBJECTION`.

## Adjudication principles

Accepted objections had to identify:

- a concrete contradiction or missing decision;
- the erroneous outcome it could cause;
- a bounded correction inside the framework's scope.

Optional enhancements, wording preferences, and implementation details that belong in later technical design were non-blocking.

Two prominent recommendations were accepted only with modification:

- The original `70 visual + 30 task` total was removed, but the suggested replacement `50/50` split was not adopted because it was equally uncalibrated. The baseline reports separate Task Success, Presentation Design, and Delivery Quality profiles.
- Feishu remains the temporary operational authority for the current workflow, but recoverable ledger exports and blob copies are mandatory; the scale target moves runtime state to a transactional database and immutable object storage.

The review rejected:

- a universal score merely because it is easy to rank;
- treating LLM visual preference as user preference;
- claiming an internal pipeline root cause from output evidence alone;
- counting retry Attempts as independent samples;
- treating three independent Runs as sufficient proof of stability.

## Round outcomes

### Round 1 — v0.1 to v0.2

All three reviewers raised material objections.

Accepted changes:

- replaced the uncalibrated 70/30 total with separate evidence families;
- added content correctness, source fidelity, observable 1/3/5 anchors, and non-duplicative score ownership;
- separated quality gates from aesthetic quality;
- added repeatability, blind Pairwise swap tests, version bridges, and uncertainty;
- added Product Package fairness protocols, phased MVP, WPS Gap Cards, immutable Artifact provenance, Run/Attempt separation, canonical rendering, SSOT, security, and observability.

### Round 2 — v0.2 to v0.3

All three reviewers still found bounded ambiguities.

Accepted changes:

- separated vendor-visible input from evaluator-only reference;
- changed the independent sample from retry Attempt to independent Run;
- made Judge aggregation and estimator/weight profiles explicit;
- fixed gate decision ownership and render-fidelity handling;
- added Pairwise tie/not-assessable outcomes;
- defined Bakeoff Job, orthogonal vendor/capture/render outcomes, replayable events, specification pins, workflow research, recommendation hard filters, and dual-track completion.

### Round 3 — v0.3 to v0.4

Product review passed. Measurement and engineering found five material gaps.

Accepted changes:

- randomized time-block execution;
- holdout validity calibration in addition to repeatability;
- preregistered primary endpoints and multiplicity handling;
- tested Artifact recovery;
- append-only human review and adjudication events.

### Round 4 — v0.4 to v0.5

Product and engineering passed. Measurement found one duplicated score owner.

Accepted change:

- page count remains an Operational Metric, while explicit page/instruction compliance is scored only under Task Success.

### Round 5 — v0.5 to v0.6

Each reviewer found one material exit-condition gap.

Accepted changes:

- three Runs became a replicated pilot, not a Stable claim; Stable claims require a preregistered precision or stability rule;
- M0 must capture current WPS plus at least two competitors, and M1 must close a WPS-versus-competitor Gap Card;
- Feishu operational-ledger backup and restore were added.

### Round 6 — v0.6 to v0.7

Product passed. Measurement and engineering found three edge contradictions.

Accepted changes:

- `artifact_id` is nullable before Artifact creation and is bound append-only afterward;
- assessable content incompleteness routes to Task Success instead of quality exclusion;
- the human rubric baseline must itself pass reliability calibration before model calibration can support Stable/Suite claims.

### Round 7 — v0.7 to v0.8

Product passed. Measurement and engineering found four remaining comparison and safety boundaries.

Accepted changes:

- design-judgment surface became an explicit compatibility key;
- fail-closed data-egress authorization was added;
- retention tombstones and restore filtering reconciled recoverability with deletion;
- content-addressed Run specification bundles became part of recovery.

### Round 8 — closure

- Measurement: `NO MATERIAL OBJECTION`
- Product: `NO MATERIAL OBJECTION`
- Engineering: `NO MATERIAL OBJECTION`

The v0.8 framework is therefore approved as the product baseline for M0/M1 detailed design and pilot. This approval does not mean the Judge or score weights are calibrated; the framework explicitly prevents Stable claims until those gates pass.
