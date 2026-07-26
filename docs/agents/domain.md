# Domain Docs

This repository uses a single-context domain documentation layout.

Before planning or implementation, agents should read:

- `CONTEXT.md` for product concepts, vocabulary, boundaries, and workflows.
- Relevant ADRs under `docs/adr/` for accepted engineering and product decisions.
- The applicable GitHub Issue for current scope and acceptance criteria.

Use terms defined in `CONTEXT.md` consistently. If a new concept is needed,
record the terminology decision instead of silently introducing synonyms.

If proposed work conflicts with an existing ADR, surface the conflict explicitly.
GitHub Issues track work state; `CONTEXT.md` and ADRs record durable knowledge.
