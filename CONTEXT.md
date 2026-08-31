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

**Question Bank Case**:
A Query Generation Evaluation Case that freezes requester persona, presentation audience, intended use, target page count, Query, vendor-prompt template, and evaluator-only context. Vendor intent confirmation produces a new Case version instead of mutating the frozen Case.
_Avoid_: Query string, mutable vendor confirmation state

**Requester Persona**:
The simulated person asking a product to create the PPT, including role and relevant background. It is distinct from the people who will consume the presentation.
_Avoid_: Audience, viewer

**Presentation Audience**:
The intended readers or viewers of the generated PPT, including their prior knowledge and reading mode. It is distinct from the Requester Persona.
_Avoid_: Requester, prompt author

**Evaluation Target**:
A scoreable node in the static presentation hierarchy: one Deck, one of its Slides, or an Image/Text Box Element on a Slide. Evidence is not an Evaluation Target.
_Avoid_: Evidence, rubric dimension

**Deck**:
The complete logical PPT Artifact evaluated as a whole; it is not a source document. Audience fit, task fit, coverage, narrative, and cross-slide consistency are Deck-level concerns.
_Avoid_: Document, slide, file URL

**Slide**:
One static rendered page of a Deck. Page layout, hierarchy, readability, and local expression are commonly assessed at this scope.
_Avoid_: Deck, screenshot collection

**Element**:
An individually addressable Image or Text Box on a Slide that can receive its own assessment. Image clarity/cropping/fit and text sizing/crowding/overflow are Element-level concerns.
_Avoid_: Evidence, arbitrary pixel region

**Evidence**:
Versioned supporting material cited by a judgment, such as a page observation, element crop, extracted text, gate result, or reference fact. Evidence supports a label but is never itself scored.
_Avoid_: Evaluation Target, score

**Evaluation Label**:
The atomic judgment `GOOD`, `BAD`, or `UNCERTAIN`, displayed in Chinese as “好”, “不好”, or “不确定”. `UNCERTAIN` records why a responsible decision cannot yet be made.
_Avoid_: 1–5 score, probability, delivery gate

**Judgment Confidence**:
The Judge's stated certainty about one judgment under the available Rubric and Evidence. It is not measured Judge accuracy; accuracy requires calibration against independently established reference labels.
_Avoid_: Accuracy, factual correctness, probability of vendor quality

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
A relative preference judgment between two compatible Artifacts, used as supplementary evidence for subjective visual dimensions. The current MVP is non-blind. Blinding may only be enabled later by an explicit, versioned Batch protocol.
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

**Score Adjudication**:
An append-only human decision that preserves the model-original dimension score and records the human-final score, actor, time, reason, evidence, and prior adjudication reference. Effective score views use the latest valid human adjudication and otherwise fall back to the model original.
An adjudication cannot change `NOT_ASSESSABLE` into an assessed score; newly available reviewed reference evidence requires a new Scorecard whose input manifest and compatibility fingerprint freeze that Reference Pack.
_Avoid_: Overwritten model score, mutable review flag

**Gap Card Delivery Workflow**:
The PM-controlled transition of a Gap Card from `pending_review` to either `confirmed_for_delivery` or `rejected`. Only `confirmed_for_delivery` cards may reserve delivery and create or recover one idempotently linked GitHub Issue; the reservation, workflow decision, and link remain append-only audit records.
_Avoid_: Draft means approved, automatic issue creation

**Selection Utility**:
A long-term, user/scenario-specific recommendation signal that combines Artifact Quality, Human Preference, and Operational Metrics through an explicit utility profile.
_Avoid_: LLM aesthetic score, universal leaderboard

**Claim Level**:
The strength of statement permitted by the evidence, ranging from a single Case sample through a calibrated user recommendation. More Attempts inside one Run do not raise it; three independent Runs create a replicated pilot, while a Stable claim also requires a preregistered precision or stability rule to pass.
_Avoid_: Confidence adjective, marketing label
