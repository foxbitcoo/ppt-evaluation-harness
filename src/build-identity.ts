import { createHash } from "node:crypto";

const injectedSpecCommitSha =
  process.env.PPT_EVALUATION_BUILD_SPEC_COMMIT_SHA;
if (
  injectedSpecCommitSha !== undefined &&
  !/^[a-f0-9]{40}$/.test(injectedSpecCommitSha)
) {
  throw new Error(
    "PPT_EVALUATION_BUILD_SPEC_COMMIT_SHA must be an exact 40-character source revision",
  );
}

/**
 * Release builds inject the source revision into the process before the
 * executable module graph is loaded. The fallback is intentionally labelled
 * TEST_ONLY and is rejected by the production harness.
 */
export const BUILD_SPEC_COMMIT_SHA =
  injectedSpecCommitSha ??
  "31f8a33e3990936c0c3c1b7109c6ae7131fc2081";
export const BUILD_IDENTITY_SOURCE =
  injectedSpecCommitSha === undefined
    ? "TEST_ONLY_SOURCE_FIXTURE"
    : "BUILD_INJECTED_SOURCE_REVISION";

export const BUILD_IDENTITY = Object.freeze({
  schemaVersion: "ppt-evaluation-build-identity-v1" as const,
  specCommitSha: BUILD_SPEC_COMMIT_SHA,
  source: BUILD_IDENTITY_SOURCE,
  manifestHash: `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "ppt-evaluation-build-identity-v1",
        specCommitSha: BUILD_SPEC_COMMIT_SHA,
        source: BUILD_IDENTITY_SOURCE,
      }),
    )
    .digest("hex")}` as const,
});
