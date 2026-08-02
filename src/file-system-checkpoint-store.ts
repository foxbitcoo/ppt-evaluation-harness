import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ObservableAttemptEvent } from "./domain.ts";
import type {
  AttemptCheckpointAdapterClaim,
  AttemptCheckpointPort,
} from "./product-adapter.ts";
import { parseStrictJson } from "./strict-json.ts";

const LEDGER_SCHEMA = "attempt-checkpoint-ledger-v1" as const;
const TERMINAL_PROOF_SCHEMA =
  "harness-terminal-non-submission-proof-v1" as const;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const LOCK_TIMEOUT_MS = 30_000;

interface CheckpointLineage {
  readonly jobId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
}

interface TerminalNonSubmissionProof {
  readonly schemaVersion: typeof TERMINAL_PROOF_SCHEMA;
  readonly adapterVersion: string;
  readonly claimEpoch: number;
  readonly adapterClaimRecordHash: `sha256:${string}`;
  readonly submissionIntentEventId: string | null;
}

interface CheckpointRootIdentity {
  readonly schemaVersion: "checkpoint-root-identity-v1";
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly ownerUserId: number;
  readonly mode: number;
}

interface CheckpointLedgerRecord {
  readonly schemaVersion: typeof LEDGER_SCHEMA;
  readonly checkpointStoreId: string;
  readonly sequence: number;
  readonly parentRecordHash: `sha256:${string}` | null;
  readonly lineage: CheckpointLineage;
  readonly recordType: "event" | "adapter_claim";
  readonly event: ObservableAttemptEvent | null;
  readonly adapterClaim: AttemptCheckpointAdapterClaim | null;
  readonly terminalNonSubmissionProof:
    | TerminalNonSubmissionProof
    | null;
  readonly recordHash: `sha256:${string}`;
  readonly authenticationTag: `hmac-sha256:${string}`;
}

const DURABLY_VERIFIED_TERMINAL_NON_SUBMISSIONS = new WeakMap<
  ObservableAttemptEvent,
  TerminalNonSubmissionProof
>();

export function durableTerminalNonSubmissionProof(
  event: ObservableAttemptEvent,
): TerminalNonSubmissionProof | null {
  return DURABLY_VERIFIED_TERMINAL_NON_SUBMISSIONS.get(event) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} does not match its strict schema`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

const EVENT_REQUIRED_KEYS = Object.freeze([
  "eventId",
  "jobId",
  "caseId",
  "runId",
  "attemptId",
  "attemptSeq",
  "eventType",
  "sourceAt",
  "observedAt",
  "writerId",
  "evidenceRef",
]);
const EVENT_OPTIONAL_KEYS = Object.freeze([
  "sourceUrl",
  "submissionEvidenceAtCheckpoint",
  "vendorTaskId",
  "taskStateVersion",
  "adapterVersion",
  "artifactId",
  "reconciliationObservedState",
  "reconciliationTerminalReason",
  "reconciliationArtifactReference",
]);

function validateEvent(
  value: unknown,
  expectedAttemptId?: string,
): ObservableAttemptEvent {
  if (!isRecord(value)) {
    throw new Error("Attempt checkpoint event must be an object");
  }
  assertExactKeys(
    value,
    EVENT_REQUIRED_KEYS,
    EVENT_OPTIONAL_KEYS,
    "Attempt checkpoint event",
  );
  for (const key of EVENT_REQUIRED_KEYS) {
    if (key !== "attemptSeq") nonEmptyString(value[key], `Event ${key}`);
  }
  positiveSafeInteger(value.attemptSeq, "Event attemptSeq");
  if (
    expectedAttemptId !== undefined &&
    value.attemptId !== expectedAttemptId
  ) {
    throw new Error("Attempt checkpoint event has conflicting lineage");
  }
  for (const key of ["sourceUrl", "vendorTaskId", "taskStateVersion", "artifactId", "reconciliationArtifactReference"] as const) {
    const observed = value[key];
    if (
      observed !== undefined &&
      observed !== null &&
      typeof observed !== "string"
    ) {
      throw new Error(`Event ${key} has an invalid value`);
    }
  }
  for (const key of ["adapterVersion", "reconciliationTerminalReason"] as const) {
    const observed = value[key];
    if (observed !== undefined) nonEmptyString(observed, `Event ${key}`);
  }
  if (
    value.submissionEvidenceAtCheckpoint !== undefined &&
    value.submissionEvidenceAtCheckpoint !== "not_submitted" &&
    value.submissionEvidenceAtCheckpoint !== "submitted" &&
    value.submissionEvidenceAtCheckpoint !== "unknown"
  ) {
    throw new Error("Event submission evidence is invalid");
  }
  if (
    value.reconciliationObservedState !== undefined &&
    value.reconciliationObservedState !== "unknown" &&
    value.reconciliationObservedState !== "submitted" &&
    value.reconciliationObservedState !== "artifact_ready" &&
    value.reconciliationObservedState !== "failed"
  ) {
    throw new Error("Event reconciliation state is invalid");
  }
  if (value.eventType === "query_not_submitted") {
    if (
      value.submissionEvidenceAtCheckpoint !== "not_submitted" ||
      typeof value.adapterVersion !== "string" ||
      value.writerId !== value.adapterVersion ||
      (value.vendorTaskId !== null && value.vendorTaskId !== undefined) ||
      !/^not_submitted@[1-9]\d*$/.test(
        typeof value.taskStateVersion === "string"
          ? value.taskStateVersion
          : "",
      )
    ) {
      throw new Error(
        "Terminal non-submission checkpoint does not match its strict schema",
      );
    }
  }
  return Object.freeze(value as unknown as ObservableAttemptEvent);
}

function validateClaim(
  value: unknown,
  expectedAttemptId?: string,
): AttemptCheckpointAdapterClaim {
  if (!isRecord(value)) {
    throw new Error("Attempt adapter claim must be an object");
  }
  assertExactKeys(
    value,
    [
      "jobId",
      "caseId",
      "runId",
      "attemptId",
      "attemptSeq",
      "adapterVersion",
      "claimEpoch",
    ],
    [],
    "Attempt adapter claim",
  );
  for (const key of [
    "jobId",
    "caseId",
    "runId",
    "attemptId",
    "adapterVersion",
  ] as const) {
    nonEmptyString(value[key], `Adapter claim ${key}`);
  }
  positiveSafeInteger(value.attemptSeq, "Adapter claim attemptSeq");
  positiveSafeInteger(value.claimEpoch, "Adapter claim epoch");
  if (
    expectedAttemptId !== undefined &&
    value.attemptId !== expectedAttemptId
  ) {
    throw new Error("Attempt adapter claim has conflicting lineage");
  }
  return Object.freeze(
    value as unknown as AttemptCheckpointAdapterClaim,
  );
}

function lineageOf(
  value: ObservableAttemptEvent | AttemptCheckpointAdapterClaim,
): CheckpointLineage {
  return Object.freeze({
    jobId: value.jobId,
    caseId: value.caseId,
    runId: value.runId,
    attemptId: value.attemptId,
    attemptSeq: value.attemptSeq,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Checkpoint canonical JSON contains undefined");
  }
  return serialized;
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function authenticationTag(
  key: Buffer,
  recordHash: string,
): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac("sha256", key)
    .update(recordHash)
    .digest("hex")}`;
}

function tagsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function unsignedRecord(
  record: Omit<
    CheckpointLedgerRecord,
    "recordHash" | "authenticationTag"
  >,
): Omit<CheckpointLedgerRecord, "recordHash" | "authenticationTag"> {
  return record;
}

function createRecord(
  input: Omit<
    CheckpointLedgerRecord,
    "schemaVersion" | "checkpointStoreId" | "sequence" |
      "parentRecordHash" | "recordHash" | "authenticationTag"
  >,
  checkpointStoreId: string,
  records: readonly CheckpointLedgerRecord[],
  key: Buffer,
): CheckpointLedgerRecord {
  const unsigned = unsignedRecord({
    schemaVersion: LEDGER_SCHEMA,
    checkpointStoreId,
    sequence: records.length + 1,
    parentRecordHash: records.at(-1)?.recordHash ?? null,
    ...input,
  });
  const recordHash = sha256(unsigned);
  return Object.freeze({
    ...unsigned,
    recordHash,
    authenticationTag: authenticationTag(key, recordHash),
  });
}

function validateProof(
  value: unknown,
): TerminalNonSubmissionProof {
  if (!isRecord(value)) {
    throw new Error("Terminal non-submission proof is invalid");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "adapterVersion",
      "claimEpoch",
      "adapterClaimRecordHash",
      "submissionIntentEventId",
    ],
    [],
    "Terminal non-submission proof",
  );
  if (
    value.schemaVersion !== TERMINAL_PROOF_SCHEMA ||
    typeof value.adapterVersion !== "string" ||
    value.adapterVersion.length === 0 ||
    !Number.isSafeInteger(value.claimEpoch) ||
    (value.claimEpoch as number) < 1 ||
    typeof value.adapterClaimRecordHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.adapterClaimRecordHash) ||
    (value.submissionIntentEventId !== null &&
      typeof value.submissionIntentEventId !== "string")
  ) {
    throw new Error("Terminal non-submission proof is invalid");
  }
  return Object.freeze(
    value as unknown as TerminalNonSubmissionProof,
  );
}

function sameLineage(
  left: CheckpointLineage,
  right: CheckpointLineage,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseLedger(
  content: string,
  attemptId: string,
  checkpointStoreId: string,
  key: Buffer,
): readonly CheckpointLedgerRecord[] {
  if (Buffer.byteLength(content, "utf8") > MAX_LEDGER_BYTES) {
    throw new Error("Attempt checkpoint ledger exceeds its size bound");
  }
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new Error("Attempt checkpoint ledger has a partial record");
  }
  const lines = content.split("\n").filter(Boolean);
  const records: CheckpointLedgerRecord[] = [];
  const eventIds = new Set<string>();
  let expectedLineage: CheckpointLineage | undefined;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("Attempt checkpoint record exceeds its size bound");
    }
    const parsed = parseStrictJson(
      line,
      `Attempt checkpoint line ${index + 1}`,
    );
    if (!isRecord(parsed)) {
      throw new Error("Attempt checkpoint record must be an object");
    }
    assertExactKeys(
      parsed,
      [
        "schemaVersion",
        "checkpointStoreId",
        "sequence",
        "parentRecordHash",
        "lineage",
        "recordType",
        "event",
        "adapterClaim",
        "terminalNonSubmissionProof",
        "recordHash",
        "authenticationTag",
      ],
      [],
      "Attempt checkpoint record",
    );
    if (
      parsed.schemaVersion !== LEDGER_SCHEMA ||
      parsed.checkpointStoreId !== checkpointStoreId ||
      parsed.sequence !== index + 1 ||
      parsed.parentRecordHash !==
        (records.at(-1)?.recordHash ?? null) ||
      (parsed.recordType !== "event" &&
        parsed.recordType !== "adapter_claim") ||
      typeof parsed.recordHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(parsed.recordHash) ||
      typeof parsed.authenticationTag !== "string" ||
      !/^hmac-sha256:[a-f0-9]{64}$/.test(
        parsed.authenticationTag,
      )
    ) {
      throw new Error(
        "Attempt checkpoint sequence, parent hash, or schema is invalid",
      );
    }
    if (!isRecord(parsed.lineage)) {
      throw new Error("Attempt checkpoint lineage is invalid");
    }
    assertExactKeys(
      parsed.lineage,
      ["jobId", "caseId", "runId", "attemptId", "attemptSeq"],
      [],
      "Attempt checkpoint lineage",
    );
    const lineage = lineageOf(
      validateClaim(
        {
          ...parsed.lineage,
          adapterVersion: "lineage-validator@1",
          claimEpoch: 1,
        },
        attemptId,
      ),
    );
    if (
      expectedLineage !== undefined &&
      !sameLineage(expectedLineage, lineage)
    ) {
      throw new Error("Attempt checkpoint parent lineage conflicts");
    }
    expectedLineage ??= lineage;
    const unsigned = unsignedRecord({
      schemaVersion: LEDGER_SCHEMA,
      checkpointStoreId,
      sequence: parsed.sequence as number,
      parentRecordHash:
        parsed.parentRecordHash as `sha256:${string}` | null,
      lineage,
      recordType: parsed.recordType,
      event: parsed.event as ObservableAttemptEvent | null,
      adapterClaim:
        parsed.adapterClaim as AttemptCheckpointAdapterClaim | null,
      terminalNonSubmissionProof:
        parsed.terminalNonSubmissionProof as
          | TerminalNonSubmissionProof
          | null,
    });
    const expectedHash = sha256(unsigned);
    if (
      parsed.recordHash !== expectedHash ||
      !tagsEqual(
        parsed.authenticationTag,
        authenticationTag(key, expectedHash),
      )
    ) {
      throw new Error(
        "Attempt checkpoint record is not authenticated",
      );
    }
    let event: ObservableAttemptEvent | null = null;
    let adapterClaim: AttemptCheckpointAdapterClaim | null = null;
    let proof: TerminalNonSubmissionProof | null = null;
    if (parsed.recordType === "event") {
      if (parsed.adapterClaim !== null) {
        throw new Error("Attempt checkpoint event record is conflicting");
      }
      event = validateEvent(parsed.event, attemptId);
      if (!sameLineage(lineage, lineageOf(event))) {
        throw new Error("Attempt checkpoint event parent lineage conflicts");
      }
      if (eventIds.has(event.eventId)) {
        throw new Error(
          `Attempt checkpoint identity conflict: ${event.eventId}`,
        );
      }
      eventIds.add(event.eventId);
      if (event.eventType === "query_not_submitted") {
        proof = validateProof(parsed.terminalNonSubmissionProof);
        if (proof.adapterVersion !== event.adapterVersion) {
          throw new Error(
            "Terminal non-submission proof adapter lineage conflicts",
          );
        }
        const claimRecord = records.find(
          (record) =>
            record.recordHash === proof!.adapterClaimRecordHash &&
            record.recordType === "adapter_claim" &&
            record.adapterClaim?.adapterVersion ===
              proof!.adapterVersion &&
            record.adapterClaim.claimEpoch === proof!.claimEpoch,
        );
        if (claimRecord === undefined) {
          throw new Error(
            "Terminal non-submission proof has no harness adapter claim",
          );
        }
        const latestIntent = [...records]
          .reverse()
          .find(
            (record) =>
              record.recordType === "event" &&
              record.event?.eventType === "submission_intent" &&
              record.event.adapterVersion === event!.adapterVersion,
          )?.event;
        if (
          proof.submissionIntentEventId !==
            (latestIntent?.eventId ?? null)
        ) {
          throw new Error(
            "Terminal non-submission proof claim epoch is stale",
          );
        }
        if (
          event.taskStateVersion !==
          `not_submitted@${proof.claimEpoch}`
        ) {
          throw new Error(
            "Terminal non-submission task state is not bound to its claim epoch",
          );
        }
      } else if (parsed.terminalNonSubmissionProof !== null) {
        throw new Error(
          "Non-terminal checkpoint cannot carry terminal proof",
        );
      }
    } else {
      if (
        parsed.event !== null ||
        parsed.terminalNonSubmissionProof !== null
      ) {
        throw new Error("Attempt adapter claim record is conflicting");
      }
      adapterClaim = validateClaim(parsed.adapterClaim, attemptId);
      if (!sameLineage(lineage, lineageOf(adapterClaim))) {
        throw new Error("Attempt adapter claim parent lineage conflicts");
      }
    }
    records.push(
      Object.freeze({
        schemaVersion: LEDGER_SCHEMA,
        checkpointStoreId,
        sequence: parsed.sequence as number,
        parentRecordHash:
          parsed.parentRecordHash as `sha256:${string}` | null,
        lineage,
        recordType: parsed.recordType,
        event,
        adapterClaim,
        terminalNonSubmissionProof: proof,
        recordHash: parsed.recordHash as `sha256:${string}`,
        authenticationTag:
          parsed.authenticationTag as `hmac-sha256:${string}`,
      }),
    );
  }
  return Object.freeze(records);
}

export class FileSystemAttemptCheckpointStore
  implements AttemptCheckpointPort
{
  readonly durability = "durable" as const;
  readonly checkpointIntegrity:
    | "authenticated_hash_chain"
    | "legacy_unverified_read_only";
  readonly checkpointStoreId: string;
  readonly recoveryReferencePrefix: string;
  readonly #rootPath: string;
  readonly #legacyReadOnly: boolean;

  constructor(input: {
    readonly checkpointStoreId: string;
    readonly rootPath: string;
    readonly legacyReadOnly?: boolean;
  }) {
    if (input.checkpointStoreId.trim().length === 0) {
      throw new Error("Checkpoint store requires a stable ID");
    }
    this.checkpointStoreId = input.checkpointStoreId;
    this.#rootPath = resolve(input.rootPath);
    if (this.#rootPath === sep) {
      throw new Error("Checkpoint store root must be narrowly scoped");
    }
    this.#legacyReadOnly = input.legacyReadOnly === true;
    this.checkpointIntegrity = this.#legacyReadOnly
      ? "legacy_unverified_read_only"
      : "authenticated_hash_chain";
    this.recoveryReferencePrefix =
      `checkpoint-store:${input.checkpointStoreId}:attempt`;
  }

  #digestFor(attemptId: string): string {
    return createHash("sha256").update(attemptId).digest("hex");
  }

  #pathFor(attemptId: string): string {
    return resolve(this.#rootPath, `${this.#digestFor(attemptId)}.jsonl`);
  }

  #lockPathFor(attemptId: string): string {
    return resolve(this.#rootPath, `${this.#digestFor(attemptId)}.lock`);
  }

  #keyPath(): string {
    const storeDigest = createHash("sha256")
      .update(this.checkpointStoreId)
      .digest("hex");
    return resolve(this.#rootPath, `.checkpoint-auth-${storeDigest}.key`);
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
    const observed = await this.#observedRootIdentity();
    const rootAnchorDigest = createHash("sha256")
      .update(observed.canonicalPath)
      .digest("hex");
    const identityPath = resolve(
      dirname(observed.canonicalPath),
      `.ppt-checkpoint-root-${rootAnchorDigest}.identity.json`,
    );
    const payload = `${JSON.stringify(observed)}\n`;
    let existing: string | undefined;
    try {
      const handle = await open(
        identityPath,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_WRONLY |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        existing = await this.#readSecureFile(
          identityPath,
          "Checkpoint root identity anchor",
        );
        if (existing.length > 0) break;
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, 5)
        );
      }
    }
    if (existing !== undefined && existing !== payload) {
      throw new Error(
        "Checkpoint store root identity conflicts with its persistent anchor",
      );
    }
  }

  async #observedRootIdentity(): Promise<CheckpointRootIdentity> {
    const [metadata, canonicalPath] = await Promise.all([
      lstat(this.#rootPath),
      realpath(this.#rootPath),
    ]);
    const mode = metadata.mode & 0o777;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (mode & 0o077) !== 0
    ) {
      throw new Error("Checkpoint store root identity is unsafe");
    }
    return Object.freeze({
      schemaVersion: "checkpoint-root-identity-v1" as const,
      canonicalPath,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      ownerUserId: metadata.uid,
      mode,
    });
  }

  async #readSecureFile(path: string, label: string): Promise<string> {
    const handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error(`${label} is unsafe`);
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async #authenticationKey(): Promise<Buffer> {
    const path = this.#keyPath();
    let content: string;
    try {
      const handle = await open(path, "wx", 0o600);
      content = `${randomBytes(32).toString("hex")}\n`;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      content = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        content = await this.#readSecureFile(
          path,
          "Checkpoint authentication key",
        );
        if (/^[a-f0-9]{64}\n$/.test(content)) break;
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, 5)
        );
      }
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0 ||
      !/^[a-f0-9]{64}\n$/.test(content)
    ) {
      throw new Error("Checkpoint authentication key is unsafe");
    }
    return Buffer.from(content.trim(), "hex");
  }

  async #readContent(path: string): Promise<string | null> {
    try {
      return await this.#readSecureFile(
        path,
        "Attempt checkpoint ledger",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async #readLedger(
    attemptId: string,
    key: Buffer,
  ): Promise<readonly CheckpointLedgerRecord[]> {
    const content = await this.#readContent(this.#pathFor(attemptId));
    if (content === null || content.length === 0) return Object.freeze([]);
    return parseLedger(
      content,
      attemptId,
      this.checkpointStoreId,
      key,
    );
  }

  async #writeLedger(
    attemptId: string,
    records: readonly CheckpointLedgerRecord[],
  ): Promise<void> {
    const path = this.#pathFor(attemptId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const payload = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    if (Buffer.byteLength(payload, "utf8") > MAX_LEDGER_BYTES) {
      throw new Error("Attempt checkpoint ledger exceeds its size bound");
    }
    let temporaryExists = false;
    try {
      const handle = await open(
        temporaryPath,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_WRONLY |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
      temporaryExists = false;
      const rootHandle = await open(this.#rootPath, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
    } finally {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #runLocked<T>(
    attemptId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.#prepareRoot();
    const lockPath = this.#lockPathFor(attemptId);
    const lockHandle = await open(
      lockPath,
      fileConstants.O_CREAT |
        fileConstants.O_APPEND |
        fileConstants.O_WRONLY |
        fileConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const lockMetadata = await lockHandle.stat();
      if (
        !lockMetadata.isFile() ||
        (process.getuid !== undefined &&
          lockMetadata.uid !== process.getuid()) ||
        (lockMetadata.mode & 0o077) !== 0
      ) {
        throw new Error("Checkpoint lock leaf is unsafe");
      }
      await lockHandle.chmod(0o600);
    } finally {
      await lockHandle.close();
    }
    const handshake = "checkpoint-lock-acquired-v1\n";
    const release = "release\n";
    const holderScript = [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (value) => { input += value; });',
      `process.stdin.on("end", () => process.exit(input === ${JSON.stringify(release)} ? 0 : 64));`,
      `process.stdout.write(${JSON.stringify(handshake)});`,
      "process.stdin.resume();",
    ].join("\n");
    const child = spawn(
      "/usr/bin/lockf",
      [
        "-t",
        String(LOCK_TIMEOUT_MS / 1_000),
        lockPath,
        process.execPath,
        "--input-type=module",
        "-e",
        holderScript,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    let acquired = false;
    let releaseRequested = false;
    let stdout = "";
    let stderr = "";
    let resolveAcquired!: () => void;
    let rejectAcquired!: (error: unknown) => void;
    const acquiredPromise = new Promise<void>((resolveReady, rejectReady) => {
      resolveAcquired = resolveReady;
      rejectAcquired = rejectReady;
    });
    const closedPromise = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveClosed, rejectClosed) => {
      child.once("error", (error) => {
        if (acquired && !releaseRequested) {
          process.kill(process.pid, "SIGKILL");
          return;
        }
        rejectAcquired(error);
        rejectClosed(error);
      });
      child.once("close", (code, signal) => {
        if (!acquired) {
          rejectAcquired(
            new Error(
              stderr.length === 0
                ? "Timed out acquiring checkpoint lock"
                : `Timed out acquiring checkpoint lock: ${stderr}`,
            ),
          );
        } else if (!releaseRequested) {
          process.kill(process.pid, "SIGKILL");
          return;
        }
        resolveClosed({ code, signal });
      });
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      if (acquired) return;
      stdout += value;
      if (!handshake.startsWith(stdout)) {
        child.kill("SIGKILL");
        rejectAcquired(new Error("Checkpoint lock handshake is invalid"));
      } else if (stdout === handshake) {
        acquired = true;
        resolveAcquired();
      }
    });
    child.stderr.on("data", (value: string) => {
      stderr += value;
      if (Buffer.byteLength(stderr, "utf8") > 4_096) {
        child.kill("SIGKILL");
        rejectAcquired(new Error("Checkpoint lock error exceeds its bound"));
      }
    });
    try {
      await acquiredPromise;
    } catch (error) {
      child.stdin.destroy();
      await closedPromise.catch(() => undefined);
      throw error;
    }
    try {
      return await operation();
    } finally {
      try {
        await this.#prepareRoot();
      } catch {
        process.kill(process.pid, "SIGKILL");
        await new Promise<never>(() => {});
      }
      releaseRequested = true;
      child.stdin.end(release);
      const closed = await closedPromise;
      if (closed.code !== 0 || closed.signal !== null || stderr !== "") {
        throw new Error("Checkpoint lock holder exited unexpectedly");
      }
    }
  }

  async registerAdapterClaim(
    input: AttemptCheckpointAdapterClaim,
  ): Promise<void> {
    if (this.#legacyReadOnly) {
      throw new Error("Legacy checkpoint store is read-only");
    }
    const claim = validateClaim(input, input.attemptId);
    await this.#runLocked(input.attemptId, async () => {
      const key = await this.#authenticationKey();
      const records = await this.#readLedger(input.attemptId, key);
      const lineage = lineageOf(claim);
      const existing = records.find(
        (record) =>
          record.recordType === "adapter_claim" &&
          record.adapterClaim?.claimEpoch === claim.claimEpoch,
      );
      if (existing !== undefined) {
        if (canonicalJson(existing.adapterClaim) !== canonicalJson(claim)) {
          throw new Error("Attempt adapter claim epoch conflicts");
        }
        return;
      }
      if (
        records[0] !== undefined &&
        !sameLineage(records[0].lineage, lineage)
      ) {
        throw new Error("Attempt adapter claim parent lineage conflicts");
      }
      const record = createRecord(
        {
          lineage,
          recordType: "adapter_claim",
          event: null,
          adapterClaim: claim,
          terminalNonSubmissionProof: null,
        },
        this.checkpointStoreId,
        records,
        key,
      );
      await this.#writeLedger(input.attemptId, [...records, record]);
    });
  }

  async append(eventInput: ObservableAttemptEvent): Promise<void> {
    if (this.#legacyReadOnly) {
      throw new Error("Legacy checkpoint store is read-only");
    }
    const event = validateEvent(eventInput, eventInput.attemptId);
    await this.#runLocked(event.attemptId, async () => {
      const key = await this.#authenticationKey();
      const records = await this.#readLedger(event.attemptId, key);
      const existing = records.find(
        (record) =>
          record.recordType === "event" &&
          record.event?.eventId === event.eventId,
      );
      if (existing !== undefined) {
        if (canonicalJson(existing.event) !== canonicalJson(event)) {
          throw new Error(
            `Attempt checkpoint identity conflict: ${event.eventId}`,
          );
        }
        return;
      }
      const lineage = lineageOf(event);
      if (
        records[0] !== undefined &&
        !sameLineage(records[0].lineage, lineage)
      ) {
        throw new Error("Attempt checkpoint parent lineage conflicts");
      }
      let proof: TerminalNonSubmissionProof | null = null;
      if (event.eventType === "query_not_submitted") {
        const claimRecord = [...records]
          .reverse()
          .find(
            (record) =>
              record.recordType === "adapter_claim" &&
              record.adapterClaim?.adapterVersion === event.adapterVersion &&
              record.adapterClaim?.claimEpoch ===
                Number(
                  event.taskStateVersion!.slice(
                    "not_submitted@".length,
                  ),
                ),
          );
        if (claimRecord?.adapterClaim === null || claimRecord === undefined) {
          throw new Error(
            "Terminal non-submission requires a matching harness adapter claim epoch",
          );
        }
        const latestIntent = [...records]
          .reverse()
          .find(
            (record) =>
              record.recordType === "event" &&
              record.event?.eventType === "submission_intent" &&
              record.event.adapterVersion === event.adapterVersion,
          )?.event;
        proof = Object.freeze({
          schemaVersion: TERMINAL_PROOF_SCHEMA,
          adapterVersion: claimRecord.adapterClaim.adapterVersion,
          claimEpoch: Number(event.taskStateVersion!.slice("not_submitted@".length)),
          adapterClaimRecordHash: claimRecord.recordHash,
          submissionIntentEventId: latestIntent?.eventId ?? null,
        });
      }
      const record = createRecord(
        {
          lineage,
          recordType: "event",
          event,
          adapterClaim: null,
          terminalNonSubmissionProof: proof,
        },
        this.checkpointStoreId,
        records,
        key,
      );
      await this.#writeLedger(event.attemptId, [...records, record]);
    });
  }

  async readAttempt(
    attemptId: string,
  ): Promise<readonly ObservableAttemptEvent[]> {
    nonEmptyString(attemptId, "Attempt ID");
    if (this.#legacyReadOnly) {
      const content = await this.#readContent(this.#pathFor(attemptId));
      if (content === null) return Object.freeze([]);
      if (content.length > 0 && !content.endsWith("\n")) {
        throw new Error("Legacy checkpoint ledger has a partial record");
      }
      return Object.freeze(
        content
          .split("\n")
          .filter(Boolean)
          .map((line, index) =>
            validateEvent(
              parseStrictJson(
                line,
                `Legacy attempt checkpoint line ${index + 1}`,
              ),
              attemptId,
            ),
          ),
      );
    }
    return this.#runLocked(attemptId, async () => {
      const key = await this.#authenticationKey();
      const records = await this.#readLedger(attemptId, key);
      const events = records.flatMap((record) => {
        if (record.event === null) return [];
        if (record.terminalNonSubmissionProof !== null) {
          DURABLY_VERIFIED_TERMINAL_NON_SUBMISSIONS.set(
            record.event,
            record.terminalNonSubmissionProof,
          );
        }
        return [record.event];
      });
      return Object.freeze(events);
    });
  }
}
