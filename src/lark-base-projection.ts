import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import type {
  FeishuReport,
  RunRecord,
} from "./domain.ts";
import {
  InMemoryFeishuProjection,
  ProjectionStaleBaselineError,
  type FeishuProjectionPort,
  type FeishuProjectionSnapshot,
  type ProjectionCommitBaseline,
} from "./feishu.ts";
import type {
  ApprovedEgressAuthorization,
  ClockPort,
  EgressAuthorizationAuditPort,
  EgressAuthorizationPort,
  EgressDestinationMetadata,
} from "./egress-authorization.ts";
import {
  assertApprovedEgressAuthorizationCurrent,
  requireEgressAuthorization,
  SYSTEM_CLOCK,
} from "./egress-authorization.ts";
import {
  canonicalJsonBytes,
  sha256Bytes,
} from "./run-specification.ts";

export type LarkProjectionTableKey =
  | "cases"
  | "runs"
  | "artifacts"
  | "scores"
  | "workflow_events"
  | "comparisons"
  | "commit_markers";

export interface LarkBaseProjectionTransportPort {
  readonly transportId: string;
  readonly pageEvidenceBaseUrl: string;
  dispose?(): Promise<void>;
  acquireProjectionMutex?(
    jobId: string,
    options?: {
      readonly requireReportDocument?: boolean;
    },
  ): Promise<() => Promise<void>>;
  withProjectionMutex?<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  preflight(options?: {
    readonly requireReportDocument?: boolean;
  }): Promise<void>;
  upsertRecord(command: {
    readonly tableKey: LarkProjectionTableKey;
    readonly stableId: string;
    readonly payload: string;
    readonly payloadHash: `sha256:${string}`;
    readonly idempotencyKey: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<{
    readonly remoteRecordId: string;
    readonly recordUrl: string;
  }>;
  verifyRecord(command: {
    readonly tableKey: LarkProjectionTableKey;
    readonly stableId: string;
    readonly payload: string;
    readonly payloadHash: `sha256:${string}`;
  }): Promise<void>;
  uploadAttachment(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
    readonly stableId: string;
    readonly attachmentRole: string;
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentHash: `sha256:${string}`;
    readonly idempotencyKey: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<{
    readonly fileToken: string;
    readonly remoteHash: `sha256:${string}`;
    readonly attachmentUrl: string;
  }>;
  downloadAttachment(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
    readonly stableId: string;
    readonly fileToken: string;
    readonly attachmentRole: string;
    /**
     * Test transports may use this immutable expected value. Verified
     * production transports always download through lark-cli.
     */
    readonly expectedContent: Uint8Array;
  }): Promise<Uint8Array>;
  createRecordShareLink(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<string>;
  verifyPageEvidence(command: {
    readonly stableId: string;
    readonly jobId: string;
    readonly runId: string;
    readonly sourceCaptureRecordId: string;
    readonly artifactId: string;
    readonly pageNumber: number;
    readonly filename: string;
    readonly mimeType: "image/svg+xml" | "image/png";
    readonly content: Uint8Array;
    readonly contentHash: `sha256:${string}`;
    readonly expectedUrl: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<void>;
  upsertReportCollection(command: {
    readonly jobId: string;
    readonly reports: readonly {
      readonly reportId: string;
      readonly title: string;
      readonly markdown: string;
      readonly payloadHash: `sha256:${string}`;
    }[];
    readonly collectionHash: `sha256:${string}`;
    readonly idempotencyKey: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<{
    readonly url: string;
    readonly remoteContentHash: `sha256:${string}`;
    readonly revisionId: number;
  }>;
  verifyReportCollection(command: {
    readonly jobId: string;
    readonly reports: readonly {
      readonly reportId: string;
      readonly title: string;
      readonly markdown: string;
      readonly payloadHash: `sha256:${string}`;
    }[];
    readonly collectionHash: `sha256:${string}`;
    readonly expectedUrl: string;
    readonly expectedRevisionId: number;
  }): Promise<void>;
  readCommitMarker(command: {
    readonly jobId: string;
  }): Promise<LarkCommitMarker | null>;
  readProductionJobState?(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
  }): Promise<ProductionJobRemoteState>;
  claimProductionJob?(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly claimantId: string;
    readonly claimAttemptId: string;
    readonly authorization: ApprovedEgressAuthorization;
    readonly claimedAt: string;
  }): Promise<"claimed" | "already_claimed">;
  abortProductionJobClaimBeforeSubmission?(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly claimantId: string;
    readonly claimAttemptId: string;
    readonly authorization: ApprovedEgressAuthorization;
    readonly notSubmittedAttemptIds: readonly string[];
    readonly abortedAt: string;
  }): Promise<void>;
  commitBatch(command: {
    readonly schemaVersion: "lark-projection-commit-v2";
    readonly jobId: string;
    readonly batchHash: `sha256:${string}`;
    readonly authorizationDecisionId: string;
    readonly recordCount: number;
    readonly attachmentCount: number;
    readonly reportUrls: readonly {
      readonly reportId: string;
      readonly url: string;
    }[];
    readonly reportCollectionHash: `sha256:${string}` | null;
    readonly reportDocumentRevision: number | null;
    readonly pageEvidenceUrls: readonly {
      readonly artifactId: string;
      readonly pageNumber: number;
      readonly url: string;
    }[];
    readonly attachments: readonly LarkCommitMarkerAttachment[];
    readonly committedAt: string;
    readonly previousBatchHash: `sha256:${string}` | null;
    readonly revision: number;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<void>;
}

export interface LarkCommitMarker {
  readonly schemaVersion: "lark-projection-commit-v2";
  readonly jobId: string;
  readonly batchHash: `sha256:${string}`;
  readonly authorizationDecisionId: string;
  readonly recordCount: number;
  readonly attachmentCount: number;
  readonly reportUrls: readonly {
    readonly reportId: string;
    readonly url: string;
  }[];
  readonly reportCollectionHash: `sha256:${string}` | null;
  readonly reportDocumentRevision: number | null;
  readonly pageEvidenceUrls: readonly {
    readonly artifactId: string;
    readonly pageNumber: number;
    readonly url: string;
  }[];
  readonly attachments: readonly LarkCommitMarkerAttachment[];
  readonly committedAt: string;
  readonly previousBatchHash: `sha256:${string}` | null;
  readonly revision: number;
}

export interface LarkCommitMarkerAttachment {
  readonly stableId: string;
  readonly remoteRecordId: string;
  readonly fileToken: string;
  readonly role: string;
  readonly contentHash: `sha256:${string}`;
}

export interface ProductionJobRemoteState {
  readonly state:
    | "absent"
    | "commit_marker_present_unverified"
    | "job_record_present"
    | "vendor_run_present";
  readonly marker: LarkCommitMarker | null;
  readonly observedStableIds: readonly string[];
}

const VERIFIED_LARK_TRANSPORTS =
  new WeakSet<LarkBaseProjectionTransportPort>();
const VERIFIED_LARK_DESTINATIONS =
  new WeakMap<
    LarkBaseProjectionTransportPort,
    { readonly targetAccount: string; readonly targetRegion: string }
  >();
const HARNESS_OWNED_LARK_PROJECTIONS =
  new WeakMap<object, LarkBaseProjectionTransportPort>();

export const FROZEN_LARK_CLI_BINARY =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/bin/lark-cli";
export const FROZEN_LARK_CLI_SHA256 =
  "sha256:4b38c877ec833fe72c370dad3768d0564ff678fde1a488910be3e38b0a1e1238" as const;
export const FROZEN_LARK_CLI_VERSION = "1.0.72";
export const FROZEN_LARK_CLI_WRAPPER =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/lark-cli";
export const FROZEN_LARK_CLI_WRAPPER_TARGET =
  "../lib/node_modules/@larksuite/cli/scripts/run.js";
export const FROZEN_LARK_CLI_SCRIPT =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/scripts/run.js";
export const FROZEN_LARK_CLI_SCRIPT_SHA256 =
  "sha256:b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577" as const;

export interface LarkCliProjectionConfiguration {
  /**
   * The MVP supports one workstation only. Every stable-ID mutation, Job
   * claim, and complete Docx/Base projection transaction is serialized by a
   * crash-recoverable filesystem mutex shared by all local processes.
   */
  readonly concurrencyBoundary: "single_workstation_durable_mutex";
  /**
   * One explicit, normalized machine-local directory shared by every worker.
   * Verified production never derives this boundary from TMPDIR.
   */
  readonly lockRootPath: string;
  readonly baseTokenEnvironmentVariable: string;
  /**
   * Logical record kinds may intentionally share one physical Base table.
   * The MVP uses cases, runs/artifacts/commit markers, scores, and
   * comparisons/workflow events across four physical tables.
   */
  readonly tables: Readonly<Record<LarkProjectionTableKey, string>>;
  readonly stableIdField: string;
  readonly payloadField: string;
  readonly payloadHashField: string;
  readonly artifactAttachmentField: string;
  readonly baseWebUrl: string;
  /**
   * Deterministic staging namespace used before each page is materialized as
   * its own Feishu Base record. Staging URLs never cross the commit marker:
   * they are replaced by native `/record/<token>` share links after upload.
   */
  readonly pageEvidenceBaseUrl: string;
  /**
   * Production report delivery updates one pre-provisioned Docx document.
   * Provisioning that document is an explicit external readiness gate.
   */
  readonly reportDocumentTokenEnvironmentVariable: string;
  readonly reportDocumentExpectedOrigin: string;
  readonly targetAccount: string;
  readonly targetRegion: string;
  /**
   * Exact user-scoped `lark-cli whoami` binding. Verified production
   * preflight fails closed when this is absent or differs from the current
   * profile/app/user identity.
   */
  readonly cliIdentityBinding?: {
    readonly profile: string;
    readonly appId: string;
    readonly brand: "feishu" | "lark";
    readonly defaultAs: string;
    readonly identitySource: string;
    readonly userOpenId: string;
    readonly tenantKey: string;
  };
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const LARK_PROCESS_START_IDENTITY: string = (() => {
  const identity = readProcessStartIdentity(process.pid);
  if (identity === null) {
    throw new Error("Current Lark process start identity is unavailable");
  }
  return identity;
})();
const LARK_MUTEX_WAIT_TIMEOUT_MS = 35 * 60 * 1_000;
const FROZEN_MACOS_LOCKF_BINARY = "/usr/bin/lockf";
const FROZEN_MACOS_LOCKF_SHA256 =
  "sha256:0ec2e00997f6b6660dc74b849b00ad25c69ba9b41496248c1d8aaa96977d0071" as const;
const FROZEN_MACOS_LOCKF_USAGE =
  "usage: lockf [-knsw] [-t seconds] file command [arguments]\n" +
  "       lockf [-s] [-t seconds] fd\n";
const MACOS_LOCKF_IDENTITY =
  `macos-lockf-v1:${FROZEN_MACOS_LOCKF_BINARY}:${FROZEN_MACOS_LOCKF_SHA256}` as const;
const LOCKF_ACQUIRED_HANDSHAKE = "ppt-lockf-acquired-v1\n";
const LOCKF_RELEASE_COMMAND = "release\n";
const LOCKF_HOLDER_SCRIPT = [
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (value) => { input += value; });',
  'process.stdin.on("end", () => {',
  `  process.exit(input === "" || input === ${JSON.stringify(LOCKF_RELEASE_COMMAND)} ? 0 : 64);`,
  "});",
  `process.stdout.write(${JSON.stringify(LOCKF_ACQUIRED_HANDSHAKE)});`,
  "process.stdin.resume();",
].join("\n");

interface LarkExecutionLeasePort {
  readonly leaseId: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  isActive(
    leaseId: string,
    processId: number,
    processStartIdentity: string,
  ): Promise<boolean>;
  release(): Promise<void>;
}

function larkExecutionLeaseSentinelPath(
  lockRoot: string,
  leaseId: string,
): string {
  if (leaseId.trim().length === 0) {
    throw new Error("Lark execution lease ID is invalid");
  }
  return join(
    resolve(lockRoot),
    `lease-${sha256(leaseId).slice("sha256:".length)}.lock`,
  );
}

function createProcessLarkExecutionLease(options: {
  readonly lockRoot: string;
  readonly leaseId?: string;
  readonly processId?: number;
  readonly processStartIdentity?: string;
}): LarkExecutionLeasePort {
  const leaseId = options.leaseId ?? randomUUID();
  const processId = options.processId ?? process.pid;
  const processStartIdentity =
    options.processStartIdentity ?? LARK_PROCESS_START_IDENTITY;
  let sentinelRelease: (() => Promise<void>) | null = null;
  let sentinelAcquisition: Promise<void> | null = null;
  let released = false;
  const ensureSentinelOwned = async (): Promise<void> => {
    if (released) {
      throw new Error("Lark execution lease is already released");
    }
    if (sentinelRelease !== null) return;
    sentinelAcquisition ??= (async () => {
      const release = await acquireMacOsAdvisoryLock(
        larkExecutionLeaseSentinelPath(options.lockRoot, leaseId),
        0,
        { unrefAfterAcquisition: true },
      );
      sentinelRelease = release;
    })();
    await sentinelAcquisition;
  };
  return Object.freeze({
    leaseId,
    processId,
    processStartIdentity,
    async isActive(
      candidateLeaseId: string,
      candidateProcessId: number,
      candidateProcessStartIdentity: string,
    ): Promise<boolean> {
      if (
        candidateLeaseId === leaseId &&
        candidateProcessId === processId &&
        candidateProcessStartIdentity === processStartIdentity
      ) {
        if (released) return false;
        await ensureSentinelOwned();
        return true;
      }
      try {
        const release = await acquireMacOsAdvisoryLock(
          larkExecutionLeaseSentinelPath(
            options.lockRoot,
            candidateLeaseId,
          ),
          0,
        );
        await release();
        return false;
      } catch (error) {
        if (error instanceof LarkAdvisoryLockUnavailableError) {
          return true;
        }
        throw error;
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (sentinelAcquisition !== null) {
        await sentinelAcquisition;
      }
      const release = sentinelRelease;
      sentinelRelease = null;
      if (release !== null) {
        await release();
      }
    },
  });
}

function larkMutexRoot(
  configuration: LarkCliProjectionConfiguration,
): string {
  const root = resolve(configuration.lockRootPath);
  if (
    configuration.lockRootPath !== root ||
    root === sep
  ) {
    throw new Error(
      "Lark production concurrency requires one normalized fixed machine lock root",
    );
  }
  return root;
}

function larkBaseConcurrencyIdentities(
  configuration: LarkCliProjectionConfiguration,
): readonly string[] {
  const baseToken =
    process.env[configuration.baseTokenEnvironmentVariable]?.trim();
  if (baseToken === undefined || baseToken.length === 0) {
    throw new Error(
      `Lark Base credential ${configuration.baseTokenEnvironmentVariable} is unavailable`,
    );
  }
  const tableIds = [
    ...new Set(Object.values(configuration.tables)),
  ].sort();
  return Object.freeze(
    tableIds.map((tableId) =>
      canonicalPayload({
        schemaVersion: "lark-base-table-concurrency-resource-v1",
        baseToken,
        tableId,
      }),
    ),
  );
}

function larkReportDocumentToken(
  configuration: LarkCliProjectionConfiguration,
): string {
  const value =
    process.env[
      configuration.reportDocumentTokenEnvironmentVariable
    ];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `Lark report document ${configuration.reportDocumentTokenEnvironmentVariable} is unavailable`,
    );
  }
  const trimmed = value.trim();
  const urlMatch = /\/docx\/([a-zA-Z0-9_-]{8,128})(?:[?#/]|$)/.exec(
    trimmed,
  );
  const token = urlMatch?.[1] ?? trimmed;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
    throw new Error("Lark report document token is invalid");
  }
  return token;
}

function larkReportConcurrencyIdentity(
  configuration: LarkCliProjectionConfiguration,
): string {
  return canonicalPayload({
    schemaVersion: "lark-report-concurrency-resource-v1",
    documentToken: larkReportDocumentToken(configuration),
    expectedOrigin: configuration.reportDocumentExpectedOrigin,
  });
}

function larkOperationMutexScope(
  kind: "projection" | "stable-record" | "claim" | "preflight",
  identity: string,
): string {
  return canonicalPayload({
    schemaVersion: "lark-single-workstation-mutex-scope-v2",
    kind,
    identity,
  });
}

function processIsAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function readProcessStartIdentity(processId: number): string | null {
  if (!processIsAlive(processId)) return null;
  let output: string;
  try {
    output = execFileSync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(processId)],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch (error) {
    if (!processIsAlive(processId)) return null;
    throw new Error(
      `Lark process start identity lookup failed for PID ${processId}`,
      { cause: error },
    );
  }
  if (output.length === 0) {
    if (!processIsAlive(processId)) return null;
    throw new Error(
      `Lark process start identity is empty for PID ${processId}`,
    );
  }
  return sha256(
    `lark-process-start-v1\u0000${processId}\u0000${output}`,
  );
}

let lockfUsageAttestation: Promise<void> | null = null;

async function assertFrozenMacOsLockfInstallation(): Promise<void> {
  if (resolve(FROZEN_MACOS_LOCKF_BINARY) !== FROZEN_MACOS_LOCKF_BINARY) {
    throw new Error("macOS lockf path is not canonical");
  }
  const binaryHash = sha256(
    Uint8Array.from(await readFile(FROZEN_MACOS_LOCKF_BINARY)),
  );
  if (binaryHash !== FROZEN_MACOS_LOCKF_SHA256) {
    throw new Error(
      "macOS lockf executable does not match the reviewed installation",
    );
  }
  lockfUsageAttestation ??= new Promise<void>(
    (resolveAttestation, rejectAttestation) => {
      const child = spawn(FROZEN_MACOS_LOCKF_BINARY, [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      });
      let stdout = "";
      let stderr = "";
      const appendBounded = (
        current: string,
        value: string,
      ): string => {
        const next = current + value;
        if (Buffer.byteLength(next, "utf8") > 4_096) {
          child.kill("SIGKILL");
          throw new Error("macOS lockf identity output exceeded its bound");
        }
        return next;
      };
      child.stdout.setEncoding("utf8").on("data", (value: string) => {
        try {
          stdout = appendBounded(stdout, value);
        } catch (error) {
          rejectAttestation(error);
        }
      });
      child.stderr.setEncoding("utf8").on("data", (value: string) => {
        try {
          stderr = appendBounded(stderr, value);
        } catch (error) {
          rejectAttestation(error);
        }
      });
      child.once("error", rejectAttestation);
      child.once("close", (code, signal) => {
        if (
          code !== 64 ||
          signal !== null ||
          stdout !== "" ||
          stderr !== FROZEN_MACOS_LOCKF_USAGE
        ) {
          rejectAttestation(
            new Error(
              "macOS lockf version/usage identity does not match the reviewed installation",
            ),
          );
          return;
        }
        resolveAttestation();
      });
    },
  );
  await lockfUsageAttestation;
}

class LarkAdvisoryLockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LarkAdvisoryLockUnavailableError";
  }
}

async function acquireMacOsAdvisoryLock(
  lockPath: string,
  waitTimeoutMs: number,
  options: {
    readonly unrefAfterAcquisition?: boolean;
  } = {},
): Promise<() => Promise<void>> {
  await assertFrozenMacOsLockfInstallation();
  const timeoutSeconds = Math.max(0, Math.ceil(waitTimeoutMs / 1_000));
  const child = spawn(
    FROZEN_MACOS_LOCKF_BINARY,
    [
      "-k",
      "-s",
      "-t",
      String(timeoutSeconds),
      lockPath,
      process.execPath,
      "--input-type=module",
      "-e",
      LOCKF_HOLDER_SCRIPT,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let acquired = false;
  let releaseRequested = false;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquiredPromise = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const closedPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClosed, rejectClosed) => {
    child.once("error", (error) => {
      rejectAcquired(error);
      rejectClosed(error);
    });
    child.once("close", (code, signal) => {
      if (!acquired) {
        rejectAcquired(
          new LarkAdvisoryLockUnavailableError(
            code === 75
              ? "Lark single-workstation durable mutex wait timed out"
              : `macOS lockf exited before acquisition with ${String(code ?? signal)}`,
            ),
        );
      } else if (!releaseRequested) {
        // A critical section must never outlive the helper that owns its OS
        // lock. There is no safe in-process recovery after another worker may
        // have observed the lock as available, so production deliberately
        // fails the whole owner process closed.
        process.kill(process.pid, "SIGKILL");
        return;
      }
      resolveClosed({ code, signal });
    });
  });
  child.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value;
    if (
      Buffer.byteLength(stdout, "utf8") >
        Buffer.byteLength(LOCKF_ACQUIRED_HANDSHAKE, "utf8") ||
      !LOCKF_ACQUIRED_HANDSHAKE.startsWith(stdout)
    ) {
      child.kill("SIGKILL");
      rejectAcquired(
        new Error("macOS lockf holder emitted an invalid handshake"),
      );
      return;
    }
    if (stdout === LOCKF_ACQUIRED_HANDSHAKE) {
      acquired = true;
      resolveAcquired();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
    if (Buffer.byteLength(stderr, "utf8") > 4_096) {
      child.kill("SIGKILL");
      rejectAcquired(
        new Error("macOS lockf holder stderr exceeded its bound"),
      );
    }
  });
  try {
    await acquiredPromise;
  } catch (error) {
    child.stdin.destroy();
    await closedPromise.catch(() => undefined);
    throw error;
  }
  if (options.unrefAfterAcquisition === true) {
    child.unref();
    (
      child.stdin as typeof child.stdin & { unref(): void }
    ).unref();
    (
      child.stdout as typeof child.stdout & { unref(): void }
    ).unref();
    (
      child.stderr as typeof child.stderr & { unref(): void }
    ).unref();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseRequested = true;
    if (options.unrefAfterAcquisition === true) {
      child.ref();
      (
        child.stdin as typeof child.stdin & { ref(): void }
      ).ref();
      (
        child.stdout as typeof child.stdout & { ref(): void }
      ).ref();
      (
        child.stderr as typeof child.stderr & { ref(): void }
      ).ref();
    }
    child.stdin.end(LOCKF_RELEASE_COMMAND);
    const { code, signal } = await closedPromise;
    if (
      !releaseRequested ||
      code !== 0 ||
      signal !== null ||
      stderr !== ""
    ) {
      throw new Error(
        `macOS lockf release failed for ${MACOS_LOCKF_IDENTITY}`,
      );
    }
  };
}

async function acquireLarkSingleWorkstationMutex(
  configuration: LarkCliProjectionConfiguration,
  scope: string,
  options: {
    readonly waitTimeoutMs?: number;
    readonly resourceIdentityForTest?: string;
    readonly includeReportDocument?: boolean;
  } = {},
): Promise<() => Promise<void>> {
  if (
    configuration.concurrencyBoundary !==
    "single_workstation_durable_mutex"
  ) {
    throw new Error(
      "Lark production concurrency requires the declared single-workstation durable mutex boundary",
    );
  }
  const root = larkMutexRoot(configuration);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const resourceIdentities =
    options.resourceIdentityForTest === undefined
      ? [
          ...larkBaseConcurrencyIdentities(configuration),
          ...(options.includeReportDocument === true
            ? [larkReportConcurrencyIdentity(configuration)]
            : []),
        ].sort()
      : [options.resourceIdentityForTest];
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const resourceIdentity of resourceIdentities) {
      const lockPath = join(
        root,
        `${sha256(canonicalPayload({
          resourceIdentity,
          operationScope: scope,
        })).slice("sha256:".length)}.lock`,
      );
      releases.push(
        await acquireMacOsAdvisoryLock(
          lockPath,
          options.waitTimeoutMs ?? LARK_MUTEX_WAIT_TIMEOUT_MS,
        ),
      );
    }
  } catch (error) {
    for (const release of releases.reverse()) {
      await release();
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) {
      await release();
    }
  };
}

/**
 * Narrow process-level seam for proving that the production filesystem mutex
 * survives owner-process termination. It does not expose transport mutation.
 */
export async function acquireLarkSingleWorkstationMutexForTest(options: {
  readonly lockRoot: string;
  readonly scope: string;
  readonly waitTimeoutMs?: number;
}): Promise<() => Promise<void>> {
  nonEmpty(options.lockRoot, "Lark mutex test root");
  nonEmpty(options.scope, "Lark mutex test scope");
  return await acquireLarkSingleWorkstationMutex(
    {
      concurrencyBoundary: "single_workstation_durable_mutex",
      lockRootPath: resolve(options.lockRoot),
      baseTokenEnvironmentVariable: "PPT_LARK_MUTEX_TEST_UNUSED",
      reportDocumentTokenEnvironmentVariable:
        "PPT_LARK_MUTEX_TEST_UNUSED",
      tables: {
        cases: "tblMutex0001",
        runs: "tblMutex0001",
        artifacts: "tblMutex0001",
        scores: "tblMutex0001",
        workflow_events: "tblMutex0001",
        comparisons: "tblMutex0001",
        commit_markers: "tblMutex0001",
      },
      stableIdField: "stable_id",
      payloadField: "payload",
      payloadHashField: "payload_hash",
      artifactAttachmentField: "attachment",
      baseWebUrl: "https://mutex.invalid/base/test",
      pageEvidenceBaseUrl: "https://mutex.invalid/evidence/test",
      reportDocumentExpectedOrigin: "https://mutex.invalid",
      targetAccount: "mutex-test",
      targetRegion: "test",
    },
    options.scope,
    options.waitTimeoutMs === undefined
      ? {
          resourceIdentityForTest:
            "lark-mutex-public-test-resource-v1",
        }
      : {
          waitTimeoutMs: options.waitTimeoutMs,
          resourceIdentityForTest:
            "lark-mutex-public-test-resource-v1",
        },
  );
}

/**
 * Narrow process-level seam for proving that claim liveness is established by
 * an OS advisory sentinel rather than a PID timestamp.
 */
export function createLarkExecutionLeaseForTest(options: {
  readonly lockRoot: string;
  readonly leaseId: string;
  readonly processId: number;
  readonly processStartIdentity: string;
}): LarkExecutionLeasePort {
  const lockRoot = resolve(options.lockRoot);
  if (lockRoot === sep) {
    throw new Error("Lark execution lease test root is too broad");
  }
  return createProcessLarkExecutionLease({
    lockRoot,
    leaseId: options.leaseId,
    processId: options.processId,
    processStartIdentity: options.processStartIdentity,
  });
}

function assertHttps(value: string, label: string): void {
  if (!/^https:\/\/[^/\s]+\/.+/.test(value)) {
    throw new Error(`${label} requires real HTTPS evidence`);
  }
}

function assertHttpsBase(value: string, label: string): void {
  if (!/^https:\/\/[^/\s]+(?:\/.*)?$/.test(value)) {
    throw new Error(`${label} requires a real HTTPS base URL`);
  }
}

function assertCanonicalLarkBaseWebUrl(
  value: string,
  expectedOrigin: string,
): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== expectedOrigin ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname === "/" ||
    parsed.pathname.endsWith("/") ||
    parsed.toString() !== value
  ) {
    throw new Error(
      "Verified Lark transport requires one canonical Base URL on the configured Feishu origin",
    );
  }
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Lark Base projection ${label} is missing`);
  }
}

function sanitizedPayload(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Object.freeze({
      byteLength: value.byteLength,
      contentHash: sha256(value),
    });
  }
  if (Array.isArray(value)) return value.map(sanitizedPayload);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sanitizedPayload(entry)]),
    );
  }
  return value;
}

function canonicalPayload(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

function asObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lark-cli ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`lark-cli ${label} is invalid`);
  }
  return value;
}

export function parseLarkRecordSearchEnvelope(
  value: unknown,
): readonly Record<string, unknown>[] {
  const envelope = asObject(value, "record-search envelope");
  if (envelope.ok !== true) {
    throw new Error("lark-cli record-search envelope is not successful");
  }
  const body = asObject(envelope.data, "record-search data");
  const rows = body.data;
  const fields = body.fields;
  const fieldIds = body.field_id_list;
  const recordIds = body.record_id_list;
  if (
    !Array.isArray(rows) ||
    !Array.isArray(fields) ||
    !Array.isArray(fieldIds) ||
    !Array.isArray(recordIds) ||
    body.has_more !== false ||
    fields.length !== fieldIds.length ||
    rows.length !== recordIds.length ||
    fields.some((field) => typeof field !== "string" || field.length === 0) ||
    fieldIds.some(
      (fieldId) => typeof fieldId !== "string" || fieldId.length === 0,
    ) ||
    recordIds.some(
      (recordId) => typeof recordId !== "string" || recordId.length === 0,
    )
  ) {
    throw new Error(
      "lark-cli record-search returned an incomplete or paginated columnar envelope",
    );
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("lark-cli record-search returned duplicate fields");
  }
  return Object.freeze(
    rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== fields.length) {
        throw new Error(
          "lark-cli record-search row length does not match fields",
        );
      }
      return Object.freeze({
        record_id: recordIds[rowIndex],
        fields: Object.freeze(
          Object.fromEntries(
            fields.map((field, columnIndex) => [
              field,
              row[columnIndex],
            ]),
          ),
        ),
        field_ids: Object.freeze(
          Object.fromEntries(
            fieldIds.map((fieldId, columnIndex) => [
              fieldId,
              row[columnIndex],
            ]),
          ),
        ),
      });
    }),
  );
}

export function parseLarkRecordUpsertEnvelope(
  value: unknown,
  expectedRecordId: string | null,
): string {
  const envelope = asObject(value, "record-upsert envelope");
  if (envelope.ok !== true) {
    throw new Error("lark-cli record-upsert envelope is not successful");
  }
  const body = asObject(envelope.data, "record-upsert data");
  const record = asObject(body.record, "record-upsert record");
  const recordId = asNonEmptyString(
    record.record_id,
    "record-upsert record ID",
  );
  const ignoredFields = body.ignored_fields;
  if (
    (ignoredFields !== undefined &&
      (!Array.isArray(ignoredFields) || ignoredFields.length !== 0)) ||
    (expectedRecordId === null
      ? body.created !== true || body.updated === true
      : body.updated !== true ||
        body.created === true ||
        recordId !== expectedRecordId)
  ) {
    throw new Error(
      "lark-cli record-upsert result is not bound to the requested mutation",
    );
  }
  return recordId;
}

export function parseLarkRecordShareLinkEnvelope(
  value: unknown,
  expectedRecordId: string,
  expectedOrigin: string,
): string {
  const envelope = asObject(value, "record-share-link envelope");
  if (envelope.ok !== true) {
    throw new Error(
      "lark-cli record-share-link envelope is not successful",
    );
  }
  const body = asObject(envelope.data, "record-share-link data");
  const links = asObject(
    body.record_share_links,
    "record-share-link mapping",
  );
  if (
    Object.keys(links).length !== 1 ||
    typeof links[expectedRecordId] !== "string"
  ) {
    throw new Error(
      "lark-cli record-share-link is not bound to the requested record",
    );
  }
  const url = new URL(links[expectedRecordId] as string);
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    !/^\/record\/[a-zA-Z0-9_-]{8,256}$/.test(url.pathname) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "lark-cli record-share-link is not a trusted Feishu record URL",
    );
  }
  return url.toString();
}

function normalizeMarkdown(value: string): string {
  return `${value.replace(/\r\n?/g, "\n").trimEnd()}\n`;
}

function collectionReportBody(report: {
  readonly reportId: string;
  readonly title: string;
  readonly markdown: string;
}): string {
  const lines = report.markdown.replace(/\r\n?/g, "\n").split("\n");
  const firstContentLine = lines.findIndex(
    (line) => line.trim().length > 0,
  );
  if (
    firstContentLine < 0 ||
    lines[firstContentLine] !== `# ${report.title}`
  ) {
    throw new Error(
      `Lark report ${report.reportId} must start with an H1 matching its title`,
    );
  }
  lines.splice(firstContentLine, 1);
  return lines
    .join("\n")
    .trim()
    .replace(/^(#{1,5}) /gm, "#$1 ");
}

const REPORT_OWNER_SCHEMA = "lark-report-owner-v1";

function encodedReportOwner(jobId: string): string {
  nonEmpty(jobId, "report owner Job ID");
  return encodeURIComponent(jobId);
}

function reportOwnerMetadata(jobId: string): string {
  return (
    `Owner schema: \`${REPORT_OWNER_SCHEMA}\`\n\n` +
    `Owner Job: \`${encodedReportOwner(jobId)}\``
  );
}

interface LarkReportClaimBinding {
  readonly claimantId: string;
  readonly claimAttemptId: string;
  readonly claimHash: `sha256:${string}`;
  readonly claimEpoch: number;
  readonly executionLeaseId: string | null;
  readonly executionProcessId: number | null;
  readonly executionProcessStartIdentity: string | null;
}

function reportClaimBindingMetadata(
  binding: LarkReportClaimBinding,
): string {
  nonEmpty(binding.claimantId, "report owner claimant ID");
  nonEmpty(binding.claimAttemptId, "report owner claim attempt ID");
  if (!/^sha256:[a-f0-9]{64}$/.test(binding.claimHash)) {
    throw new Error("Lark report owner claim hash is invalid");
  }
  if (
    !Number.isSafeInteger(binding.claimEpoch) ||
    binding.claimEpoch < 1 ||
    binding.executionLeaseId === null ||
    binding.executionLeaseId.trim().length === 0 ||
    binding.executionProcessId === null ||
    !Number.isSafeInteger(binding.executionProcessId) ||
    binding.executionProcessId < 1 ||
    binding.executionProcessStartIdentity === null ||
    binding.executionProcessStartIdentity.trim().length === 0
  ) {
    throw new Error("Lark report owner execution lease is invalid");
  }
  return (
    `Owner claimant: \`${encodeURIComponent(binding.claimantId)}\`\n\n` +
    `Owner claim attempt: \`${encodeURIComponent(binding.claimAttemptId)}\`\n\n` +
    `Owner claim hash: \`${binding.claimHash}\`\n\n` +
    `Owner claim epoch: \`${binding.claimEpoch}\`\n\n` +
    `Owner execution lease: \`${encodeURIComponent(binding.executionLeaseId)}\`\n\n` +
    `Owner execution process: \`${binding.executionProcessId}\`\n\n` +
    `Owner execution process start: \`${encodeURIComponent(binding.executionProcessStartIdentity)}\``
  );
}

function parseReportOwner(content: string): string | null {
  if (content.trim().length === 0) return null;
  const match =
    /^# [^\n]+\n\nOwner schema: `lark-report-owner-v1`\n\nOwner Job: `([^`\n]+)`(?:\n|$)/.exec(
      normalizeMarkdown(content),
    );
  if (match === null) {
    throw new Error(
      "Lark report document is not empty and has no trusted Job owner binding",
    );
  }
  try {
    const jobId = decodeURIComponent(match[1]!);
    if (encodedReportOwner(jobId) !== match[1]) {
      throw new Error("non-canonical owner");
    }
    return jobId;
  } catch {
    throw new Error("Lark report document Job owner binding is invalid");
  }
}

function parseReportClaimBinding(
  content: string,
): LarkReportClaimBinding | null {
  const normalized = normalizeMarkdown(content);
  const owner = parseReportOwner(normalized);
  if (owner === null) return null;
  const match =
    /\n\nOwner claimant: `([^`\n]+)`\n\nOwner claim attempt: `([^`\n]+)`\n\nOwner claim hash: `(sha256:[a-f0-9]{64})`(?:\n\nOwner claim epoch: `([1-9]\d*)`\n\nOwner execution lease: `([^`\n]+)`\n\nOwner execution process: `([1-9]\d*)`(?:\n\nOwner execution process start: `([^`\n]+)`)?)?(?:\n|$)/.exec(
      normalized,
    );
  if (match === null) return null;
  try {
    const claimantId = decodeURIComponent(match[1]!);
    const claimAttemptId = decodeURIComponent(match[2]!);
    const executionLeaseId =
      match[5] === undefined ? null : decodeURIComponent(match[5]);
    const executionProcessId =
      match[6] === undefined ? null : Number(match[6]);
    const executionProcessStartIdentity =
      match[7] === undefined ? null : decodeURIComponent(match[7]);
    const claimEpoch =
      match[4] === undefined ? 0 : Number(match[4]);
    if (
      encodeURIComponent(claimantId) !== match[1] ||
      encodeURIComponent(claimAttemptId) !== match[2] ||
      (executionLeaseId !== null &&
        encodeURIComponent(executionLeaseId) !== match[5]) ||
      (executionProcessStartIdentity !== null &&
        encodeURIComponent(executionProcessStartIdentity) !== match[7]) ||
      !Number.isSafeInteger(claimEpoch) ||
      claimEpoch < 0 ||
      (executionProcessId !== null &&
        (!Number.isSafeInteger(executionProcessId) ||
          executionProcessId < 1))
    ) {
      throw new Error("non-canonical claim binding");
    }
    return Object.freeze({
      claimantId,
      claimAttemptId,
      claimHash: match[3] as `sha256:${string}`,
      claimEpoch,
      executionLeaseId,
      executionProcessId,
      executionProcessStartIdentity,
    });
  } catch {
    throw new Error("Lark report document claim binding is invalid");
  }
}

function createLarkReportOwnerMarkdown(
  jobId: string,
  binding?: LarkReportClaimBinding,
): string {
  return normalizeMarkdown(
    `# PPT 竞品自动评测｜报告槽位\n\n${reportOwnerMetadata(jobId)}` +
      (binding === undefined
        ? ""
        : `\n\n${reportClaimBindingMetadata(binding)}`),
  );
}

export function createLarkReportCollectionMarkdown(command: {
  readonly jobId: string;
  readonly reports: readonly {
    readonly reportId: string;
    readonly title: string;
    readonly markdown: string;
    readonly payloadHash: `sha256:${string}`;
  }[];
  readonly collectionHash: `sha256:${string}`;
}): string {
  const sections = command.reports.map(
    (report, index) =>
      `## ${index + 1}. ${report.title}\n\n` +
      `Report anchor: \`${report.reportId}\`\n\n` +
      `Projection payload hash: \`${report.payloadHash}\`\n\n` +
      `${collectionReportBody(report)}`,
  );
  return normalizeMarkdown(
    `# PPT 竞品自动评测｜关键结果报告\n\n` +
      `${reportOwnerMetadata(command.jobId)}\n\n` +
      `Collection hash: \`${command.collectionHash}\`\n\n` +
      `${sections.join("\n\n---\n\n")}`,
  );
}

function reportCollectionForSnapshot(
  snapshot: FeishuProjectionSnapshot,
): readonly {
  readonly reportId: string;
  readonly title: string;
  readonly markdown: string;
  readonly payloadHash: `sha256:${string}`;
}[] {
  return snapshot.reports.map((report) => ({
    reportId: report.reportId,
    title: report.title,
    markdown: report.markdown,
    payloadHash: sha256(
      JSON.stringify({
        reportId: report.reportId,
        title: report.title,
        markdown: report.markdown,
      }),
    ),
  }));
}

function reportCollectionHash(
  reports: readonly {
    readonly reportId: string;
    readonly title: string;
    readonly markdown: string;
    readonly payloadHash: `sha256:${string}`;
  }[],
): `sha256:${string}` | null {
  return reports.length === 0
    ? null
    : sha256(canonicalPayload(reports));
}

interface LarkDocumentReadback {
  readonly documentId: string;
  readonly revisionId: number;
  readonly content: string;
  readonly url: string;
}

function parseLarkDocumentUpdateRevision(
  value: unknown,
  expectedToken: string,
  expectedOrigin: string,
): number {
  const envelope = asObject(value, "document update envelope");
  if (envelope.ok !== true) {
    throw new Error("lark-cli document update envelope is not successful");
  }
  const body = asObject(envelope.data, "document update data");
  const document = asObject(body.document, "document update document");
  const urlValue = document.url;
  let trustedUrl: URL | null = null;
  try {
    trustedUrl =
      typeof urlValue === "string" ? new URL(urlValue) : null;
  } catch {
    trustedUrl = null;
  }
  if (
    body.result !== "success" ||
    !Array.isArray(body.warnings) ||
    body.warnings.length !== 0 ||
    !Number.isSafeInteger(document.revision_id) ||
    (document.revision_id as number) < 0 ||
    trustedUrl === null ||
    trustedUrl.origin !== expectedOrigin ||
    trustedUrl.pathname !== `/docx/${expectedToken}` ||
    trustedUrl.search.length > 0 ||
    trustedUrl.hash.length > 0
  ) {
    throw new Error("Lark report update was not fully successful");
  }
  return document.revision_id as number;
}

export function parseLarkDocumentReadback(
  value: unknown,
  expectedToken: string,
  expectedOrigin: string,
): LarkDocumentReadback {
  const envelope = asObject(value, "document fetch envelope");
  if (envelope.ok !== true) {
    throw new Error("lark-cli document fetch envelope is not successful");
  }
  const body = asObject(envelope.data, "document fetch data");
  const document = asObject(body.document, "document fetch document");
  const documentId = asNonEmptyString(
    document.document_id,
    "document ID",
  );
  const revisionId = document.revision_id;
  const content = document.content;
  const urlValue = document.url ?? body.url;
  if (
    documentId !== expectedToken ||
    !Number.isSafeInteger(revisionId) ||
    (revisionId as number) < 0 ||
    typeof content !== "string" ||
    !/^https:\/\/[^/\s]+$/.test(expectedOrigin)
  ) {
    throw new Error(
      "lark-cli document fetch is not bound to the configured document",
    );
  }
  const url = new URL(
    typeof urlValue === "string"
      ? urlValue
      : `/docx/${expectedToken}`,
    expectedOrigin,
  );
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== `/docx/${expectedToken}`
  ) {
    throw new Error(
      "lark-cli document fetch URL is not the configured Docx",
    );
  }
  return Object.freeze({
    documentId,
    revisionId: revisionId as number,
    content,
    url: url.toString(),
  });
}

function stableRecordId(
  tableKey: LarkProjectionTableKey,
  record: Record<string, unknown>,
): string {
  for (const key of [
    "recordId",
    "reportId",
    "comparisonId",
    "gapCardId",
    "workflowEventId",
    "reservationId",
    "linkEventId",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  throw new Error(
    `Lark Base ${tableKey} row has no stable identity`,
  );
}

function physicalStableRecordId(
  tableKey: LarkProjectionTableKey,
  record: Record<string, unknown>,
): string {
  const logicalId = stableRecordId(tableKey, record);
  switch (tableKey) {
    case "cases":
      return `case:${logicalId}`;
    case "runs": {
      switch (record.recordType) {
        case "bakeoff_job":
          return `job:${logicalId}`;
        case "vendor_run":
          return `run:${logicalId}`;
        case "evaluation_attempt":
          return `attempt:${logicalId}`;
        default:
          throw new Error(
            "Lark runs row has no recognized physical entity type",
          );
      }
    }
    case "artifacts":
      return `artifact:${logicalId}`;
    case "scores":
      return `score:${logicalId}`;
    case "workflow_events": {
      const prefixByRecordType: Readonly<Record<string, string>> = {
        adjudication_event: "adjudication",
        review_event: "review",
        gap_card_workflow_event: "gap-workflow",
        github_issue_delivery_reservation: "github-reservation",
        github_issue_link_event: "github-link",
      };
      const prefix =
        typeof record.recordType === "string"
          ? prefixByRecordType[record.recordType]
          : undefined;
      if (prefix === undefined) {
        throw new Error(
          "Lark workflow row has no recognized physical entity type",
        );
      }
      return `${prefix}:${logicalId}`;
    }
    case "comparisons":
      return record.recordType === "comparison"
        ? `comparison:${logicalId}`
        : record.recordType === "gap_card"
          ? `gap:${logicalId}`
          : (() => {
              throw new Error(
                "Lark comparison row has no recognized physical entity type",
              );
            })();
    case "commit_markers":
      throw new Error(
        "Commit marker physical IDs are assigned at the marker boundary",
      );
  }
}

function tableRows(
  snapshot: FeishuProjectionSnapshot,
): readonly {
  readonly tableKey: LarkProjectionTableKey;
  readonly value: Record<string, unknown>;
}[] {
  const rows = [
    ...snapshot.caseTable.map((value) => ({
      tableKey: "cases" as const,
      value,
    })),
    ...snapshot.runRecordTable.map((value) => ({
      tableKey: "runs" as const,
      value,
    })),
    ...snapshot.capturedArtifactTable.map((value) => ({
      tableKey: "artifacts" as const,
      value,
    })),
    ...snapshot.artifactScoreTable.map((value) => ({
      tableKey: "scores" as const,
      value,
    })),
    ...snapshot.adjudicationEventTable.map((value) => ({
      tableKey: "workflow_events" as const,
      value,
    })),
    ...snapshot.reviewEventTable.map((value) => ({
      tableKey: "workflow_events" as const,
      value,
    })),
    ...snapshot.gapCardWorkflowEventTable.map((value) => ({
      tableKey: "workflow_events" as const,
      value,
    })),
    ...snapshot.githubIssueDeliveryReservationTable.map((value) => ({
      tableKey: "workflow_events" as const,
      value,
    })),
    ...snapshot.githubIssueLinkEventTable.map((value) => ({
      tableKey: "workflow_events" as const,
      value,
    })),
    ...snapshot.productGapCardTable.map((value) => ({
      tableKey: "comparisons" as const,
      value,
    })),
  ];
  return rows as unknown as readonly {
    readonly tableKey: LarkProjectionTableKey;
    readonly value: Record<string, unknown>;
  }[];
}

function withMaterializedReportUrls(
  snapshot: FeishuProjectionSnapshot,
  reportUrls: ReadonlyMap<string, string>,
): FeishuProjectionSnapshot {
  const materializedReports = snapshot.reports.map((report) => {
    const url = reportUrls.get(report.reportId);
    if (url === undefined) {
      throw new Error(
        `Lark report URL is missing: ${report.reportId}`,
      );
    }
    assertHttps(url, "Lark report");
    return { ...report, url };
  });
  if (reportUrls.size !== materializedReports.length) {
    throw new Error("Lark report URL marker contains unrelated reports");
  }
  const oldToNewReportUrl = new Map(
    snapshot.reports.map((report) => [
      report.url,
      reportUrls.get(report.reportId)!,
    ]),
  );
  const materializedRuns = snapshot.runRecordTable.map(
    (run): RunRecord => ({
      ...run,
      reportUrl:
        run.reportUrl === null
          ? null
          : (oldToNewReportUrl.get(run.reportUrl) ?? run.reportUrl),
      auxiliaryReportUrls:
        run.auxiliaryReportUrls === null
          ? null
          : run.auxiliaryReportUrls.map(
              (url) => oldToNewReportUrl.get(url) ?? url,
            ),
    }),
  );
  return {
    ...snapshot,
    runRecordTable: materializedRuns,
    reports: materializedReports,
  };
}

function withMaterializedPageEvidenceUrls(
  snapshot: FeishuProjectionSnapshot,
  pageEvidenceUrls: ReadonlyMap<string, string>,
  placeholderFor: (artifactId: string, pageNumber: number) => string,
): FeishuProjectionSnapshot {
  const replacements = [...pageEvidenceUrls].flatMap(([key, url]) => {
    const separator = key.lastIndexOf(":");
    const artifactId = key.slice(0, separator);
    const pageNumber = Number(key.slice(separator + 1));
    if (
      artifactId.length === 0 ||
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1
    ) {
      throw new Error("Lark page evidence marker identity is invalid");
    }
    assertHttps(url, "Lark page evidence record");
    return [
      [placeholderFor(artifactId, pageNumber), url] as const,
      [
        `mock-feishu://artifacts/${encodeURIComponent(
          artifactId,
        )}/pages/${pageNumber}`,
        url,
      ] as const,
    ];
  });
  const replace = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (typeof value === "string") {
      return replacements.reduce(
        (current, [placeholder, url]) =>
          current.split(placeholder).join(url),
        value,
      );
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          key === "environmentOrigin" ? entry : replace(entry),
        ]),
      );
    }
    return value;
  };
  return replace(snapshot) as FeishuProjectionSnapshot;
}

function assertNoMockFeishuUris(
  snapshot: FeishuProjectionSnapshot,
): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string" && value.includes("mock-feishu:")) {
      throw new Error(
        `Lark materialization left a mock-feishu URI at ${path}`,
      );
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Uint8Array)
    ) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, `${path}.${key}`);
      }
    }
  };
  visit(snapshot, "snapshot");
}

function pageEvidenceKey(
  artifactId: string,
  pageNumber: number,
): string {
  return `${artifactId}:${pageNumber}`;
}

function expectedPageEvidenceIdentities(
  snapshot: FeishuProjectionSnapshot,
): readonly {
  readonly artifactId: string;
  readonly pageNumber: number;
}[] {
  return snapshot.capturedArtifactTable.flatMap((capture) =>
    capture.renderManifest.slides.map((slide) => ({
      artifactId: capture.artifactId,
      pageNumber: slide.pageNumber,
    })),
  );
}

interface ExpectedLarkAttachment {
  readonly stableId: string;
  readonly role: string;
  readonly content: Uint8Array;
  readonly contentHash: `sha256:${string}`;
}

function expectedLarkAttachments(
  snapshot: FeishuProjectionSnapshot,
): readonly ExpectedLarkAttachment[] {
  return snapshot.capturedArtifactTable.flatMap((capture) => [
    {
      stableId: `artifact:${capture.recordId}`,
      role: "original",
      content: Uint8Array.from(capture.artifact.content),
      contentHash: capture.artifact.contentHash,
    },
    {
      stableId: `artifact:${capture.recordId}`,
      role: "contact-sheet",
      content:
        typeof capture.renderManifest.contactSheet.content === "string"
          ? new TextEncoder().encode(
              capture.renderManifest.contactSheet.content,
            )
          : Uint8Array.from(
              capture.renderManifest.contactSheet.content,
            ),
      contentHash: capture.renderManifest.contactSheet.contentHash,
    },
    ...capture.renderManifest.slides.map((slide) => ({
      stableId: `page:${capture.artifactId}:${slide.pageNumber}`,
      role: `page-${slide.pageNumber}`,
      content:
        typeof slide.content === "string"
          ? new TextEncoder().encode(slide.content)
          : Uint8Array.from(slide.content),
      contentHash: slide.contentHash,
    })),
  ]);
}

function attachmentIdentity(
  attachment: Pick<LarkCommitMarkerAttachment, "stableId" | "role">,
): string {
  return `${attachment.stableId}\u0000${attachment.role}`;
}

function serializedRow(value: Record<string, unknown>): {
  readonly payload: string;
  readonly payloadHash: `sha256:${string}`;
} {
  const payload = JSON.stringify(sanitizedPayload(value));
  return { payload, payloadHash: sha256(payload) };
}

class LarkBaseProjection extends InMemoryFeishuProjection {
  readonly #transport: LarkBaseProjectionTransportPort;
  readonly #clock: ClockPort;
  #committedRemoteBatchHash: `sha256:${string}` | null = null;
  #materializationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly transport: LarkBaseProjectionTransportPort;
    readonly targetEnvironment: "test" | "production";
    readonly destination: EgressDestinationMetadata;
    readonly clock?: ClockPort;
  }) {
    super({
      targetEnvironment: options.targetEnvironment,
      egressDestination: options.destination,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.#transport = options.transport;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  override artifactPageEvidenceUrl(
    artifactId: string,
    pageNumber: number,
  ): string {
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      artifactId.trim().length === 0
    ) {
      throw new Error("Artifact page evidence identity is invalid");
    }
    return `${this.#transport.pageEvidenceBaseUrl}/artifacts/${encodeURIComponent(
      artifactId,
    )}/pages/${pageNumber}`;
  }

  protected override async captureRemoteBatchHash(
    _jobId: string,
  ): Promise<`sha256:${string}` | null> {
    return this.#committedRemoteBatchHash;
  }

  protected override didCommitAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
  ): void {
    this.#committedRemoteBatchHash = sha256Bytes(
      canonicalJsonBytes(snapshot),
    );
  }

  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
    authorization: ApprovedEgressAuthorization,
    baseline?: ProjectionCommitBaseline,
  ): Promise<FeishuProjectionSnapshot> {
    const jobId =
      snapshot.runRecordTable.find(
        ({ recordType }) => recordType === "bakeoff_job",
      )?.jobId;
    if (jobId === undefined) {
      throw new Error("Lark Base projection batch has no Bakeoff Job");
    }
    const previous = this.#materializationTail;
    let release = () => {};
    this.#materializationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    let releaseProjectionMutex = async () => {};
    try {
      if (this.#transport.acquireProjectionMutex !== undefined) {
        releaseProjectionMutex =
          await this.#transport.acquireProjectionMutex(jobId, {
            requireReportDocument: snapshot.reports.length > 0,
          });
      }
      const assertAuthorizationCurrent = () =>
        assertApprovedEgressAuthorizationCurrent(
          authorization,
          this.#clock,
        );
      assertAuthorizationCurrent();
      await this.#transport.preflight({
        requireReportDocument: snapshot.reports.length > 0,
      });
      assertAuthorizationCurrent();
      const batchHash = sha256Bytes(canonicalJsonBytes(snapshot));
      const expectedPageEvidence =
        expectedPageEvidenceIdentities(snapshot);
      const expectedAttachments = expectedLarkAttachments(snapshot);
      const expectedAttachmentCount = expectedAttachments.length;
      const safePageEvidenceUrls = new Map(
        expectedPageEvidence.map(({ artifactId, pageNumber }) => [
          pageEvidenceKey(artifactId, pageNumber),
          this.artifactPageEvidenceUrl(artifactId, pageNumber),
        ]),
      );
      const pageSafeSnapshot = withMaterializedPageEvidenceUrls(
        snapshot,
        safePageEvidenceUrls,
        (artifactId, pageNumber) =>
          this.artifactPageEvidenceUrl(artifactId, pageNumber),
      );
      const safeReportUrls = new Map(
        snapshot.reports.map(({ reportId }) => [
          reportId,
          `${this.#transport.pageEvidenceBaseUrl}/reports/${encodeURIComponent(reportId)}`,
        ]),
      );
      const mutationSafeSnapshot = withMaterializedReportUrls(
        pageSafeSnapshot,
        safeReportUrls,
      );
      assertNoMockFeishuUris(mutationSafeSnapshot);
      const rows = tableRows(mutationSafeSnapshot);
      const existingMarker =
        await this.#transport.readCommitMarker({ jobId });
      assertAuthorizationCurrent();
      if (
        baseline !== undefined &&
        existingMarker?.batchHash !== batchHash &&
        (existingMarker?.batchHash ?? null) !==
          baseline.remoteBatchHash
      ) {
        throw new ProjectionStaleBaselineError(
          "Lark projection commit marker advanced beyond the staging baseline",
        );
      }
      if (existingMarker !== null) {
        if (
          existingMarker.jobId !== jobId ||
          existingMarker.schemaVersion !==
            "lark-projection-commit-v2"
        ) {
          throw new Error(`Lark Base commit marker conflict for ${jobId}`);
        }
        if (existingMarker.batchHash === batchHash) {
          const expectedReportIds = snapshot.reports
            .map(({ reportId }) => reportId)
            .sort();
          const markerReportIds = existingMarker.reportUrls
            .map(({ reportId }) => reportId)
            .sort();
          const expectedPageEvidenceKeys = expectedPageEvidence
            .map(({ artifactId, pageNumber }) =>
              pageEvidenceKey(artifactId, pageNumber),
            )
            .sort();
          const markerPageEvidenceKeys = existingMarker.pageEvidenceUrls
            .map(({ artifactId, pageNumber }) =>
              pageEvidenceKey(artifactId, pageNumber),
            )
            .sort();
          const expectedAttachmentKeys = expectedAttachments
            .map(attachmentIdentity)
            .sort();
          const markerAttachmentKeys = existingMarker.attachments
            .map(attachmentIdentity)
            .sort();
          if (
            existingMarker.recordCount !==
              rows.length + expectedPageEvidence.length ||
            existingMarker.attachmentCount !==
              expectedAttachmentCount ||
            (expectedReportIds.length === 0
              ? existingMarker.reportDocumentRevision !== null
              : !Number.isSafeInteger(
                  existingMarker.reportDocumentRevision,
                )) ||
            !isDeepStrictEqual(markerReportIds, expectedReportIds) ||
            !isDeepStrictEqual(
              markerPageEvidenceKeys,
              expectedPageEvidenceKeys,
            ) ||
            !isDeepStrictEqual(
              markerAttachmentKeys,
              expectedAttachmentKeys,
            )
          ) {
            throw new Error(
              `Lark Base commit marker counts or reports conflict for ${jobId}`,
            );
          }
          const markerAttachments = new Map(
            existingMarker.attachments.map((attachment) => [
              attachmentIdentity(attachment),
              attachment,
            ]),
          );
          for (const expectedAttachment of expectedAttachments) {
            const markerAttachment = markerAttachments.get(
              attachmentIdentity(expectedAttachment),
            );
            if (
              markerAttachment === undefined ||
              markerAttachment.contentHash !==
                expectedAttachment.contentHash
            ) {
              throw new Error(
                `Lark Base replay attachment binding conflicts: ${expectedAttachment.role}`,
              );
            }
            assertAuthorizationCurrent();
            const downloaded =
              await this.#transport.downloadAttachment({
                tableKey: "artifacts",
                remoteRecordId: markerAttachment.remoteRecordId,
                stableId: markerAttachment.stableId,
                fileToken: markerAttachment.fileToken,
                attachmentRole: markerAttachment.role,
                expectedContent: expectedAttachment.content,
              });
            assertAuthorizationCurrent();
            if (
              sha256(downloaded) !== expectedAttachment.contentHash
            ) {
              throw new Error(
                `Lark Base attachment replay hash mismatch: ${expectedAttachment.role}`,
              );
            }
          }
          const markerPageEvidenceUrls = new Map(
            existingMarker.pageEvidenceUrls.map(
              ({ artifactId, pageNumber, url }) => [
                pageEvidenceKey(artifactId, pageNumber),
                url,
              ],
            ),
          );
          for (const capture of snapshot.capturedArtifactTable) {
            for (const slide of capture.renderManifest.slides) {
              const expectedUrl = markerPageEvidenceUrls.get(
                pageEvidenceKey(
                  capture.artifactId,
                  slide.pageNumber,
                ),
              );
              if (expectedUrl === undefined) {
                throw new Error(
                  "Lark Base replay is missing page evidence",
                );
              }
              assertAuthorizationCurrent();
              await this.#transport.verifyPageEvidence({
                stableId:
                  `page:${capture.artifactId}:${slide.pageNumber}`,
                jobId: capture.jobId,
                runId: capture.runId,
                sourceCaptureRecordId: capture.recordId,
                artifactId: capture.artifactId,
                pageNumber: slide.pageNumber,
                filename: slide.filename,
                mimeType: slide.mimeType,
                content:
                  typeof slide.content === "string"
                    ? new TextEncoder().encode(slide.content)
                    : slide.content,
                contentHash: slide.contentHash,
                expectedUrl,
                authorization,
              });
              assertAuthorizationCurrent();
            }
          }
          const pageMaterialized =
            withMaterializedPageEvidenceUrls(
              snapshot,
              markerPageEvidenceUrls,
              (artifactId, pageNumber) =>
                this.artifactPageEvidenceUrl(artifactId, pageNumber),
            );
          const replayReportCollection =
            reportCollectionForSnapshot(pageMaterialized);
          const replayReportCollectionHash =
            reportCollectionHash(replayReportCollection);
          if (
            existingMarker.reportCollectionHash !==
            replayReportCollectionHash
          ) {
            throw new Error(
              "Lark Base replay report collection hash conflicts with the snapshot",
            );
          }
          if (replayReportCollectionHash !== null) {
            const reportDocumentUrls = new Set(
              existingMarker.reportUrls.map(({ url }) => url),
            );
            if (reportDocumentUrls.size !== 1) {
              throw new Error(
                "Lark Base replay report collection must use one Docx",
              );
            }
            assertAuthorizationCurrent();
            await this.#transport.verifyReportCollection({
              jobId,
              reports: replayReportCollection,
              collectionHash: replayReportCollectionHash,
              expectedUrl: [...reportDocumentUrls][0]!,
              expectedRevisionId:
                existingMarker.reportDocumentRevision!,
            });
            assertAuthorizationCurrent();
          }
          const replayMaterialized = withMaterializedReportUrls(
            pageMaterialized,
            new Map(
              existingMarker.reportUrls.map(({ reportId, url }) => [
                reportId,
                url,
              ]),
            ),
          );
          assertNoMockFeishuUris(replayMaterialized);
          for (const { tableKey, value } of tableRows(
            replayMaterialized,
          )) {
            const stableId = physicalStableRecordId(tableKey, value);
            const { payload, payloadHash } = serializedRow(value);
            assertAuthorizationCurrent();
            await this.#transport.verifyRecord({
              tableKey,
              stableId,
              payload,
              payloadHash,
            });
            assertAuthorizationCurrent();
          }
          return replayMaterialized;
        }
      }

      const remoteRecords = new Map<string, string>();
      for (const { tableKey, value } of rows) {
        assertAuthorizationCurrent();
        const stableId = physicalStableRecordId(tableKey, value);
        const { payload, payloadHash } = serializedRow(value);
        const remote = await this.#transport.upsertRecord({
          tableKey,
          stableId,
          payload,
          payloadHash,
          authorization,
          idempotencyKey:
            `lark-record:${tableKey}:${stableId}:${payloadHash}`,
        });
        assertAuthorizationCurrent();
        assertHttps(remote.recordUrl, "Lark Base record");
        remoteRecords.set(`${tableKey}:${stableId}`, remote.remoteRecordId);
      }

      let attachmentCount = 0;
      const attachments: LarkCommitMarkerAttachment[] = [];
      const pageEvidenceUrls = new Map<string, string>();
      for (const capture of snapshot.capturedArtifactTable) {
        const remoteRecordId = remoteRecords.get(
          `artifacts:artifact:${capture.recordId}`,
        );
        if (remoteRecordId === undefined) {
          throw new Error(
            `Lark Base Artifact row is missing: ${capture.recordId}`,
          );
        }
        const artifactDerivatives = [
          {
            role: "original",
            filename: capture.artifact.filename,
            content: capture.artifact.content,
            contentHash: capture.artifact.contentHash,
          },
          {
            role: "contact-sheet",
            filename: capture.renderManifest.contactSheet.filename,
            content:
              typeof capture.renderManifest.contactSheet.content === "string"
                ? new TextEncoder().encode(
                    capture.renderManifest.contactSheet.content,
                  )
                : capture.renderManifest.contactSheet.content,
            contentHash: capture.renderManifest.contactSheet.contentHash,
          },
        ];
        for (const derivative of artifactDerivatives) {
          assertAuthorizationCurrent();
          const upload = await this.#transport.uploadAttachment({
            tableKey: "artifacts",
            remoteRecordId,
            stableId: `artifact:${capture.recordId}`,
            attachmentRole: derivative.role,
            filename: derivative.filename,
            content: derivative.content,
            contentHash: derivative.contentHash,
            idempotencyKey:
              `lark-attachment:${capture.recordId}:${derivative.role}:${derivative.contentHash}`,
            authorization,
          });
          assertAuthorizationCurrent();
          assertHttps(upload.attachmentUrl, "Lark Base attachment");
          if (upload.remoteHash !== derivative.contentHash) {
            throw new Error(
              `Lark Base attachment upload hash mismatch: ${derivative.role}`,
            );
          }
          assertAuthorizationCurrent();
          const downloaded =
            await this.#transport.downloadAttachment({
              tableKey: "artifacts",
              remoteRecordId,
              stableId: `artifact:${capture.recordId}`,
              fileToken: upload.fileToken,
              attachmentRole: derivative.role,
              expectedContent: derivative.content,
            });
          assertAuthorizationCurrent();
          if (sha256(downloaded) !== derivative.contentHash) {
            throw new Error(
              `Lark Base attachment download hash mismatch: ${derivative.role}`,
            );
          }
          attachments.push({
            stableId: `artifact:${capture.recordId}`,
            remoteRecordId,
            fileToken: upload.fileToken,
            role: derivative.role,
            contentHash: derivative.contentHash,
          });
          attachmentCount += 1;
        }
        for (const slide of capture.renderManifest.slides) {
          if (
            VERIFIED_LARK_TRANSPORTS.has(this.#transport) &&
            slide.mimeType !== "image/png"
          ) {
            throw new Error(
              "Production Lark page evidence requires one PNG per page",
            );
          }
          const stableId =
            `page:${capture.artifactId}:${slide.pageNumber}`;
          const logicalPageRecordId =
            `${capture.artifactId}:page:${slide.pageNumber}`;
          const content =
            typeof slide.content === "string"
              ? new TextEncoder().encode(slide.content)
              : slide.content;
          const pagePayload = canonicalPayload({
            schemaVersion: "lark-artifact-page-evidence-v1",
            recordType: "artifact_page_evidence",
            recordId: logicalPageRecordId,
            jobId: capture.jobId,
            runId: capture.runId,
            artifactId: capture.artifactId,
            pageNumber: slide.pageNumber,
            sourceCaptureRecordId: capture.recordId,
            filename: slide.filename,
            mimeType: slide.mimeType,
            contentHash: slide.contentHash,
          });
          const pagePayloadHash = sha256(pagePayload);
          assertAuthorizationCurrent();
          const pageRecord = await this.#transport.upsertRecord({
            tableKey: "artifacts",
            stableId,
            payload: pagePayload,
            payloadHash: pagePayloadHash,
            idempotencyKey:
              `lark-record:artifacts:${stableId}:${pagePayloadHash}`,
            authorization,
          });
          assertAuthorizationCurrent();
          assertHttps(pageRecord.recordUrl, "Lark page evidence record");
          const upload = await this.#transport.uploadAttachment({
            tableKey: "artifacts",
            remoteRecordId: pageRecord.remoteRecordId,
            stableId,
            attachmentRole: `page-${slide.pageNumber}`,
            filename: slide.filename,
            content,
            contentHash: slide.contentHash,
            idempotencyKey:
              `lark-attachment:${stableId}:${slide.contentHash}`,
            authorization,
          });
          assertAuthorizationCurrent();
          assertHttps(upload.attachmentUrl, "Lark page evidence attachment");
          if (upload.remoteHash !== slide.contentHash) {
            throw new Error(
              `Lark page evidence upload hash mismatch: ${stableId}`,
            );
          }
          const downloaded =
            await this.#transport.downloadAttachment({
              tableKey: "artifacts",
              remoteRecordId: pageRecord.remoteRecordId,
              stableId,
              fileToken: upload.fileToken,
              attachmentRole: `page-${slide.pageNumber}`,
              expectedContent: content,
            });
          assertAuthorizationCurrent();
          if (sha256(downloaded) !== slide.contentHash) {
            throw new Error(
              `Lark page evidence download hash mismatch: ${stableId}`,
            );
          }
          attachments.push({
            stableId,
            remoteRecordId: pageRecord.remoteRecordId,
            fileToken: upload.fileToken,
            role: `page-${slide.pageNumber}`,
            contentHash: slide.contentHash,
          });
          const shareUrl =
            await this.#transport.createRecordShareLink({
              tableKey: "artifacts",
              remoteRecordId: pageRecord.remoteRecordId,
              authorization,
            });
          assertAuthorizationCurrent();
          assertHttps(shareUrl, "Lark page evidence share link");
          pageEvidenceUrls.set(
            pageEvidenceKey(capture.artifactId, slide.pageNumber),
            shareUrl,
          );
          attachmentCount += 1;
        }
      }

      const pageMaterializedSnapshot =
        withMaterializedPageEvidenceUrls(
          mutationSafeSnapshot,
          pageEvidenceUrls,
          (artifactId, pageNumber) =>
            this.artifactPageEvidenceUrl(artifactId, pageNumber),
        );
      const reportUrls = new Map<string, string>();
      const reportCollection =
        reportCollectionForSnapshot(pageMaterializedSnapshot);
      const materializedReportCollectionHash =
        reportCollectionHash(reportCollection);
      let reportDocumentRevision: number | null = null;
      if (reportCollection.length > 0) {
        assertAuthorizationCurrent();
        const collectionHash = materializedReportCollectionHash!;
        const result = await this.#transport.upsertReportCollection({
          jobId,
          reports: reportCollection,
          collectionHash,
          idempotencyKey:
            `lark-report-collection:${jobId}:${collectionHash}`,
          authorization,
        });
        assertAuthorizationCurrent();
        assertHttps(result.url, "Lark report");
        if (
          result.remoteContentHash !==
          sha256(createLarkReportCollectionMarkdown({
            jobId,
            reports: reportCollection,
            collectionHash,
          }))
        ) {
          throw new Error("Lark report readback hash is invalid");
        }
        reportDocumentRevision = result.revisionId;
        for (const report of reportCollection) {
          reportUrls.set(report.reportId, result.url);
        }
      }

      const materializedSnapshot = withMaterializedReportUrls(
        pageMaterializedSnapshot,
        reportUrls,
      );
      assertNoMockFeishuUris(materializedSnapshot);
      const originalRows = new Map(
        rows.map(({ tableKey, value }) => [
          `${tableKey}:${physicalStableRecordId(tableKey, value)}`,
          serializedRow(value).payloadHash,
        ]),
      );
      for (const { tableKey, value } of tableRows(
        materializedSnapshot,
      )) {
        const stableId = physicalStableRecordId(tableKey, value);
        const { payload, payloadHash } = serializedRow(value);
        if (
          originalRows.get(`${tableKey}:${stableId}`) !== payloadHash
        ) {
          assertAuthorizationCurrent();
          await this.#transport.upsertRecord({
            tableKey,
            stableId,
            payload,
            payloadHash,
            idempotencyKey:
              `lark-record:${tableKey}:${stableId}:${payloadHash}`,
            authorization,
          });
          assertAuthorizationCurrent();
        }
      }

      const reportUrlEntries = [...reportUrls].map(
        ([reportId, url]) => ({ reportId, url }),
      );
      assertAuthorizationCurrent();
      await this.#transport.commitBatch({
        schemaVersion: "lark-projection-commit-v2",
        jobId,
        batchHash,
        authorizationDecisionId: authorization.decisionId,
        recordCount: rows.length + expectedPageEvidence.length,
        attachmentCount,
        reportUrls: reportUrlEntries,
        reportCollectionHash: materializedReportCollectionHash,
        reportDocumentRevision,
        pageEvidenceUrls: [...pageEvidenceUrls].map(([key, url]) => {
          const separator = key.lastIndexOf(":");
          return {
            artifactId: key.slice(0, separator),
            pageNumber: Number(key.slice(separator + 1)),
            url,
          };
        }),
        attachments,
        committedAt:
          snapshot.runRecordTable.find(
            ({ recordType }) => recordType === "bakeoff_job",
          )?.createdAt ?? authorization.request.requestedAt,
        previousBatchHash: existingMarker?.batchHash ?? null,
        revision: (existingMarker?.revision ?? 0) + 1,
        authorization,
      });
      assertAuthorizationCurrent();
      return materializedSnapshot;
    } finally {
      try {
        await releaseProjectionMutex();
      } finally {
        release();
      }
    }
  }
}

function larkDestination(
  targetEnvironment: "test" | "production",
  targetAccount: string,
  targetRegion: string,
): EgressDestinationMetadata {
  return Object.freeze({
    targetService: "lark-base-operational-ledger",
    targetAccount,
    targetRegion,
    subprocessors: [],
  });
}

export function createLarkBaseProjectionForTest(options: {
  readonly transport: LarkBaseProjectionTransportPort;
  readonly targetEnvironment?: "test" | "production";
  readonly clock?: ClockPort;
}): InMemoryFeishuProjection {
  return new LarkBaseProjection({
    transport: options.transport,
    targetEnvironment: options.targetEnvironment ?? "test",
    destination: larkDestination(
      options.targetEnvironment ?? "test",
      "test-lark-account",
      "test",
    ),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export function createHarnessOwnedLarkBaseProjection(options: {
  readonly transport: LarkBaseProjectionTransportPort;
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly clock?: ClockPort;
}): InMemoryFeishuProjection {
  if (!VERIFIED_LARK_TRANSPORTS.has(options.transport)) {
    throw new Error(
      "Production Lark Base projection requires the verified fixed lark-cli transport",
    );
  }
  const verifiedDestination =
    VERIFIED_LARK_DESTINATIONS.get(options.transport);
  if (
    verifiedDestination === undefined ||
    options.targetAccount !== verifiedDestination.targetAccount ||
    options.targetRegion !== verifiedDestination.targetRegion
  ) {
    throw new Error(
      "Production Lark projection destination does not match the verified transport account and region",
    );
  }
  const projection = new LarkBaseProjection({
    transport: options.transport,
    targetEnvironment: "production",
    destination: larkDestination(
      "production",
      options.targetAccount,
      options.targetRegion,
    ),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  HARNESS_OWNED_LARK_PROJECTIONS.set(projection, options.transport);
  return projection;
}

export function assertHarnessOwnedLarkBaseProjection(
  projection: object,
): void {
  if (!HARNESS_OWNED_LARK_PROJECTIONS.has(projection)) {
    throw new Error(
      "Production Bakeoff requires a harness-owned verified Lark/Feishu Base projection",
    );
  }
}

export async function preflightHarnessOwnedLarkBaseProjection(
  projection: object,
  options: {
    readonly requireReportDocument?: boolean;
  } = {},
): Promise<void> {
  const transport = HARNESS_OWNED_LARK_PROJECTIONS.get(projection);
  if (transport === undefined) {
    throw new Error(
      "Production Lark/Feishu projection preflight rejected an unregistered projection",
    );
  }
  await transport.preflight(options);
}

export async function readHarnessOwnedLarkProductionJobState(
  projection: object,
  command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
  },
): Promise<ProductionJobRemoteState> {
  const transport = HARNESS_OWNED_LARK_PROJECTIONS.get(projection);
  if (transport === undefined) {
    throw new Error(
      "Production Job recovery gate rejected an unregistered Lark projection",
    );
  }
  if (transport.readProductionJobState === undefined) {
    throw new Error(
      "Production Job recovery gate requires remote stable-ID recovery",
    );
  }
  return await transport.readProductionJobState(command);
}

export async function claimHarnessOwnedLarkProductionJob(
  projection: object,
  command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly authorization: ApprovedEgressAuthorization;
    readonly clock?: ClockPort;
  },
): Promise<"claimed" | "already_claimed"> {
  const transport = HARNESS_OWNED_LARK_PROJECTIONS.get(projection);
  if (transport === undefined || transport.claimProductionJob === undefined) {
    throw new Error(
      "Production Job claim gate requires a verified remote claim transport",
    );
  }
  const clock = command.clock ?? SYSTEM_CLOCK;
  assertApprovedEgressAuthorizationCurrent(command.authorization, clock);
  const result = await transport.claimProductionJob({
    jobId: command.jobId,
    runIds: command.runIds,
    claimHash: command.claimHash,
    claimantId: command.authorization.request.sourceOwner,
    claimAttemptId:
      command.authorization.request.attemptId ??
      command.authorization.request.requestId,
    authorization: command.authorization,
    claimedAt: command.authorization.request.requestedAt,
  });
  assertApprovedEgressAuthorizationCurrent(command.authorization, clock);
  return result;
}

export async function abortHarnessOwnedLarkProductionJobBeforeSubmission(
  projection: object,
  command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly authorization: ApprovedEgressAuthorization;
    readonly notSubmittedAttemptIds: readonly string[];
    readonly abortedAt: string;
    readonly clock?: ClockPort;
  },
): Promise<void> {
  const transport = HARNESS_OWNED_LARK_PROJECTIONS.get(projection);
  if (
    transport === undefined ||
    transport.abortProductionJobClaimBeforeSubmission === undefined
  ) {
    throw new Error(
      "Production Job pre-submission abort requires a verified remote claim transport",
    );
  }
  const clock = command.clock ?? SYSTEM_CLOCK;
  assertApprovedEgressAuthorizationCurrent(command.authorization, clock);
  await transport.abortProductionJobClaimBeforeSubmission({
    jobId: command.jobId,
    runIds: command.runIds,
    claimHash: command.claimHash,
    claimantId: command.authorization.request.sourceOwner,
    claimAttemptId:
      command.authorization.request.attemptId ??
      command.authorization.request.requestId,
    authorization: command.authorization,
    notSubmittedAttemptIds: command.notSubmittedAttemptIds,
    abortedAt: command.abortedAt,
  });
  assertApprovedEgressAuthorizationCurrent(command.authorization, clock);
}

export function isHarnessOwnedLarkBaseProjection(
  projection: object,
): boolean {
  return HARNESS_OWNED_LARK_PROJECTIONS.has(projection);
}

const OPERATIONAL_LEDGER_CONTENT_FIELDS = Object.freeze([
  "case_table",
  "run_record_table",
  "captured_artifact_table",
  "artifact_score_table",
  "adjudication_event_table",
  "review_event_table",
  "gap_card_workflow_event_table",
  "github_issue_delivery_reservation_table",
  "github_issue_link_event_table",
  "comparison_and_product_gap_card_table",
  "reports",
]);

export async function persistHarnessOwnedLarkProjectionSnapshot(options: {
  readonly projection: FeishuProjectionPort;
  readonly stagedSnapshot: FeishuProjectionSnapshot;
  readonly baseline: ProjectionCommitBaseline;
  readonly jobId: string;
  readonly egressAuthorization: EgressAuthorizationPort;
  readonly egressAudit: EgressAuthorizationAuditPort;
  readonly clock?: ClockPort;
}): Promise<FeishuProjectionSnapshot> {
  if (!HARNESS_OWNED_LARK_PROJECTIONS.has(options.projection)) {
    throw new Error(
      "Incremental comparison persistence requires a harness-owned Lark projection",
    );
  }
  const snapshot = options.stagedSnapshot;
  const job = snapshot.runRecordTable.find(
    (record) =>
      record.recordType === "bakeoff_job" &&
      record.jobId === options.jobId,
  );
  const evaluationCase = snapshot.caseTable.find(
    ({ caseId }) => caseId === job?.caseId,
  );
  if (job === undefined || evaluationCase === undefined) {
    throw new Error(
      "Incremental comparison persistence has no complete Job lineage",
    );
  }
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const clock = options.clock ?? SYSTEM_CLOCK;
  const authorization = await requireEgressAuthorization(
    options.egressAuthorization,
    {
      requestId:
        `operational-ledger-projection:${options.jobId}:${payloadHash}`,
      jobId: options.jobId,
      runId: null,
      attemptId: null,
      dataClassification: evaluationCase.dataClassification,
      sourceOwner: evaluationCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: options.projection.egressDestination.targetService,
      targetAccount: options.projection.egressDestination.targetAccount,
      targetRegion: options.projection.egressDestination.targetRegion,
      subprocessors:
        options.projection.egressDestination.subprocessors,
      contentFields: OPERATIONAL_LEDGER_CONTENT_FIELDS,
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );
  await options.egressAudit.append(authorization);
  await options.projection.commitAuthorizedSnapshot(
    snapshot,
    authorization,
    options.baseline,
  );
  return options.projection.snapshot();
}

function collectRecords(value: unknown): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object") return;
    if (!Array.isArray(candidate)) {
      records.push(candidate as Record<string, unknown>);
      for (const entry of Object.values(candidate)) visit(entry);
      return;
    }
    for (const entry of candidate) visit(entry);
  };
  visit(value);
  return records;
}

interface LarkCliRunOptions {
  readonly cwd?: string;
  readonly stdin?: string | Uint8Array;
}

type LarkCliJsonRunner = (
  args: readonly string[],
  options?: LarkCliRunOptions,
) => Promise<unknown>;

type LarkCliExecutableAttestor = () => Promise<void>;

interface LarkCliInvocationOptions extends LarkCliRunOptions {
  readonly inputSnapshot?: {
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentHash: `sha256:${string}`;
  };
}

async function invokeLarkCliRunner(
  runner: LarkCliJsonRunner,
  args: readonly string[],
  options: LarkCliInvocationOptions = {},
): Promise<unknown> {
  const snapshot = options.inputSnapshot;
  if (snapshot === undefined) {
    return await runner(args, options);
  }
  if (
    options.cwd !== undefined ||
    !/^[a-zA-Z0-9._-]{1,255}$/.test(snapshot.filename) ||
    sha256(snapshot.content) !== snapshot.contentHash ||
    !args.includes(snapshot.filename)
  ) {
    throw new Error("Lark CLI input snapshot is invalid");
  }
  const directory = mkdtempSync(join(tmpdir(), "ppt-lark-input-"));
  try {
    writeFileSync(join(directory, snapshot.filename), snapshot.content, {
      flag: "wx",
      mode: 0o400,
    });
    // Snapshot materialization and runner invocation are deliberately
    // synchronous. No authorization callback or event-loop continuation can
    // replace the authorized bytes before the frozen runner is spawned.
    const pending = runner(args, {
      cwd: directory,
      ...(options.stdin === undefined
        ? {}
        : { stdin: options.stdin }),
    });
    return await pending;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function spawnFrozenLarkCliJson(
  binaryPath: string,
  args: readonly string[],
  options: LarkCliRunOptions = {},
): Promise<unknown> {
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(binaryPath, [...args], {
      stdio: [
        options.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    if (options.stdin !== undefined) {
      if (child.stdin === null) {
        child.kill();
        rejectOutput(
          new Error("lark-cli stdin pipe was not created"),
        );
        return;
      }
      child.stdin.end(options.stdin);
    }
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      rejectOutput(
        new Error("lark-cli output pipes were not created"),
      );
      return;
    }
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", rejectOutput);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectOutput(
          new Error(
            `lark-cli fixed command failed with code ${code}; stderr withheld to avoid credential-bearing diagnostics`,
          ),
        );
        return;
      }
      resolveOutput(stdout);
    });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error("lark-cli returned non-JSON output");
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "ok" in parsed &&
    (parsed as { readonly ok?: unknown }).ok !== true
  ) {
    throw new Error("lark-cli returned a non-success JSON envelope");
  }
  return parsed;
}

async function frozenLarkCliVersion(binaryPath: string): Promise<string> {
  return await new Promise<string>((resolveVersion, rejectVersion) => {
    const child = spawn(binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", rejectVersion);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectVersion(
          new Error(`Frozen lark-cli version probe failed with code ${code}`),
        );
        return;
      }
      resolveVersion(stdout.trim());
    });
  });
}

async function attestFrozenLarkCliExecutable(
  binaryPath: string,
): Promise<void> {
  const [resolvedPath, metadata, bytes] = await Promise.all([
    realpath(binaryPath),
    lstat(binaryPath),
    readFile(binaryPath),
  ]);
  if (
    resolvedPath !== binaryPath ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    sha256(Uint8Array.from(bytes)) !== FROZEN_LARK_CLI_SHA256
  ) {
    throw new Error(
      "Frozen lark-cli executable path or bytes drifted before egress",
    );
  }
}

export function assertFrozenLarkCliInstallation(input: {
  readonly nativeHash: `sha256:${string}`;
  readonly nativeVersionOutput: string;
  readonly wrapperIsSymbolicLink: boolean;
  readonly wrapperTarget: string;
  readonly wrapperScriptHash: `sha256:${string}`;
}): void {
  if (
    input.nativeHash !== FROZEN_LARK_CLI_SHA256 ||
    input.nativeVersionOutput !==
      `lark-cli version ${FROZEN_LARK_CLI_VERSION}`
  ) {
    throw new Error(
      "Frozen native lark-cli executable or version does not match the reviewed installation",
    );
  }
  if (
    input.wrapperIsSymbolicLink !== true ||
    input.wrapperTarget !== FROZEN_LARK_CLI_WRAPPER_TARGET ||
    input.wrapperScriptHash !== FROZEN_LARK_CLI_SCRIPT_SHA256
  ) {
    throw new Error(
      "lark-cli wrapper does not match the reviewed native installation; wrapper execution is prohibited",
    );
  }
}

class VerifiedLarkCliTransport
  implements LarkBaseProjectionTransportPort
{
  readonly transportId: string;
  readonly pageEvidenceBaseUrl: string;
  readonly #configuration: LarkCliProjectionConfiguration;
  readonly #binaryPath: string;
  readonly #egressAuthorization: EgressAuthorizationPort;
  readonly #egressAudit: EgressAuthorizationAuditPort;
  readonly #clock: ClockPort;
  readonly #runner: LarkCliJsonRunner;
  readonly #executionLease: LarkExecutionLeasePort;
  readonly #attestExecutable: LarkCliExecutableAttestor;
  #executionLeaseReleased = false;
  #disposed = false;

  constructor(
    binaryPath: string,
    configuration: LarkCliProjectionConfiguration,
    egressAuthorization: EgressAuthorizationPort,
    egressAudit: EgressAuthorizationAuditPort,
    clock: ClockPort = SYSTEM_CLOCK,
    runner?: LarkCliJsonRunner,
    executionLease?: LarkExecutionLeasePort,
    attestExecutable: LarkCliExecutableAttestor = async () => undefined,
  ) {
    this.#binaryPath = binaryPath;
    this.#egressAuthorization = egressAuthorization;
    this.#egressAudit = egressAudit;
    this.#clock = clock;
    this.#runner =
      runner ??
      ((args, options) =>
        spawnFrozenLarkCliJson(this.#binaryPath, args, options));
    this.#executionLease =
      executionLease ??
      createProcessLarkExecutionLease({
        lockRoot: configuration.lockRootPath,
      });
    this.#attestExecutable = attestExecutable;
    this.#configuration = Object.freeze({
      ...configuration,
      tables: Object.freeze({ ...configuration.tables }),
      ...(configuration.cliIdentityBinding === undefined
        ? {}
        : {
            cliIdentityBinding: Object.freeze({
              ...configuration.cliIdentityBinding,
            }),
          }),
    });
    this.transportId =
      `lark-cli:${FROZEN_LARK_CLI_SHA256}:${configuration.targetAccount}`;
    this.pageEvidenceBaseUrl = configuration.pageEvidenceBaseUrl.replace(
      /\/+$/,
      "",
    );
  }

  async #run(
    args: readonly string[],
    options: LarkCliInvocationOptions = {},
  ): Promise<unknown> {
    this.#assertActive();
    await this.#attestExecutable();
    this.#assertActive();
    return await invokeLarkCliRunner(this.#runner, args, options);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Lark transport is disposed");
    }
  }

  async #releaseExecutionLease(): Promise<void> {
    if (this.#executionLeaseReleased) return;
    this.#executionLeaseReleased = true;
    await this.#executionLease.release();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#releaseExecutionLease();
  }

  async #withMutex<T>(
    kind: "projection" | "stable-record" | "claim",
    identity: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    const release = await acquireLarkSingleWorkstationMutex(
      this.#configuration,
      larkOperationMutexScope(kind, identity),
      {
        includeReportDocument: kind === "claim",
      },
    );
    try {
      this.#assertActive();
      return await operation();
    } finally {
      await release();
    }
  }

  async withProjectionMutex<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    nonEmpty(jobId, "Lark projection mutex Job ID");
    const release = await this.acquireProjectionMutex(jobId);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async acquireProjectionMutex(
    jobId: string,
    options: {
      readonly requireReportDocument?: boolean;
    } = {},
  ): Promise<() => Promise<void>> {
    this.#assertActive();
    nonEmpty(jobId, "Lark projection mutex Job ID");
    const release = await acquireLarkSingleWorkstationMutex(
      this.#configuration,
      larkOperationMutexScope("projection", jobId),
      {
        includeReportDocument:
          options.requireReportDocument === true,
      },
    );
    try {
      this.#assertActive();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  async #runMutation(
    operation: string,
    payloadHash: `sha256:${string}`,
    parentAuthorization: ApprovedEgressAuthorization,
    args: readonly string[],
    options: LarkCliInvocationOptions = {},
  ): Promise<unknown> {
    this.#assertActive();
    assertApprovedEgressAuthorizationCurrent(
      parentAuthorization,
      this.#clock,
    );
    const authorization = await requireEgressAuthorization(
      this.#egressAuthorization,
      {
        requestId:
          `lark-mutation:${operation}:${parentAuthorization.request.jobId}:${payloadHash}`,
        jobId: parentAuthorization.request.jobId,
        runId: parentAuthorization.request.runId,
        attemptId: parentAuthorization.request.attemptId,
        dataClassification:
          parentAuthorization.request.dataClassification,
        sourceOwner: parentAuthorization.request.sourceOwner,
        processingPurpose: "operational_ledger_projection_storage",
        targetKind: "storage",
        targetService: "lark-base-operational-ledger",
        targetAccount: this.#configuration.targetAccount,
        targetRegion: this.#configuration.targetRegion,
        subprocessors: [],
        contentFields: [`lark_mutation:${operation}`],
        payloadHash,
        requiredRedactions: [],
      },
      this.#clock,
    );
    await this.#egressAudit.append(authorization);
    await this.#egressAudit.assertRecorded(authorization);
    await this.#attestExecutable();
    assertApprovedEgressAuthorizationCurrent(authorization, this.#clock);
    this.#assertActive();
    // The runner is invoked synchronously after the final currentness check.
    // The production runner synchronously spawns the frozen native binary.
    const pending = invokeLarkCliRunner(
      this.#runner,
      args,
      options,
    );
    return await pending;
  }

  #baseToken(): string {
    const value =
      process.env[this.#configuration.baseTokenEnvironmentVariable];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(
        `Lark Base credential ${this.#configuration.baseTokenEnvironmentVariable} is unavailable`,
      );
    }
    return value;
  }

  #reportDocumentToken(): string {
    return larkReportDocumentToken(this.#configuration);
  }

  async #fetchReportDocument(): Promise<LarkDocumentReadback> {
    const reportToken = this.#reportDocumentToken();
    const fetched = await this.#run([
      "docs",
      "+fetch",
      "--doc",
      reportToken,
      "--doc-format",
      "markdown",
      "--detail",
      "full",
      "--format",
      "json",
      "--as",
      "user",
    ]);
    return parseLarkDocumentReadback(
      fetched,
      reportToken,
      this.#configuration.reportDocumentExpectedOrigin,
    );
  }

  async #overwriteReportDocument(command: {
    readonly operation: string;
    readonly content: string;
    readonly expectedRevisionId: number;
    readonly authorization: ApprovedEgressAuthorization;
    readonly mutationContext: Record<string, unknown>;
  }): Promise<LarkDocumentReadback> {
    const reportToken = this.#reportDocumentToken();
    const mutationHash = sha256(
      canonicalPayload({
        operation: command.operation,
        reportToken,
        expectedRevisionId: command.expectedRevisionId,
        contentHash: sha256(command.content),
        ...command.mutationContext,
      }),
    );
    const update = await this.#runMutation(
      command.operation,
      mutationHash,
      command.authorization,
      [
        "docs",
        "+update",
        "--doc",
        reportToken,
        "--command",
        "overwrite",
        "--revision-id",
        String(command.expectedRevisionId),
        "--doc-format",
        "markdown",
        "--content",
        "-",
        "--format",
        "json",
        "--as",
        "user",
      ],
      { stdin: command.content },
    );
    const updateRevision = parseLarkDocumentUpdateRevision(
      update,
      reportToken,
      this.#configuration.reportDocumentExpectedOrigin,
    );
    if (updateRevision <= command.expectedRevisionId) {
      throw new Error(
        "Lark report update did not advance the expected revision",
      );
    }
    const readback = await this.#fetchReportDocument();
    if (
      readback.revisionId !== updateRevision ||
      normalizeMarkdown(readback.content) !==
        normalizeMarkdown(command.content)
    ) {
      throw new Error(
        "Lark report readback content or revision is not bound to the projected report",
      );
    }
    return readback;
  }

  async preflight(
    options: {
      readonly requireReportDocument?: boolean;
    } = {},
  ): Promise<void> {
    this.#assertActive();
    const releaseConcurrencyProbe =
      await acquireLarkSingleWorkstationMutex(
        this.#configuration,
        larkOperationMutexScope("preflight", "transport"),
        {
          includeReportDocument:
            options.requireReportDocument === true,
        },
      );
    await releaseConcurrencyProbe();
    const baseToken = this.#baseToken();
    assertHttps(this.pageEvidenceBaseUrl, "Lark page evidence base");
    assertHttpsBase(
      this.#configuration.baseWebUrl,
      "Lark Base web URL",
    );
    assertHttpsBase(
      this.#configuration.reportDocumentExpectedOrigin,
      "Lark report document expected origin",
    );
    const baseWebUrl = new URL(this.#configuration.baseWebUrl);
    if (
      decodeURIComponent(
        baseWebUrl.pathname.split("/").filter(Boolean).at(-1) ?? "",
      ) !== baseToken
    ) {
      throw new Error(
        "Lark Base web URL is not bound to the configured Base token",
      );
    }
    const identity = await this.#run(["whoami"]);
    const identityRecord =
      identity !== null && typeof identity === "object"
        ? (identity as Record<string, unknown>)
        : {};
    const identityBinding = this.#configuration.cliIdentityBinding;
    const onBehalfOf =
      identityRecord.onBehalfOf !== null &&
      typeof identityRecord.onBehalfOf === "object"
        ? (identityRecord.onBehalfOf as Record<string, unknown>)
        : {};
    const expectedRegion =
      identityBinding?.brand === "feishu"
        ? "cn"
        : identityBinding?.brand === "lark"
          ? "global"
          : null;
    if (
      identityRecord.available !== true ||
      identityRecord.identity !== "user" ||
      identityBinding === undefined ||
      identityRecord.profile !== identityBinding.profile ||
      identityRecord.appId !== identityBinding.appId ||
      identityRecord.brand !== identityBinding.brand ||
      identityRecord.defaultAs !== identityBinding.defaultAs ||
      identityRecord.identitySource !==
        identityBinding.identitySource ||
      onBehalfOf.openId !== identityBinding.userOpenId ||
      this.#configuration.targetAccount !==
        identityBinding.userOpenId ||
      this.#configuration.targetRegion !== expectedRegion
    ) {
      throw new Error(
        "lark-cli production preflight identity binding does not match the configured user profile, app, account, or region",
      );
    }
    const currentUserEnvelope = await this.#run([
      "contact",
      "+get-user",
      "--format",
      "json",
      "--as",
      "user",
    ]);
    const currentUser = collectRecords(currentUserEnvelope).find(
      (record) =>
        typeof record.open_id === "string" &&
        typeof record.tenant_key === "string",
    );
    if (
      currentUser?.open_id !== identityBinding.userOpenId ||
      currentUser.tenant_key !== identityBinding.tenantKey
    ) {
      throw new Error(
        "lark-cli production preflight user and tenant do not match the configured identity binding",
      );
    }

    const requirements = new Map<string, Set<string>>();
    for (const [tableKey, tableId] of Object.entries(
      this.#configuration.tables,
    ) as [LarkProjectionTableKey, string][]) {
      const fields =
        requirements.get(tableId) ?? new Set<string>();
      fields.add(this.#configuration.stableIdField);
      fields.add(this.#configuration.payloadField);
      fields.add(this.#configuration.payloadHashField);
      if (tableKey === "artifacts") {
        fields.add(this.#configuration.artifactAttachmentField);
      }
      requirements.set(tableId, fields);
    }
    for (const [tableId, requiredFields] of requirements) {
      const response = await this.#run([
        "base",
        "+field-list",
        "--base-token",
        this.#baseToken(),
        "--table-id",
        tableId,
        "--limit",
        "200",
        "--format",
        "json",
        "--as",
        "user",
      ]);
      const availableFields = new Set(
        collectRecords(response).flatMap((record) =>
          [
            record.field_id,
            record.fieldId,
            record.field_name,
            record.fieldName,
            record.name,
          ].filter((value): value is string => typeof value === "string"),
        ),
      );
      for (const requiredField of requiredFields) {
        if (!availableFields.has(requiredField)) {
          throw new Error(
            `Lark Base preflight is missing required field ${requiredField} in ${tableId}`,
          );
        }
      }
    }

    if (options.requireReportDocument === true) {
      await this.#fetchReportDocument();
    }
  }

  async #findRecords(
    tableKey: LarkProjectionTableKey,
    stableId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const response = await this.#run([
      "base",
      "+record-search",
      "--base-token",
      this.#baseToken(),
      "--table-id",
      this.#configuration.tables[tableKey],
      "--keyword",
      stableId,
      "--search-field",
      this.#configuration.stableIdField,
      "--field-id",
      this.#configuration.stableIdField,
      "--field-id",
      this.#configuration.payloadField,
      "--field-id",
      this.#configuration.payloadHashField,
      ...(tableKey === "artifacts"
        ? [
            "--field-id",
            this.#configuration.artifactAttachmentField,
          ]
        : []),
      "--limit",
      "200",
      "--format",
      "json",
      "--as",
      "user",
    ]);
    const matches = parseLarkRecordSearchEnvelope(response).filter((record) => {
      const fields =
        record.fields !== null && typeof record.fields === "object"
          ? (record.fields as Record<string, unknown>)
          : record;
      return fields[this.#configuration.stableIdField] === stableId;
    });
    return matches;
  }

  async #findRecord(
    tableKey: LarkProjectionTableKey,
    stableId: string,
  ): Promise<Record<string, unknown> | null> {
    const matches = await this.#findRecords(tableKey, stableId);
    if (matches.length > 1) {
      throw new Error(
        `Lark Base stable identity has duplicate records: ${stableId}`,
      );
    }
    return matches[0] ?? null;
  }

  async #convergeStableIdentity(command: {
    readonly tableKey: LarkProjectionTableKey;
    readonly stableId: string;
    readonly authorization: ApprovedEgressAuthorization;
  }): Promise<Record<string, unknown> | null> {
    const matches = await this.#findRecords(
      command.tableKey,
      command.stableId,
    );
    if (matches.length <= 1) return matches[0] ?? null;
    throw new Error(
      `Lark Base stable identity has pre-existing duplicate records and requires non-destructive manual reconciliation: ${command.stableId}`,
    );
  }

  async #verifiedRecordId(command: {
    readonly tableKey: LarkProjectionTableKey;
    readonly stableId: string;
    readonly payload: string;
    readonly payloadHash: `sha256:${string}`;
    readonly expectedRecordId?: string;
  }): Promise<string> {
    if (sha256(command.payload) !== command.payloadHash) {
      throw new Error(
        `Lark Base payload hash is invalid: ${command.stableId}`,
      );
    }
    const record = await this.#findRecord(
      command.tableKey,
      command.stableId,
    );
    const remoteRecordId =
      typeof record?.record_id === "string" ? record.record_id : null;
    const fields =
      record?.fields !== null && typeof record?.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    if (
      remoteRecordId === null ||
      (command.expectedRecordId !== undefined &&
        remoteRecordId !== command.expectedRecordId) ||
      fields?.[this.#configuration.stableIdField] !== command.stableId ||
      fields?.[this.#configuration.payloadField] !== command.payload ||
      fields?.[this.#configuration.payloadHashField] !==
        command.payloadHash
    ) {
      throw new Error(
        `Lark Base record readback is missing or conflicting: ${command.stableId}`,
      );
    }
    return remoteRecordId;
  }

  async verifyRecord(
    command: Parameters<LarkBaseProjectionTransportPort["verifyRecord"]>[0],
  ): Promise<void> {
    this.#assertActive();
    await this.#verifiedRecordId(command);
  }

  async upsertRecord(
    command: Parameters<LarkBaseProjectionTransportPort["upsertRecord"]>[0],
  ): Promise<{
    readonly remoteRecordId: string;
    readonly recordUrl: string;
  }> {
    this.#assertActive();
    return await this.#withMutex(
      "stable-record",
      canonicalPayload({
        tableId: this.#configuration.tables[command.tableKey],
        stableId: command.stableId,
      }),
      async () => await this.#upsertRecordWithoutMutex(command),
    );
  }

  async #upsertRecordWithoutMutex(
    command: Parameters<LarkBaseProjectionTransportPort["upsertRecord"]>[0],
  ): Promise<{
    readonly remoteRecordId: string;
    readonly recordUrl: string;
  }> {
    const existing = await this.#convergeStableIdentity(command);
    const recordId =
      typeof existing?.record_id === "string"
        ? existing.record_id
        : typeof existing?.recordId === "string"
          ? existing.recordId
          : null;
    const fields = JSON.stringify({
      [this.#configuration.stableIdField]: command.stableId,
      [this.#configuration.payloadField]: command.payload,
      [this.#configuration.payloadHashField]: command.payloadHash,
    });
    const mutationHash = sha256(canonicalPayload({
      operation: "record-upsert",
      tableId: this.#configuration.tables[command.tableKey],
      stableId: command.stableId,
      payloadHash: command.payloadHash,
      fields,
    }));
    assertApprovedEgressAuthorizationCurrent(
      command.authorization,
      this.#clock,
    );
    let mutationRecordId: string;
    try {
      const response = await this.#runMutation(
        "record-upsert",
        mutationHash,
        command.authorization,
        [
          "base",
          "+record-upsert",
          "--base-token",
          this.#baseToken(),
          "--table-id",
          this.#configuration.tables[command.tableKey],
          ...(recordId === null ? [] : ["--record-id", recordId]),
          "--json",
          fields,
          "--format",
          "json",
          "--as",
          "user",
        ],
      );
      mutationRecordId = parseLarkRecordUpsertEnvelope(
        response,
        recordId,
      );
    } catch (error) {
      const recovered = await this.#convergeStableIdentity(command);
      const recoveredId =
        typeof recovered?.record_id === "string"
          ? recovered.record_id
          : null;
      const recoveredFields =
        recovered?.fields !== null &&
        typeof recovered?.fields === "object"
          ? (recovered.fields as Record<string, unknown>)
          : recovered;
      if (
        recoveredId === null ||
        (recordId !== null && recoveredId !== recordId) ||
        recoveredFields?.[this.#configuration.stableIdField] !==
          command.stableId ||
        recoveredFields?.[this.#configuration.payloadField] !==
          command.payload ||
        recoveredFields?.[this.#configuration.payloadHashField] !==
          command.payloadHash
      ) {
        throw error;
      }
      mutationRecordId = recoveredId;
    }
    await this.#convergeStableIdentity(command);
    const remoteRecordId = await this.#verifiedRecordId({
      tableKey: command.tableKey,
      stableId: command.stableId,
      payload: command.payload,
      payloadHash: command.payloadHash,
      ...(recordId === null ? {} : { expectedRecordId: mutationRecordId }),
    });
    return {
      remoteRecordId,
      recordUrl:
        `${this.#configuration.baseWebUrl.replace(/\/+$/, "")}?table=${encodeURIComponent(
          this.#configuration.tables[command.tableKey],
        )}&record=${encodeURIComponent(remoteRecordId)}`,
    };
  }

  async uploadAttachment(
    command: Parameters<LarkBaseProjectionTransportPort["uploadAttachment"]>[0],
  ): Promise<{
    readonly fileToken: string;
    readonly remoteHash: `sha256:${string}`;
    readonly attachmentUrl: string;
  }> {
    this.#assertActive();
    const contentSnapshot = Uint8Array.from(command.content);
    if (sha256(contentSnapshot) !== command.contentHash) {
      throw new Error("Lark Base attachment input hash mismatch");
    }
    const safeOriginalName =
      command.filename.replace(/[^a-z0-9._-]/gi, "_");
    const filename =
      `${command.attachmentRole.replace(/[^a-z0-9._-]/gi, "_")}-` +
      `${command.contentHash.slice("sha256:".length, "sha256:".length + 16)}-` +
      safeOriginalName;
    const existing = await this.#findRecord(
      "artifacts",
      command.stableId,
    );
    const existingFields =
      existing?.fields !== null &&
      typeof existing?.fields === "object"
        ? (existing.fields as Record<string, unknown>)
        : existing;
    const existingAttachment = collectRecords(
      existingFields?.[this.#configuration.artifactAttachmentField],
    ).find((record) => {
      const name =
        typeof record.name === "string"
          ? record.name
          : typeof record.file_name === "string"
            ? record.file_name
            : typeof record.fileName === "string"
              ? record.fileName
              : null;
      const token = record.file_token ?? record.fileToken;
      return name === filename && typeof token === "string";
    });
    const existingToken =
      typeof existingAttachment?.file_token === "string"
        ? existingAttachment.file_token
        : typeof existingAttachment?.fileToken === "string"
          ? existingAttachment.fileToken
          : null;
    if (existingToken !== null) {
      return {
        fileToken: existingToken,
        remoteHash: command.contentHash,
        attachmentUrl:
          `${this.pageEvidenceBaseUrl}/attachments/${encodeURIComponent(existingToken)}`,
      };
    }
    const mutationHash = sha256(canonicalPayload({
      operation: "record-upload-attachment",
      tableId: this.#configuration.tables.artifacts,
      remoteRecordId: command.remoteRecordId,
      stableId: command.stableId,
      attachmentRole: command.attachmentRole,
      filename,
      contentHash: command.contentHash,
    }));
    const response = await this.#runMutation(
      "record-upload-attachment",
      mutationHash,
      command.authorization,
      [
        "base",
        "+record-upload-attachment",
        "--base-token",
        this.#baseToken(),
        "--table-id",
        this.#configuration.tables.artifacts,
        "--record-id",
        command.remoteRecordId,
        "--field-id",
        this.#configuration.artifactAttachmentField,
        "--file",
        filename,
        "--format",
        "json",
        "--as",
        "user",
      ],
      {
        inputSnapshot: {
          filename,
          content: contentSnapshot,
          contentHash: command.contentHash,
        },
      },
    );
    const token = collectRecords(response)
      .map((record) => record.file_token ?? record.fileToken)
      .find((value): value is string => typeof value === "string");
    if (token === undefined) {
      throw new Error("lark-cli attachment upload returned no file token");
    }
    return {
      fileToken: token,
      remoteHash: command.contentHash,
      attachmentUrl:
        `${this.pageEvidenceBaseUrl}/attachments/${encodeURIComponent(token)}`,
    };
  }

  async downloadAttachment(
    command: Parameters<LarkBaseProjectionTransportPort["downloadAttachment"]>[0],
  ): Promise<Uint8Array> {
    this.#assertActive();
    const record = await this.#findRecord(
      "artifacts",
      command.stableId,
    );
    const recordId =
      typeof record?.record_id === "string" ? record.record_id : null;
    const fields =
      record?.fields !== null && typeof record?.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    const safeRole = command.attachmentRole.replace(
      /[^a-z0-9._-]/gi,
      "_",
    );
    const boundAttachment = collectRecords(
      fields?.[this.#configuration.artifactAttachmentField],
    ).find((attachment) => {
      const token = attachment.file_token ?? attachment.fileToken;
      const name =
        typeof attachment.name === "string"
          ? attachment.name
          : typeof attachment.file_name === "string"
            ? attachment.file_name
            : typeof attachment.fileName === "string"
              ? attachment.fileName
              : null;
      return (
        token === command.fileToken &&
        typeof name === "string" &&
        name.startsWith(`${safeRole}-`)
      );
    });
    if (
      recordId !== command.remoteRecordId ||
      boundAttachment === undefined
    ) {
      throw new Error(
        `Lark Base attachment token or role is not bound to ${command.stableId}`,
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "ppt-lark-download-"));
    const filename = "attachment.bin";
    const path = join(directory, filename);
    try {
      await this.#run([
        "base",
        "+record-download-attachment",
        "--base-token",
        this.#baseToken(),
        "--table-id",
        this.#configuration.tables.artifacts,
        "--record-id",
        command.remoteRecordId,
        "--file-token",
        command.fileToken,
        "--output",
        filename,
        "--overwrite",
        "--format",
        "json",
        "--as",
        "user",
      ], { cwd: directory });
      return Uint8Array.from(await readFile(path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async createRecordShareLink(
    command: Parameters<LarkBaseProjectionTransportPort["createRecordShareLink"]>[0],
  ): Promise<string> {
    this.#assertActive();
    const mutationHash = sha256(canonicalPayload({
      operation: "record-share-link-create",
      tableId: this.#configuration.tables[command.tableKey],
      remoteRecordId: command.remoteRecordId,
    }));
    const response = await this.#runMutation(
      "record-share-link-create",
      mutationHash,
      command.authorization,
      [
      "base",
      "+record-share-link-create",
      "--base-token",
      this.#baseToken(),
      "--table-id",
      this.#configuration.tables[command.tableKey],
      "--record-ids",
      command.remoteRecordId,
      "--format",
      "json",
      "--as",
      "user",
      ],
    );
    return parseLarkRecordShareLinkEnvelope(
      response,
      command.remoteRecordId,
      this.#configuration.reportDocumentExpectedOrigin,
    );
  }

  async verifyPageEvidence(
    command: Parameters<LarkBaseProjectionTransportPort["verifyPageEvidence"]>[0],
  ): Promise<void> {
    this.#assertActive();
    if (
      command.mimeType !== "image/png" ||
      sha256(command.content) !== command.contentHash
    ) {
      throw new Error(
        "Lark page evidence replay requires the exact PNG bytes",
      );
    }
    const record = await this.#findRecord(
      "artifacts",
      command.stableId,
    );
    if (record === null) {
      throw new Error(
        `Lark page evidence record is missing: ${command.stableId}`,
      );
    }
    const fields =
      record.fields !== null && typeof record.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    const expectedPayload = canonicalPayload({
      schemaVersion: "lark-artifact-page-evidence-v1",
      recordType: "artifact_page_evidence",
      recordId: `${command.artifactId}:page:${command.pageNumber}`,
      jobId: command.jobId,
      runId: command.runId,
      artifactId: command.artifactId,
      pageNumber: command.pageNumber,
      sourceCaptureRecordId: command.sourceCaptureRecordId,
      filename: command.filename,
      mimeType: command.mimeType,
      contentHash: command.contentHash,
    });
    const storedPayload =
      fields[this.#configuration.payloadField];
    if (typeof storedPayload !== "string") {
      throw new Error("Lark page evidence payload is missing");
    }
    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = asObject(
        JSON.parse(storedPayload) as unknown,
        "page evidence payload",
      );
    } catch {
      throw new Error("Lark page evidence payload is invalid");
    }
    if (canonicalPayload(parsedPayload) !== expectedPayload) {
      throw new Error(
        "Lark page evidence payload conflicts with the expected lineage",
      );
    }
    if (
      fields[this.#configuration.payloadHashField] !==
      sha256(storedPayload)
    ) {
      throw new Error(
        "Lark page evidence payload integrity is invalid",
      );
    }
    const tokens = [
      ...new Set(
        collectRecords(
          fields[this.#configuration.artifactAttachmentField],
        )
          .map((entry) => entry.file_token ?? entry.fileToken)
          .filter(
            (value): value is string => typeof value === "string",
          ),
      ),
    ];
    const remoteRecordId =
      typeof record.record_id === "string"
        ? record.record_id
        : typeof record.recordId === "string"
          ? record.recordId
          : null;
    if (tokens.length !== 1 || remoteRecordId === null) {
      throw new Error(
        "Lark page evidence record must contain exactly one attachment",
      );
    }
    const downloaded = await this.downloadAttachment({
      tableKey: "artifacts",
      remoteRecordId,
      stableId: command.stableId,
      fileToken: tokens[0]!,
      attachmentRole: `page-${command.pageNumber}`,
      expectedContent: command.content,
    });
    if (sha256(downloaded) !== command.contentHash) {
      throw new Error(
        "Lark page evidence replay attachment hash mismatch",
      );
    }
    const shareUrl = await this.createRecordShareLink({
      tableKey: "artifacts",
      remoteRecordId,
      authorization: command.authorization,
    });
    if (shareUrl !== command.expectedUrl) {
      throw new Error(
        "Lark page evidence replay share URL conflicts with the marker",
      );
    }
  }

  async upsertReportCollection(
    command: Parameters<LarkBaseProjectionTransportPort["upsertReportCollection"]>[0],
  ): Promise<{
    readonly url: string;
    readonly remoteContentHash: `sha256:${string}`;
    readonly revisionId: number;
  }> {
    this.#assertActive();
    if (command.reports.length === 0) {
      throw new Error("Lark report collection cannot be empty");
    }
    if (
      new Set(command.reports.map(({ reportId }) => reportId)).size !==
      command.reports.length
    ) {
      throw new Error("Lark report collection has duplicate report IDs");
    }
    if (
      sha256(canonicalPayload(command.reports)) !==
      command.collectionHash
    ) {
      throw new Error("Lark report collection hash is invalid");
    }
    const content = createLarkReportCollectionMarkdown(command);
    const current = await this.#fetchReportDocument();
    const owner = parseReportOwner(current.content);
    if (owner !== command.jobId) {
      throw new Error(
        owner === null
          ? "Lark report document is not claimed by this Job"
          : `Lark report document is owned by another Job: ${owner}`,
      );
    }
    const readback = await this.#overwriteReportDocument({
      operation: "document-update",
      content,
      expectedRevisionId: current.revisionId,
      authorization: command.authorization,
      mutationContext: {
        jobId: command.jobId,
        collectionHash: command.collectionHash,
      },
    });
    return {
      url: readback.url,
      remoteContentHash: sha256(normalizeMarkdown(readback.content)),
      revisionId: readback.revisionId,
    };
  }

  async verifyReportCollection(
    command: Parameters<LarkBaseProjectionTransportPort["verifyReportCollection"]>[0],
  ): Promise<void> {
    this.#assertActive();
    if (
      command.reports.length === 0 ||
      sha256(canonicalPayload(command.reports)) !==
        command.collectionHash
    ) {
      throw new Error(
        "Lark report collection replay hash is invalid",
      );
    }
    const readback = await this.#fetchReportDocument();
    const expectedContent =
      createLarkReportCollectionMarkdown(command);
    if (
      parseReportOwner(readback.content) !== command.jobId ||
      readback.revisionId !== command.expectedRevisionId ||
      readback.url !== command.expectedUrl ||
      normalizeMarkdown(readback.content) !==
        normalizeMarkdown(expectedContent)
    ) {
      throw new Error(
        "Lark report collection replay readback is truncated or conflicting",
      );
    }
  }

  async readCommitMarker(
    command: Parameters<LarkBaseProjectionTransportPort["readCommitMarker"]>[0],
  ): Promise<LarkCommitMarker | null> {
    this.#assertActive();
    const record = await this.#findRecord(
      "commit_markers",
      `commit:${command.jobId}`,
    );
    if (record === null) return null;
    const fields =
      record.fields !== null && typeof record.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    const payloadIntegrityHash =
      fields[this.#configuration.payloadHashField];
    if (
      typeof payloadIntegrityHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(payloadIntegrityHash)
    ) {
      throw new Error("Lark Base commit marker hash is invalid");
    }
    const payload = fields[this.#configuration.payloadField];
    let parsedPayload: unknown;
    try {
      parsedPayload =
        typeof payload === "string" ? JSON.parse(payload) : null;
    } catch {
      throw new Error("Lark Base commit marker payload is invalid");
    }
    if (
      typeof payload !== "string" ||
      sha256(canonicalPayload(parsedPayload)) !== payloadIntegrityHash
    ) {
      throw new Error(
        "Lark Base commit marker payload integrity mismatch",
      );
    }
    const marker = asObject(parsedPayload, "commit marker payload");
    if (
      marker.schemaVersion !== "lark-projection-commit-v2" ||
      marker.jobId !== command.jobId ||
      typeof marker.batchHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(marker.batchHash) ||
      typeof marker.authorizationDecisionId !== "string" ||
      marker.authorizationDecisionId.trim().length === 0 ||
      !Number.isSafeInteger(marker.recordCount) ||
      (marker.recordCount as number) < 1 ||
      !Number.isSafeInteger(marker.attachmentCount) ||
      (marker.attachmentCount as number) < 0 ||
      !(
        marker.reportCollectionHash === null ||
        (typeof marker.reportCollectionHash === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(
            marker.reportCollectionHash,
          ))
      ) ||
      !(
        marker.reportCollectionHash === null
          ? marker.reportDocumentRevision === null
          : Number.isSafeInteger(marker.reportDocumentRevision) &&
            (marker.reportDocumentRevision as number) > 0
      ) ||
      typeof marker.committedAt !== "string" ||
      !Number.isFinite(Date.parse(marker.committedAt)) ||
      !Number.isSafeInteger(marker.revision) ||
      (marker.revision as number) < 1 ||
      !(
        marker.previousBatchHash === null ||
        (typeof marker.previousBatchHash === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(marker.previousBatchHash))
      )
    ) {
      throw new Error("Lark Base commit marker payload is invalid");
    }
    const reportUrls = marker.reportUrls;
    if (!Array.isArray(reportUrls)) {
      throw new Error("Lark Base commit marker report URLs are missing");
    }
    const parsedReportUrls = reportUrls.map((entry) => {
      const record =
        entry !== null && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : {};
      if (
        typeof record.reportId !== "string" ||
        record.reportId.trim().length === 0 ||
        typeof record.url !== "string"
      ) {
        throw new Error("Lark Base commit marker report URL is invalid");
      }
      assertHttps(record.url, "Lark commit marker report");
      const trusted = new URL(record.url);
      const reportToken = this.#reportDocumentToken();
      if (
        trusted.origin !==
          this.#configuration.reportDocumentExpectedOrigin ||
        trusted.pathname !== `/docx/${reportToken}` ||
        trusted.search.length > 0 ||
        trusted.hash.length > 0
      ) {
        throw new Error(
          "Lark Base commit marker report URL is not the configured Docx",
        );
      }
      return Object.freeze({
        reportId: record.reportId,
        url: record.url,
      });
    });
    if (
      new Set(parsedReportUrls.map(({ reportId }) => reportId)).size !==
        parsedReportUrls.length ||
      (parsedReportUrls.length === 0) !==
        (marker.reportCollectionHash === null)
    ) {
      throw new Error("Lark Base commit marker has duplicate report IDs");
    }
    if (!Array.isArray(marker.pageEvidenceUrls)) {
      throw new Error(
        "Lark Base commit marker page evidence URLs are missing",
      );
    }
    const parsedPageEvidenceUrls = marker.pageEvidenceUrls.map(
      (entry) => {
        const record =
          entry !== null && typeof entry === "object"
            ? (entry as Record<string, unknown>)
            : {};
        if (
          typeof record.artifactId !== "string" ||
          record.artifactId.trim().length === 0 ||
          !Number.isSafeInteger(record.pageNumber) ||
          (record.pageNumber as number) < 1 ||
          typeof record.url !== "string"
        ) {
          throw new Error(
            "Lark Base commit marker page evidence URL is invalid",
          );
        }
        const trusted = new URL(record.url);
        if (
          trusted.origin !==
            this.#configuration.reportDocumentExpectedOrigin ||
          !/^\/record\/[a-zA-Z0-9_-]{8,256}$/.test(
            trusted.pathname,
          ) ||
          trusted.search.length > 0 ||
          trusted.hash.length > 0
        ) {
          throw new Error(
            "Lark Base commit marker page evidence URL is not a trusted Feishu record",
          );
        }
        return Object.freeze({
          artifactId: record.artifactId,
          pageNumber: record.pageNumber as number,
          url: trusted.toString(),
        });
      },
    );
    if (
      new Set(
        parsedPageEvidenceUrls.map(({ artifactId, pageNumber }) =>
          pageEvidenceKey(artifactId, pageNumber),
        ),
      ).size !== parsedPageEvidenceUrls.length
    ) {
      throw new Error(
        "Lark Base commit marker has duplicate page evidence IDs",
      );
    }
    if (!Array.isArray(marker.attachments)) {
      throw new Error(
        "Lark Base commit marker attachment bindings are missing",
      );
    }
    const parsedAttachments = marker.attachments.map((entry) => {
      const record =
        entry !== null && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : {};
      if (
        typeof record.stableId !== "string" ||
        record.stableId.trim().length === 0 ||
        typeof record.remoteRecordId !== "string" ||
        record.remoteRecordId.trim().length === 0 ||
        typeof record.fileToken !== "string" ||
        record.fileToken.trim().length === 0 ||
        typeof record.role !== "string" ||
        !/^(?:original|contact-sheet|page-[1-9]\d*)$/.test(record.role) ||
        typeof record.contentHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(record.contentHash)
      ) {
        throw new Error(
          "Lark Base commit marker attachment binding is invalid",
        );
      }
      return Object.freeze({
        stableId: record.stableId,
        remoteRecordId: record.remoteRecordId,
        fileToken: record.fileToken,
        role: record.role,
        contentHash: record.contentHash as `sha256:${string}`,
      });
    });
    if (
      parsedAttachments.length !== marker.attachmentCount ||
      new Set(parsedAttachments.map(attachmentIdentity)).size !==
        parsedAttachments.length ||
      new Set(parsedAttachments.map(({ fileToken }) => fileToken)).size !==
        parsedAttachments.length
    ) {
      throw new Error(
        "Lark Base commit marker attachment bindings are duplicate or incomplete",
      );
    }
    return {
      schemaVersion: "lark-projection-commit-v2",
      jobId: command.jobId,
      batchHash: marker.batchHash as `sha256:${string}`,
      authorizationDecisionId:
        marker.authorizationDecisionId as string,
      recordCount: marker.recordCount as number,
      attachmentCount: marker.attachmentCount as number,
      reportUrls: parsedReportUrls,
      reportCollectionHash:
        marker.reportCollectionHash as `sha256:${string}` | null,
      reportDocumentRevision:
        marker.reportDocumentRevision as number | null,
      pageEvidenceUrls: parsedPageEvidenceUrls,
      attachments: parsedAttachments,
      committedAt: marker.committedAt as string,
      previousBatchHash:
        marker.previousBatchHash as `sha256:${string}` | null,
      revision: marker.revision as number,
    };
  }

  async readProductionJobState(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
  }): Promise<ProductionJobRemoteState> {
    this.#assertActive();
    const marker = await this.readCommitMarker({ jobId: command.jobId });
    if (marker !== null) {
      return {
        state: "commit_marker_present_unverified",
        marker,
        observedStableIds: [command.jobId],
      };
    }
    if (
      (await this.#findRecord("runs", `job:${command.jobId}`)) !== null
    ) {
      return {
        state: "job_record_present",
        marker: null,
        observedStableIds: [command.jobId],
      };
    }
    const observedStableIds: string[] = [];
    for (const runId of command.runIds) {
      if ((await this.#findRecord("runs", `run:${runId}`)) !== null) {
        observedStableIds.push(runId);
      }
    }
    return {
      state:
        observedStableIds.length === 0
          ? "absent"
          : "vendor_run_present",
      marker: null,
      observedStableIds,
    };
  }

  #assertProductionClaimRecord(
    record: Record<string, unknown>,
    command: {
      readonly jobId: string;
      readonly runIds: readonly string[];
      readonly claimHash: `sha256:${string}`;
      readonly claimantId: string;
      readonly claimAttemptId: string;
    },
  ): {
    readonly claimEpoch: number;
    readonly claimState:
      | "claimed"
      | "aborted_before_submission";
    readonly executionLeaseId: string | null;
    readonly executionProcessId: number | null;
    readonly executionProcessStartIdentity: string | null;
    readonly authorizationDecisionId: string;
    readonly claimedAt: string;
    readonly abortedAt: string | null;
    readonly notSubmittedAttemptIds: readonly string[];
  } {
    const fields =
      record.fields !== null && typeof record.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    const payload = fields[this.#configuration.payloadField];
    const payloadHash = fields[this.#configuration.payloadHashField];
    let parsed: unknown;
    try {
      parsed = typeof payload === "string" ? JSON.parse(payload) : null;
    } catch {
      parsed = null;
    }
    const claim =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const isV2 = claim.schemaVersion === "lark-production-job-claim-v2";
    const isV3 = claim.schemaVersion === "lark-production-job-claim-v3";
    if (
      typeof record.record_id !== "string" ||
      fields[this.#configuration.stableIdField] !==
        `claim:${command.jobId}` ||
      typeof payload !== "string" ||
      typeof payloadHash !== "string" ||
      sha256(payload) !== payloadHash ||
      canonicalPayload(parsed) !== payload ||
      (!isV2 && !isV3) ||
      claim.jobId !== command.jobId ||
      claim.claimHash !== command.claimHash ||
      claim.claimantId !== command.claimantId ||
      claim.claimAttemptId !== command.claimAttemptId ||
      !isDeepStrictEqual(claim.runIds, command.runIds) ||
      typeof claim.authorizationDecisionId !== "string" ||
      claim.authorizationDecisionId.trim().length === 0 ||
      typeof claim.claimedAt !== "string" ||
      !Number.isFinite(Date.parse(claim.claimedAt))
    ) {
      throw new Error(
        `Production Job claim record is invalid or conflicting: ${command.jobId}`,
      );
    }
    if (isV2) {
      return {
        claimEpoch: 0,
        claimState: "claimed",
        executionLeaseId: null,
        executionProcessId: null,
        executionProcessStartIdentity: null,
        authorizationDecisionId:
          claim.authorizationDecisionId as string,
        claimedAt: claim.claimedAt as string,
        abortedAt: null,
        notSubmittedAttemptIds: [],
      };
    }
    if (
      !Number.isSafeInteger(claim.claimEpoch) ||
      (claim.claimEpoch as number) < 1 ||
      typeof claim.executionLeaseId !== "string" ||
      claim.executionLeaseId.trim().length === 0 ||
      !Number.isSafeInteger(claim.executionProcessId) ||
      (claim.executionProcessId as number) < 1
    ) {
      throw new Error(
        `Production Job claim lease is invalid: ${command.jobId}`,
      );
    }
    const claimState =
      claim.claimState === undefined ||
      claim.claimState === "claimed"
        ? "claimed"
        : claim.claimState === "aborted_before_submission"
          ? "aborted_before_submission"
          : null;
    const abortedAt =
      claim.abortedAt === undefined || claim.abortedAt === null
        ? null
        : typeof claim.abortedAt === "string" &&
            Number.isFinite(Date.parse(claim.abortedAt))
          ? claim.abortedAt
          : undefined;
    const notSubmittedAttemptIds =
      claim.notSubmittedAttemptIds === undefined
        ? []
        : Array.isArray(claim.notSubmittedAttemptIds) &&
            claim.notSubmittedAttemptIds.every(
              (value) =>
                typeof value === "string" &&
                value.trim().length > 0,
            )
          ? claim.notSubmittedAttemptIds
          : null;
    const expectedAttemptIds = command.runIds.map(
      (runId) => `${runId}-attempt-1`,
    );
    if (
      claimState === null ||
      abortedAt === undefined ||
      notSubmittedAttemptIds === null ||
      (claimState === "claimed" &&
        (abortedAt !== null ||
          notSubmittedAttemptIds.length !== 0)) ||
      (claimState === "aborted_before_submission" &&
        (abortedAt === null ||
          !isDeepStrictEqual(
            notSubmittedAttemptIds,
            expectedAttemptIds,
          )))
    ) {
      throw new Error(
        `Production Job claim state is invalid: ${command.jobId}`,
      );
    }
    return {
      claimEpoch: claim.claimEpoch as number,
      claimState,
      executionLeaseId: claim.executionLeaseId,
      executionProcessId: claim.executionProcessId as number,
      executionProcessStartIdentity:
        typeof claim.executionProcessStartIdentity === "string" &&
        claim.executionProcessStartIdentity.trim().length > 0
          ? claim.executionProcessStartIdentity
          : null,
      authorizationDecisionId:
        claim.authorizationDecisionId as string,
      claimedAt: claim.claimedAt as string,
      abortedAt,
      notSubmittedAttemptIds,
    };
  }

  async claimProductionJob(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly claimantId: string;
    readonly claimAttemptId: string;
    readonly authorization: ApprovedEgressAuthorization;
    readonly claimedAt: string;
  }): Promise<"claimed" | "already_claimed"> {
    this.#assertActive();
    return await this.#withMutex(
      "claim",
      command.jobId,
      async () => await this.#claimProductionJobWithoutMutex(command),
    );
  }

  async #claimProductionJobWithoutMutex(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly claimantId: string;
    readonly claimAttemptId: string;
    readonly authorization: ApprovedEgressAuthorization;
    readonly claimedAt: string;
  }): Promise<"claimed" | "already_claimed"> {
    nonEmpty(command.claimantId, "Production Job claimant ID");
    nonEmpty(command.claimAttemptId, "Production Job claim attempt ID");
    if (
      !(await this.#executionLease.isActive(
        this.#executionLease.leaseId,
        this.#executionLease.processId,
        this.#executionLease.processStartIdentity,
      ))
    ) {
      throw new Error(
        "Production Job execution lease sentinel is unavailable",
      );
    }
    const stableId = `claim:${command.jobId}`;
    const existing = await this.#findRecord("commit_markers", stableId);
    const currentReport = await this.#fetchReportDocument();
    const currentOwner = parseReportOwner(currentReport.content);
    const currentBinding =
      parseReportClaimBinding(currentReport.content);
    const logicalBindingMatches = (
      binding: LarkReportClaimBinding | null,
    ): boolean =>
      binding !== null &&
      binding.claimantId === command.claimantId &&
      binding.claimAttemptId === command.claimAttemptId &&
      binding.claimHash === command.claimHash;
    if (currentOwner !== null && currentOwner !== command.jobId) {
      throw new Error(
        `Lark report document is owned by another Job: ${currentOwner}`,
      );
    }
    if (
      currentOwner === command.jobId &&
      !logicalBindingMatches(currentBinding)
    ) {
      throw new Error(
        "Lark report document Job owner claim binding conflicts with this attempt",
      );
    }
    const existingLease =
      existing === null
        ? null
        : this.#assertProductionClaimRecord(existing, command);
    const leaseIsActive = async (
      leaseId: string | null,
      processId: number | null,
      processStartIdentity: string | null,
    ): Promise<boolean> => {
      if (leaseId === null || processId === null) return false;
      if (processStartIdentity === null) {
        // A pre-start-identity v3 claim is unknown while its PID is live.
        // Fail closed instead of risking a duplicate provider submission.
        return processIsAlive(processId);
      }
      return await this.#executionLease.isActive(
        leaseId,
        processId,
        processStartIdentity,
      );
    };
    if (
      existingLease !== null &&
      existingLease.claimState === "claimed" &&
      (await leaseIsActive(
        existingLease.executionLeaseId,
        existingLease.executionProcessId,
        existingLease.executionProcessStartIdentity,
      ))
    ) {
      return "already_claimed";
    }
    const currentBindingWasDurablyAborted =
      existingLease?.claimState ===
        "aborted_before_submission" &&
      currentBinding !== null &&
      currentBinding.claimEpoch === existingLease.claimEpoch &&
      currentBinding.executionLeaseId ===
        existingLease.executionLeaseId &&
      currentBinding.executionProcessId ===
        existingLease.executionProcessId &&
      currentBinding.executionProcessStartIdentity ===
        existingLease.executionProcessStartIdentity;
    if (
      currentBinding !== null &&
      !currentBindingWasDurablyAborted &&
      currentBinding.executionLeaseId !==
        this.#executionLease.leaseId &&
      (await leaseIsActive(
        currentBinding.executionLeaseId,
        currentBinding.executionProcessId,
        currentBinding.executionProcessStartIdentity,
      ))
    ) {
      return "already_claimed";
    }
    const resumingOwnOwnerOnlyLease =
      existingLease === null &&
      currentBinding?.executionLeaseId ===
        this.#executionLease.leaseId &&
      currentBinding.executionProcessId ===
        this.#executionLease.processId &&
      currentBinding.executionProcessStartIdentity ===
        this.#executionLease.processStartIdentity;
    const claimEpoch = resumingOwnOwnerOnlyLease
      ? currentBinding.claimEpoch
      : Math.max(
          existingLease?.claimEpoch ?? 0,
          currentBinding?.claimEpoch ?? 0,
        ) + 1;
    const claimBinding: LarkReportClaimBinding = Object.freeze({
      claimantId: command.claimantId,
      claimAttemptId: command.claimAttemptId,
      claimHash: command.claimHash,
      claimEpoch,
      executionLeaseId: this.#executionLease.leaseId,
      executionProcessId: this.#executionLease.processId,
      executionProcessStartIdentity:
        this.#executionLease.processStartIdentity,
    });
    if (!isDeepStrictEqual(currentBinding, claimBinding)) {
      const ownerContent = createLarkReportOwnerMarkdown(
        command.jobId,
        claimBinding,
      );
      try {
        const ownerReadback = await this.#overwriteReportDocument({
          operation: "document-owner-claim",
          content: ownerContent,
          expectedRevisionId: currentReport.revisionId,
          authorization: command.authorization,
          mutationContext: {
            jobId: command.jobId,
            claimHash: command.claimHash,
            claimEpoch,
            executionLeaseId: this.#executionLease.leaseId,
          },
        });
        if (
          parseReportOwner(ownerReadback.content) !== command.jobId ||
          !isDeepStrictEqual(
            parseReportClaimBinding(ownerReadback.content),
            claimBinding,
          )
        ) {
          throw new Error(
            "Production Job report owner claim readback is conflicting",
          );
        }
      } catch (error) {
        const racedReadback = await this.#fetchReportDocument();
        if (
          parseReportOwner(racedReadback.content) !== command.jobId ||
          !isDeepStrictEqual(
            parseReportClaimBinding(racedReadback.content),
            claimBinding,
          )
        ) {
          throw error;
        }
      }
    }
    const payload = canonicalPayload({
      schemaVersion: "lark-production-job-claim-v3",
      jobId: command.jobId,
      runIds: command.runIds,
      claimHash: command.claimHash,
      claimantId: command.claimantId,
      claimAttemptId: command.claimAttemptId,
      claimEpoch,
      claimState: "claimed",
      executionLeaseId: this.#executionLease.leaseId,
      executionProcessId: this.#executionLease.processId,
      executionProcessStartIdentity:
        this.#executionLease.processStartIdentity,
      abortedAt: null,
      notSubmittedAttemptIds: [],
      authorizationDecisionId: command.authorization.decisionId,
      claimedAt: command.claimedAt,
    });
    const payloadHash = sha256(payload);
    await this.upsertRecord({
      tableKey: "commit_markers",
      stableId,
      payload,
      payloadHash,
      idempotencyKey:
        `lark-job-claim:${command.jobId}:${command.claimHash}:${claimEpoch}:${encodeURIComponent(this.#executionLease.leaseId)}`,
      authorization: command.authorization,
    });
    return "claimed";
  }

  async abortProductionJobClaimBeforeSubmission(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly claimantId: string;
    readonly claimAttemptId: string;
    readonly authorization: ApprovedEgressAuthorization;
    readonly notSubmittedAttemptIds: readonly string[];
    readonly abortedAt: string;
  }): Promise<void> {
    this.#assertActive();
    await this.#withMutex(
      "claim",
      command.jobId,
      async () => {
        const expectedAttemptIds = command.runIds.map(
          (runId) => `${runId}-attempt-1`,
        );
        if (
          !isDeepStrictEqual(
            command.notSubmittedAttemptIds,
            expectedAttemptIds,
          ) ||
          !Number.isFinite(Date.parse(command.abortedAt))
        ) {
          throw new Error(
            "Production Job pre-submission abort proof is incomplete",
          );
        }
        const stableId = `claim:${command.jobId}`;
        const existing = await this.#findRecord(
          "commit_markers",
          stableId,
        );
        if (existing === null) {
          throw new Error(
            `Production Job claim is missing before abort: ${command.jobId}`,
          );
        }
        const lease = this.#assertProductionClaimRecord(
          existing,
          command,
        );
        if (lease.claimState === "aborted_before_submission") {
          if (
            !isDeepStrictEqual(
              lease.notSubmittedAttemptIds,
              expectedAttemptIds,
            )
          ) {
            throw new Error(
              "Production Job pre-submission abort proof conflicts",
            );
          }
          await this.#releaseExecutionLease();
          return;
        }
        if (
          lease.executionLeaseId !==
            this.#executionLease.leaseId ||
          lease.executionProcessId !==
            this.#executionLease.processId ||
          lease.executionProcessStartIdentity !==
            this.#executionLease.processStartIdentity
        ) {
          throw new Error(
            "Production Job pre-submission abort is not owned by this execution lease",
          );
        }
        const currentReport = await this.#fetchReportDocument();
        const currentBinding =
          parseReportClaimBinding(currentReport.content);
        if (
          parseReportOwner(currentReport.content) !== command.jobId ||
          currentBinding === null ||
          currentBinding.claimEpoch !== lease.claimEpoch ||
          currentBinding.executionLeaseId !== lease.executionLeaseId ||
          currentBinding.executionProcessId !==
            lease.executionProcessId ||
          currentBinding.executionProcessStartIdentity !==
            lease.executionProcessStartIdentity
        ) {
          throw new Error(
            "Production Job pre-submission abort report binding conflicts",
          );
        }
        const payload = canonicalPayload({
          schemaVersion: "lark-production-job-claim-v3",
          jobId: command.jobId,
          runIds: command.runIds,
          claimHash: command.claimHash,
          claimantId: command.claimantId,
          claimAttemptId: command.claimAttemptId,
          claimEpoch: lease.claimEpoch,
          claimState: "aborted_before_submission",
          executionLeaseId: lease.executionLeaseId,
          executionProcessId: lease.executionProcessId,
          executionProcessStartIdentity:
            lease.executionProcessStartIdentity,
          abortedAt: command.abortedAt,
          notSubmittedAttemptIds: expectedAttemptIds,
          authorizationDecisionId:
            lease.authorizationDecisionId,
          claimedAt: lease.claimedAt,
        });
        await this.upsertRecord({
          tableKey: "commit_markers",
          stableId,
          payload,
          payloadHash: sha256(payload),
          idempotencyKey:
            `lark-job-claim-abort:${command.jobId}:${command.claimHash}:${lease.claimEpoch}:${encodeURIComponent(this.#executionLease.leaseId)}`,
          authorization: command.authorization,
        });
        await this.#releaseExecutionLease();
      },
    );
  }

  async commitBatch(
    command: Parameters<LarkBaseProjectionTransportPort["commitBatch"]>[0],
  ): Promise<void> {
    this.#assertActive();
    const { authorization, ...marker } = command;
    const payload = canonicalPayload(marker);
    await this.upsertRecord({
      tableKey: "commit_markers",
      stableId: `commit:${command.jobId}`,
      payload,
      payloadHash: sha256(payload),
      idempotencyKey:
        `lark-commit:${command.jobId}:${command.batchHash}`,
      authorization,
    });
    await this.#releaseExecutionLease();
  }
}

export async function createVerifiedLarkCliTransport(options: {
  readonly configuration: LarkCliProjectionConfiguration;
  readonly egressAuthorization: EgressAuthorizationPort;
  readonly egressAudit: EgressAuthorizationAuditPort;
  readonly clock?: ClockPort;
}): Promise<LarkBaseProjectionTransportPort> {
  const binaryPath = resolve(FROZEN_LARK_CLI_BINARY);
  const wrapperPath = resolve(FROZEN_LARK_CLI_WRAPPER);
  const scriptPath = resolve(FROZEN_LARK_CLI_SCRIPT);
  const [nativeBytes, wrapperMetadata, wrapperTarget, scriptBytes] =
    await Promise.all([
      readFile(binaryPath),
      lstat(wrapperPath),
      readlink(wrapperPath),
      readFile(scriptPath),
    ]);
  const nativeHash = sha256(Uint8Array.from(nativeBytes));
  const wrapperScriptHash = sha256(Uint8Array.from(scriptBytes));
  if (nativeHash !== FROZEN_LARK_CLI_SHA256) {
    throw new Error(
      "Frozen native lark-cli executable does not match the reviewed installation",
    );
  }
  if (
    wrapperMetadata.isSymbolicLink() !== true ||
    wrapperTarget !== FROZEN_LARK_CLI_WRAPPER_TARGET ||
    wrapperScriptHash !== FROZEN_LARK_CLI_SCRIPT_SHA256
  ) {
    throw new Error(
      "lark-cli wrapper does not match the reviewed native installation; wrapper execution is prohibited",
    );
  }
  const nativeVersionOutput = await frozenLarkCliVersion(binaryPath);
  assertFrozenLarkCliInstallation({
    nativeHash,
    nativeVersionOutput,
    wrapperIsSymbolicLink: wrapperMetadata.isSymbolicLink(),
    wrapperTarget,
    wrapperScriptHash,
  });
  if (
    options.configuration.concurrencyBoundary !==
    "single_workstation_durable_mutex"
  ) {
    throw new Error(
      "Verified Lark transport requires the declared single-workstation durable mutex boundary",
    );
  }
  if (
    typeof options.configuration.lockRootPath !== "string" ||
    options.configuration.lockRootPath.trim().length === 0 ||
    resolve(options.configuration.lockRootPath) !==
      options.configuration.lockRootPath ||
    options.configuration.lockRootPath === sep
  ) {
    throw new Error(
      "Verified Lark transport requires one normalized fixed machine lock root",
    );
  }
  for (const [label, value] of Object.entries({
    lockRootPath: options.configuration.lockRootPath,
    baseTokenEnvironmentVariable:
      options.configuration.baseTokenEnvironmentVariable,
    reportDocumentTokenEnvironmentVariable:
      options.configuration.reportDocumentTokenEnvironmentVariable,
    stableIdField: options.configuration.stableIdField,
    payloadField: options.configuration.payloadField,
    payloadHashField: options.configuration.payloadHashField,
    artifactAttachmentField:
      options.configuration.artifactAttachmentField,
    targetAccount: options.configuration.targetAccount,
    targetRegion: options.configuration.targetRegion,
  })) {
    nonEmpty(value, label);
  }
  if (options.configuration.cliIdentityBinding !== undefined) {
    for (const [label, value] of Object.entries(
      options.configuration.cliIdentityBinding,
    )) {
      nonEmpty(value, `cliIdentityBinding.${label}`);
    }
    const expectedRegion =
      options.configuration.cliIdentityBinding.brand === "feishu"
        ? "cn"
        : "global";
    if (
      options.configuration.targetAccount !==
        options.configuration.cliIdentityBinding.userOpenId ||
      options.configuration.targetRegion !== expectedRegion
    ) {
      throw new Error(
        "Lark target account or region does not match the configured CLI identity binding",
      );
    }
  }
  for (const [tableKey, tableId] of Object.entries(
    options.configuration.tables,
  )) {
    if (!/^tbl[a-zA-Z0-9]{8,64}$/.test(tableId)) {
      throw new Error(`Lark Base table ID is invalid: ${tableKey}`);
    }
  }
  assertHttps(
    options.configuration.pageEvidenceBaseUrl,
    "Lark page evidence base",
  );
  assertHttpsBase(
    options.configuration.baseWebUrl,
    "Lark Base web URL",
  );
  assertHttpsBase(
    options.configuration.reportDocumentExpectedOrigin,
    "Lark report document expected origin",
  );
  const reportOrigin = new URL(
    options.configuration.reportDocumentExpectedOrigin,
  );
  if (
    options.configuration.reportDocumentExpectedOrigin !==
      reportOrigin.origin
  ) {
    throw new Error(
      "Lark report document expected origin must be an exact HTTPS origin",
    );
  }
  assertCanonicalLarkBaseWebUrl(
    options.configuration.baseWebUrl,
    reportOrigin.origin,
  );
  const transport = new VerifiedLarkCliTransport(
    binaryPath,
    options.configuration,
    options.egressAuthorization,
    options.egressAudit,
    options.clock ?? SYSTEM_CLOCK,
    undefined,
    undefined,
    async () => await attestFrozenLarkCliExecutable(binaryPath),
  );
  VERIFIED_LARK_TRANSPORTS.add(transport);
  VERIFIED_LARK_DESTINATIONS.set(transport, {
    targetAccount: options.configuration.targetAccount,
    targetRegion: options.configuration.targetRegion,
  });
  return transport;
}

/**
 * Narrow, unregistered seam used only to prove the mutation authorization
 * boundary. It cannot be installed as a harness-owned production projection.
 */
export function createLarkCliTransportForMutationBoundaryTest(options: {
  readonly configuration: LarkCliProjectionConfiguration;
  readonly egressAuthorization: EgressAuthorizationPort;
  readonly egressAudit: EgressAuthorizationAuditPort;
  readonly clock: ClockPort;
  readonly run: LarkCliJsonRunner;
  readonly claimLeaseForTest?: LarkExecutionLeasePort;
  readonly attestExecutableForTest?: LarkCliExecutableAttestor;
}): LarkBaseProjectionTransportPort {
  return new VerifiedLarkCliTransport(
    FROZEN_LARK_CLI_BINARY,
    options.configuration,
    options.egressAuthorization,
    options.egressAudit,
    options.clock,
    options.run,
    options.claimLeaseForTest,
    options.attestExecutableForTest,
  );
}
