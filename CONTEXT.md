# PPT Evaluation

This project evaluates AI-generated presentation products and turns observed results into decision support.

## Language

**WPS Competitive Benchmark**:
The short-term, internal evaluation of WPS AI PPT against competing products, used by the WPS AI PPT team to identify quality gaps and product opportunities.
_Avoid_: Industry ranking, neutral benchmark

**PPT Selection Evaluation**:
The long-term, user-facing evaluation that helps a user choose a PPT product for a particular presentation task.
_Avoid_: Vendor harness, WPS regression test

**Live Bake-off**:
The short-term workflow that sends the same evaluation input to multiple selected products at run time, captures each result, and compares WPS AI PPT with those competitors.
_Avoid_: Cached benchmark, historical ranking

**Benchmark Corpus**:
The accumulated set of versioned evaluation cases, configurations, traces, artifacts, scores, and human preferences used by the long-term PPT Selection Evaluation.
_Avoid_: Live Bake-off, static leaderboard

**Evaluation Run**:
One execution of a fixed presentation request against one product configuration, including its trace, timing, configuration, and resulting artifact.
_Avoid_: Vendor result, model score

**Artifact**:
The presentation output delivered by an Evaluation Run, such as a PPTX file, editable cloud deck, HTML presentation, or image-based deck.
_Avoid_: Screenshot, completion signal
