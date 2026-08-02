import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSystemEgressAuthorizationAudit,
  FileSystemJudgeEgressAudit,
  FileSystemReferencePackStore,
  assertHarnessOwnedDurableEgressAuthorizationAudit,
  assertHarnessOwnedDurableJudgeEgressAudit,
  assertHarnessOwnedDurableReferencePackStore,
  createHarnessOwnedProductionOperationalDurability,
} from "../src/file-system-operational-durability.ts";
import type { ApprovedEgressAuthorization } from "../src/egress-authorization.ts";

type OperationalDurabilityModule = typeof import(
  "../src/file-system-operational-durability.ts"
);
// @ts-expect-error Per-object production ownership registration is private.
type ForbiddenOperationalOwnershipFactory = OperationalDurabilityModule["createHarnessOwnedFileSystemEgressAuthorizationAudit"];

function decision(): ApprovedEgressAuthorization {
  return {
    status: "approved",
    decisionId: "operational-leaf-symlink-decision",
    policyVersion: "test-policy-v1",
    request: {
      requestId: "operational-leaf-symlink-request",
      jobId: "operational-leaf-symlink-job",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "test-storage",
      targetAccount: "test",
      targetRegion: "local",
      subprocessors: [],
      contentFields: ["operational_ledger"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
      requestedAt: "2026-08-02T00:00:00.000Z",
    },
    legalSecurityBasis: "test",
    approvedAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

test("deep imports cannot mint operational production ownership", async () => {
  const implementationModule = await import(
    "../src/file-system-operational-durability.ts"
  );

  for (const forbiddenExport of [
    "createHarnessOwnedFileSystemEgressAuthorizationAudit",
    "createHarnessOwnedFileSystemJudgeEgressAudit",
    "createHarnessOwnedFileSystemReferencePackStore",
  ]) {
    assert.equal(forbiddenExport in implementationModule, false);
  }

  const forbiddenPackageSubpath = [
    "ppt-evaluation-harness",
    "file-system-operational-durability",
  ].join("/");
  await assert.rejects(
    import(forbiddenPackageSubpath),
    (error: unknown) => {
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
      );
      return true;
    },
  );
});

test("public operational durability constructors cannot mint production ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "operational-ownership-"));
  try {
    const harnessOwned = createHarnessOwnedProductionOperationalDurability({
      rootPath: join(root, "harness-owned"),
    });
    assert.equal(Object.isFrozen(harnessOwned), true);
    assert.equal(
      harnessOwned.egressAuthorizationAudit.auditId,
      "production-egress-authorization-audit-v1",
    );
    assert.equal(
      harnessOwned.judgeEgressAudit.auditId,
      "production-judge-egress-audit-v1",
    );
    assert.throws(
      () => assertHarnessOwnedDurableEgressAuthorizationAudit(
        new FileSystemEgressAuthorizationAudit({
          auditId: "caller-egress-audit",
          rootPath: join(root, "egress"),
        }),
      ),
      /harness-owned/i,
    );
    assert.doesNotThrow(() =>
      assertHarnessOwnedDurableEgressAuthorizationAudit(
        harnessOwned.egressAuthorizationAudit,
      )
    );
    assert.doesNotThrow(() =>
      assertHarnessOwnedDurableJudgeEgressAudit(
        harnessOwned.judgeEgressAudit,
      )
    );
    assert.doesNotThrow(() =>
      assertHarnessOwnedDurableReferencePackStore(
        harnessOwned.referencePackStore,
      )
    );
    assert.throws(
      () => assertHarnessOwnedDurableJudgeEgressAudit(
        new FileSystemJudgeEgressAudit({
          auditId: "caller-judge-audit",
          rootPath: join(root, "judge"),
        }),
      ),
      /harness-owned/i,
    );
    assert.throws(
      () => assertHarnessOwnedDurableReferencePackStore(
        new FileSystemReferencePackStore({
          rootPath: join(root, "reference-pack"),
        }),
      ),
      /harness-owned/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational durability rejects symbolic roots and symbolic immutable leaves", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "operational-symlink-"));
  const actualRoot = join(fixture, "actual");
  const symbolicRoot = join(fixture, "symbolic");
  try {
    await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, symbolicRoot, "dir");
    assert.throws(
      () => new FileSystemEgressAuthorizationAudit({
        auditId: "symbolic-root-audit",
        rootPath: symbolicRoot,
      }),
      /symbolic link root/i,
    );

    const audit = new FileSystemEgressAuthorizationAudit({
      auditId: "symbolic-leaf-audit",
      rootPath: actualRoot,
    });
    const approved = decision();
    const target = join(fixture, "outside.json");
    await writeFile(target, JSON.stringify(approved), { mode: 0o600 });
    const leaf = join(
      actualRoot,
      `${createHash("sha256")
        .update(approved.decisionId)
        .digest("hex")}.json`,
    );
    await symlink(target, leaf, "file");
    await assert.rejects(
      audit.append(approved),
      /symbolic link|nofollow|regular file/i,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
