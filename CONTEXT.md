# PPT Evaluation

This project evaluates AI-generated presentation products and turns observed results into decision support.

## Language

**WPS Competitive Benchmark**:
The short-term, internal use of compatible Evaluation Runs by the WPS AI PPT team to identify quality gaps and product opportunities. WPS is a stakeholder and comparison candidate, not a permanently fixed baseline.
_Avoid_: Fixed WPS baseline, industry ranking

**PPT Selection Evaluation**:
The long-term, user-facing evaluation that helps a user choose a PPT product for a particular presentation task.
_Avoid_: Vendor harness, WPS regression test

**Live Bake-off**:
The short-term workflow that sends the same Evaluation Case to multiple selected products at run time and captures each result for later comparison.
_Avoid_: Fixed baseline, cached benchmark, historical ranking

**Bakeoff Job**:
One user-triggered multi-product batch that freezes the selected Runs, shared protocol, deadline, and aggregate completion state.
_Avoid_: Single vendor Attempt, leaderboard

**Benchmark Corpus**:
The accumulated set of versioned evaluation cases, configurations, traces, artifacts, scores, and human preferences used by the long-term PPT Selection Evaluation.
_Avoid_: Live Bake-off, static leaderboard

**Evaluation Run**:
A logical task for one Evaluation Case × one Product Package. It may contain one or more Attempts under a declared sampling and retry policy.
_Avoid_: Browser click sequence, vendor score

**Evaluation Attempt**:
One actual interaction with a vendor product, including observable events, timing, manual actions, failure state, cost evidence, and any resulting Artifact.
_Avoid_: Retry count, hidden model reasoning

**Product Package**:
A versioned description of the product experience actually tested, including tier, model, search, template/style, account/paid state, intervention policy, and observed effective configuration.
_Avoid_: Vendor name alone, assumed default

**Evaluation Case**:
A versioned test input and evaluation definition. It separates the vendor-visible input contract from evaluator-only reference material and belongs to exactly one Input Track.
_Avoid_: Prompt string, scoring result

**Query Generation Track**:
Evaluation Cases where the product must plan and generate a presentation from a short user request without a source document.
_Avoid_: Document summarization, source fidelity test

**Document Generation Track**:
Evaluation Cases where the product must transform a supplied source document into a presentation while preserving and prioritizing its information.
_Avoid_: Open-ended topic generation, Query Generation Track

**Comparison View**:
A report-time projection that compares any two or more compatible Evaluation Runs. It has no permanently designated baseline; A and B are selected dynamically.
_Avoid_: Stored baseline score, vendor ranking

**Artifact Scorecard**:
A rubric-versioned, independently produced profile of Task Success, Presentation Design, and Delivery Quality persisted against one Artifact. A universal total is not authoritative before scenario calibration.
_Avoid_: Pairwise result, operational telemetry, uncalibrated vendor rank

**Pairwise Judgment**:
A blind, relative preference judgment between two compatible Artifacts, used as supplementary evidence for subjective visual dimensions.
_Avoid_: Primary score, permanent ranking

**Operational Metrics**:
Observed delivery facts such as generation time, cost, editability, page count, manual actions, and export format. They are displayed beside quality but are not part of the Artifact Scorecard.
They may contribute to a separate long-term Selection Utility only through a declared user profile.
_Avoid_: Artifact quality score, aesthetic judgment

**Artifact**:
An immutable captured presentation output from an Evaluation Attempt, identified by content hash and accompanied by provenance. A mutable URL alone is not an Artifact.
_Avoid_: Screenshot, completion signal, cloud URL without snapshot

**Gap Card**:
An actionable comparison finding containing page evidence, severity, scope, a clearly labeled pipeline-cause hypothesis, a proposed experiment, and an acceptance metric.
_Avoid_: Proven root cause, generic recommendation

**Selection Utility**:
A long-term, user/scenario-specific recommendation signal that combines Artifact Quality, Human Preference, and Operational Metrics through an explicit utility profile.
_Avoid_: LLM aesthetic score, universal leaderboard

**Claim Level**:
The strength of statement permitted by the evidence, ranging from a single Case sample through a calibrated user recommendation. More Attempts inside one Run do not raise it; three independent Runs create a replicated pilot, while a Stable claim also requires a preregistered precision or stability rule to pass.
_Avoid_: Confidence adjective, marketing label
