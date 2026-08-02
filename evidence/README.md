# Recovery evidence assurance scope

The `verifierBuildIdentity`, `rawResultVerifierBuildIdentity`, and
`attestedResultVerifierBuildIdentity` fields in this directory identify the
source archive and TypeScript toolchain bytes observed on the workstation that
ran the recovery CLI.

They are **current-workstation reproducibility identities only**. The recovery
CLI starts through `node --import tsx`, and the embedded manifest check runs
after Node and the TypeScript loader have already started. These fields can
detect accidental source or loader drift in that environment, but they are not
an independent bootstrap, a signed execution attestation, or tamper-proof proof
of which verifier code executed.

Stronger execution provenance requires a separately trusted signed bootstrap or
a native frozen executable verified before verifier code runs. Nothing in the
checked-in replay evidence substitutes for that gate, and replay evidence never
satisfies the T10 `LIVE_PRODUCTION` acceptance gate.
