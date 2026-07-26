# PPT Evaluation

This project evaluates AI-generated presentation products and turns observed results into decision support.

## Language

**WPS Competitive Benchmark**:
The short-term, internal evaluation of WPS AI PPT against competing products, used by the WPS AI PPT team to identify quality gaps and product opportunities.
_Avoid_: Industry ranking, neutral benchmark

**PPT Selection Evaluation**:
The long-term, user-facing evaluation that helps a user choose a PPT product for a particular presentation task.
_Avoid_: Vendor harness, WPS regression test

**Evaluation Run**:
One execution of a fixed presentation request against one product configuration, including its trace, timing, configuration, and resulting artifact.
_Avoid_: Vendor result, model score

**Artifact**:
The presentation output delivered by an Evaluation Run, such as a PPTX file, editable cloud deck, HTML presentation, or image-based deck.
_Avoid_: Screenshot, completion signal
