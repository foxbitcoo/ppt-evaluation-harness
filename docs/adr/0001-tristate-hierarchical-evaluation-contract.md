---
status: accepted
---

# Use tri-state judgments on a separate target hierarchy

The Evaluation Module v1 public contract uses `GOOD | BAD | UNCERTAIN` instead of ordinal scores and models scoreable targets as `Deck → Slide → Element`, with Evidence stored separately. Requester persona, presentation audience, and target page count belong to the versioned Question Bank Case; this avoids false scoring precision, supports object-specific Rubrics and aggregation, and gives the frontend and Feishu projection one authoritative set of field codes and Chinese labels.

## Consequences

The existing ordinal Scorecard remains an internal legacy dependency until the integration owner migrates its Judge, adjudication, Feishu, and report consumers; it is not exported through the three new interfaces. Production inputs and results reject Mock Judge lineage, and vendor intent confirmation creates a new Question Bank Case version with the confirmed fields.
