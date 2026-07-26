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

**Benchmark Corpus**:
The accumulated set of versioned evaluation cases, configurations, traces, artifacts, scores, and human preferences used by the long-term PPT Selection Evaluation.
_Avoid_: Live Bake-off, static leaderboard

**Evaluation Run**:
One execution of a fixed presentation request against one product configuration, including its trace, timing, configuration, and resulting artifact.
_Avoid_: Vendor result, model score

**Evaluation Case**:
A versioned test input and its evaluation requirements. Each case belongs to exactly one Input Track so that only compatible runs are compared.
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
A rubric-versioned, independently produced quality assessment persisted against one Artifact. It enables dynamic Comparison Views without re-evaluating every A/B combination.
_Avoid_: Pairwise result, operational telemetry

**Pairwise Judgment**:
A blind, relative preference judgment between two compatible Artifacts, used as supplementary evidence for subjective visual dimensions.
_Avoid_: Primary score, permanent ranking

**Operational Metrics**:
Observed delivery facts such as generation time, cost, editability, page count, manual actions, and export format. They are displayed beside quality but are not part of the Artifact Scorecard.
_Avoid_: Quality score, aesthetic judgment

**Artifact**:
The presentation output delivered by an Evaluation Run, such as a PPTX file, editable cloud deck, HTML presentation, or image-based deck.
_Avoid_: Screenshot, completion signal
