# Doubao real adapter smoke record

Status: `NOT_RUN`

Issue: `#10`

Browser: existing user Google Chrome session only

Reason not run: waiting for the shared serial-browser permission

This record is a production smoke template, not evidence that the Doubao path
has completed.

## Fixed protocol

- Use the current signed-in account.
- Select the best reproducible package available without a new incremental
  payment.
- Enable networking/search.
- Submit the frozen `volcano-query-v1` vendor prompt requesting exactly 16
  pages.
- Cap the Run at 30 minutes.
- Retry at most once, and only after observable proof that the first Attempt was
  not submitted.
- Never retry a successful output for quality, and never automatically
  resubmit an unknown submission.
- Do not inspect or persist cookies, authorization data, passwords,
  `localStorage`, `sessionStorage`, browser profiles, or hidden reasoning.

## Observable package evidence

| Field | Result |
|---|---|
| Actual Doubao URL | `NOT_RUN` |
| Current-account signed-in evidence | `NOT_RUN` |
| Visible plan/tier | `NOT_RUN` |
| Visible model | `NOT_RUN` |
| Visible mode | `NOT_RUN` |
| Networking/search | `NOT_RUN` |
| Requested page count | `NOT_RUN` |
| Incremental payment required | `NOT_RUN` |

Account evidence must establish that the current account is signed in without
copying a personal identifier into Trace.

## Attempt and Artifact evidence

| Field | Result |
|---|---|
| Attempt started at | `NOT_RUN` |
| Submission evidence | `NOT_RUN` |
| Vendor task reference, if visibly safe | `NOT_RUN` |
| Generation-ready at | `NOT_RUN` |
| Export-ready at | `NOT_RUN` |
| Artifact captured at | `NOT_RUN` |
| Filename and MIME type | `NOT_RUN` |
| Artifact SHA-256 | `NOT_RUN` |
| Exported page count | `NOT_RUN` |
| Static render count | `NOT_RUN` |
| Static render hashes | `NOT_RUN` |
| Manual actions | `NOT_RUN` |
| Terminal reason | `NOT_RUN` |

Evidence references must point only to redacted screenshots, safe opaque UI
references, downloads, or render outputs. A mutable cloud URL by itself is not
an Artifact.

## Stop conditions

Stop without submission on authentication, CAPTCHA, payment, quota, or
configuration ambiguity. After a submitted Attempt, stop without resubmission
when submission state becomes unknown. Keep export, download, render, and
page-count failures distinct from vendor-generation success.
