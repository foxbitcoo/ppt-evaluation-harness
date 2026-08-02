import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve, sep } from "node:path";

import type {
  ArtifactCaptureJournalEvent,
  ArtifactCaptureJournalPort,
} from "./artifact-vault.ts";
import type {
  ApprovedEgressAuthorization,
  EgressAuthorizationAuditPort,
} from "./egress-authorization.ts";
import type {
  JudgeEgressAttemptAudit,
} from "./domain.ts";
import type {
  JudgeEgressAuditPort,
} from "./openai-judge.ts";
import type {
  ReferencePack,
  ReferencePackStorePort,
  StagedReferencePack,
  UsedReferencePackRecord,
} from "./reference-pack.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface OperationalRootIdentity {
  readonly canonicalPath: string;
  readonly deviceId: string;
  readonly inodeId: string;
  readonly ownerUid: number;
  readonly mode: number;
}

function rootIdentity(input: {
  readonly canonicalPath: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number;
  readonly mode: number;
}): OperationalRootIdentity {
  return Object.freeze({
    canonicalPath: input.canonicalPath,
    deviceId: String(input.dev),
    inodeId: String(input.ino),
    ownerUid: input.uid,
    mode: input.mode,
  });
}

function sameIdentity(
  left: OperationalRootIdentity,
  right: OperationalRootIdentity,
): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.deviceId === right.deviceId &&
    left.inodeId === right.inodeId &&
    left.ownerUid === right.ownerUid &&
    left.mode === right.mode;
}

function assertOwnerOnly(input: {
  readonly uid: number;
  readonly mode: number;
}, label: string): void {
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (currentUid === null || input.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((input.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only`);
  }
}

function safeRoot(rootPath: string): OperationalRootIdentity {
  const root = resolve(rootPath);
  if (root === sep) {
    throw new Error("Operational durability root must be narrowly scoped");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const requested = lstatSync(root);
  if (requested.isSymbolicLink()) {
    throw new Error("Operational durability rejects a symbolic link root");
  }
  if (!requested.isDirectory()) {
    throw new Error("Operational durability root is not a directory");
  }
  const canonicalPath = realpathSync(root);
  const canonical = lstatSync(canonicalPath);
  if (
    canonical.isSymbolicLink() ||
    !canonical.isDirectory() ||
    canonical.dev !== requested.dev ||
    canonical.ino !== requested.ino
  ) {
    throw new Error(
      "Operational durability root identity changed during initialization",
    );
  }
  assertOwnerOnly(canonical, "Operational durability root");
  return rootIdentity({ canonicalPath, ...canonical });
}

function currentRootIdentity(
  root: OperationalRootIdentity,
): OperationalRootIdentity {
  const requested = lstatSync(root.canonicalPath);
  if (requested.isSymbolicLink() || !requested.isDirectory()) {
    throw new Error("Operational durability root identity changed");
  }
  const canonicalPath = realpathSync(root.canonicalPath);
  const canonical = lstatSync(canonicalPath);
  assertOwnerOnly(canonical, "Operational durability root");
  return rootIdentity({ canonicalPath, ...canonical });
}

function assertRootStillBound(root: OperationalRootIdentity): void {
  if (!sameIdentity(root, currentRootIdentity(root))) {
    throw new Error("Operational durability root identity changed");
  }
}

function withVerifiedRoot<T>(
  root: OperationalRootIdentity,
  operation: (descriptor: number) => T,
): T {
  assertRootStillBound(root);
  let descriptor: number;
  try {
    descriptor = openSync(
      root.canonicalPath,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error("Operational durability root identity changed", {
      cause: error,
    });
  }
  try {
    const opened = fstatSync(descriptor);
    const openedIdentity = rootIdentity({
      canonicalPath: root.canonicalPath,
      ...opened,
    });
    assertOwnerOnly(opened, "Operational durability root");
    if (!opened.isDirectory() || !sameIdentity(root, openedIdentity)) {
      throw new Error("Operational durability root identity changed");
    }
    const result = operation(descriptor);
    assertRootStillBound(root);
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function assertSecureLeaf(
  path: string,
  metadata: Stats,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `Operational durability leaf is a symbolic link or not a regular file: ${path}`,
    );
  }
  assertOwnerOnly(metadata, "Operational durability leaf");
}

function secureJsonRead<T>(
  root: OperationalRootIdentity,
  filename: string,
): T {
  return withVerifiedRoot(root, () => {
    const path = join(root.canonicalPath, filename);
    const before = lstatSync(path);
    assertSecureLeaf(path, before);
    let descriptor: number;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw new Error(
        `Operational durability leaf changed during read: ${path}`,
        { cause: error },
      );
    }
    try {
      const opened = fstatSync(descriptor);
      assertSecureLeaf(path, opened);
      if (
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        before.uid !== opened.uid ||
        before.mode !== opened.mode
      ) {
        throw new Error(
          `Operational durability leaf changed during read: ${path}`,
        );
      }
      const value = JSON.parse(readFileSync(descriptor, "utf8")) as T;
      const after = lstatSync(path);
      assertSecureLeaf(path, after);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.uid !== after.uid ||
        before.mode !== after.mode
      ) {
        throw new Error(
          `Operational durability leaf changed during read: ${path}`,
        );
      }
      return value;
    } finally {
      closeSync(descriptor);
    }
  });
}

function immutableJsonWrite(
  root: OperationalRootIdentity,
  filename: string,
  value: unknown,
): void {
  const content = JSON.stringify(value);
  const path = join(root.canonicalPath, filename);
  const temporaryPath = join(
    root.canonicalPath,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  withVerifiedRoot(root, (rootDescriptor) => {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      const temporaryMetadata = fstatSync(descriptor);
      assertSecureLeaf(temporaryPath, temporaryMetadata);
      writeFileSync(descriptor, content, { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      assertRootStillBound(root);
      linkSync(temporaryPath, path);
      fsyncSync(rootDescriptor);
    } catch (error: unknown) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = secureJsonRead<unknown>(root, filename);
      if (!isDeepStrictEqual(existing, value)) {
        throw new Error(`Durable immutable JSON conflict: ${path}`, {
          cause: error,
        });
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        assertRootStillBound(root);
        unlinkSync(temporaryPath);
        fsyncSync(rootDescriptor);
      } catch (error) {
        if (
          error === null ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  });
}

function readJsonFiles<T>(
  root: OperationalRootIdentity,
): readonly T[] {
  const names = withVerifiedRoot(root, () =>
    readdirSync(root.canonicalPath)
      .filter((name) => name.endsWith(".json"))
      .sort()
  );
  return names.map((name) => secureJsonRead<T>(root, name));
}

function secureRemove(
  root: OperationalRootIdentity,
  filename: string,
): boolean {
  return withVerifiedRoot(root, (rootDescriptor) => {
    const path = join(root.canonicalPath, filename);
    let metadata: Stats;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
    assertSecureLeaf(path, metadata);
    assertRootStillBound(root);
    unlinkSync(path);
    fsyncSync(rootDescriptor);
    return true;
  });
}

const HARNESS_OWNED_JUDGE_EGRESS_AUDITS =
  new WeakSet<JudgeEgressAuditPort>();
const HARNESS_OWNED_EGRESS_AUTHORIZATION_AUDITS =
  new WeakSet<EgressAuthorizationAuditPort>();
const HARNESS_OWNED_REFERENCE_PACK_STORES =
  new WeakSet<ReferencePackStorePort>();

export class FileSystemArtifactCaptureJournal
  implements ArtifactCaptureJournalPort
{
  readonly durability = "durable" as const;
  readonly journalId: string;
  readonly #root: OperationalRootIdentity;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly journalId: string;
    readonly rootPath: string;
  }) {
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(options.journalId)) {
      throw new Error("Durable Artifact capture journal ID is invalid");
    }
    this.journalId = options.journalId;
    this.#root = safeRoot(options.rootPath);
  }

  async #exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  async beginAttempt(input: {
    readonly jobId: string;
    readonly artifactId: string;
    readonly detail: string;
  }): Promise<string> {
    return await this.#exclusive(() => {
      const attemptNumber =
        this.#events().filter(
          (event) =>
            event.eventType === "started" &&
            event.jobId === input.jobId &&
            event.artifactId === input.artifactId,
        ).length + 1;
      const captureAttemptId =
        `artifact-capture-attempt:${this.journalId}:${input.jobId}:${input.artifactId}:${attemptNumber}`;
      this.#append({
        eventId: `${captureAttemptId}:started`,
        captureAttemptId,
        jobId: input.jobId,
        artifactId: input.artifactId,
        eventType: "started",
        storeId: null,
        key: null,
        detail: input.detail,
      });
      return captureAttemptId;
    });
  }

  async append(event: ArtifactCaptureJournalEvent): Promise<void> {
    await this.#exclusive(() => this.#append(event));
  }

  #append(event: ArtifactCaptureJournalEvent): void {
    immutableJsonWrite(
      this.#root,
      `${sha256(event.eventId)}.json`,
      event,
    );
  }

  #events(): readonly ArtifactCaptureJournalEvent[] {
    return readJsonFiles<ArtifactCaptureJournalEvent>(this.#root);
  }

  async verifyCompletedAttempt(input: {
    readonly captureAttemptId: string;
    readonly jobId: string;
    readonly artifactId: string;
    readonly expectedWrites: readonly {
      readonly storeId: string;
      readonly key: string;
      readonly contentHash: `sha256:${string}`;
    }[];
  }): Promise<void> {
    await this.#exclusive(() => {
      const events = this.#events()
        .filter(
          (event) =>
            event.captureAttemptId === input.captureAttemptId &&
            event.jobId === input.jobId &&
            event.artifactId === input.artifactId,
        )
        .sort((left, right) =>
          left.eventId.localeCompare(right.eventId),
        );
      const started = events.find(({ eventType }) => eventType === "started");
      const completed = events.find(
        ({ eventType }) => eventType === "completed",
      );
      const writes = events.filter(
        ({ eventType }) => eventType === "write_verified",
      );
      const expected = new Set(
        input.expectedWrites.map(
          (write) =>
            `${write.storeId}\u0000${write.key}\u0000${write.contentHash}`,
        ),
      );
      if (
        started?.detail !== `planned:${input.expectedWrites.length}` ||
        completed?.detail !== `verified:${input.expectedWrites.length}` ||
        writes.length !== expected.size ||
        writes.some(
          (write) =>
            write.storeId === null ||
            write.key === null ||
            !expected.has(
              `${write.storeId}\u0000${write.key}\u0000${write.detail}`,
            ),
        )
      ) {
        throw new Error(
          `Artifact capture journal trace is incomplete: ${input.captureAttemptId}`,
        );
      }
    });
  }
}

export class FileSystemEgressAuthorizationAudit
  implements EgressAuthorizationAuditPort
{
  readonly durability = "durable" as const;
  readonly auditId: string;
  readonly #root: OperationalRootIdentity;

  constructor(options: {
    readonly auditId: string;
    readonly rootPath: string;
  }) {
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(options.auditId)) {
      throw new Error("Durable egress authorization audit ID is invalid");
    }
    this.auditId = options.auditId;
    this.#root = safeRoot(options.rootPath);
  }

  async append(decision: ApprovedEgressAuthorization): Promise<void> {
    immutableJsonWrite(
      this.#root,
      `${sha256(decision.decisionId)}.json`,
      decision,
    );
  }

  async assertRecorded(
    decision: ApprovedEgressAuthorization,
  ): Promise<void> {
    const filename = `${sha256(decision.decisionId)}.json`;
    let value: unknown;
    try {
      value = secureJsonRead(this.#root, filename);
    } catch (error) {
      throw new Error(
        `Durable egress authorization audit is missing: ${decision.decisionId}`,
        { cause: error },
      );
    }
    if (!isDeepStrictEqual(value, decision)) {
      throw new Error(
        `Durable egress authorization audit conflict: ${decision.decisionId}`,
      );
    }
  }
}

export function assertHarnessOwnedDurableEgressAuthorizationAudit(
  audit: EgressAuthorizationAuditPort,
): void {
  if (!HARNESS_OWNED_EGRESS_AUTHORIZATION_AUDITS.has(audit)) {
    throw new Error(
      "Production Bakeoff requires a harness-owned durable egress authorization audit",
    );
  }
}

export class FileSystemJudgeEgressAudit
  implements JudgeEgressAuditPort
{
  readonly durability = "durable" as const;
  readonly auditId: string;
  readonly #root: OperationalRootIdentity;

  constructor(options: {
    readonly auditId: string;
    readonly rootPath: string;
  }) {
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(options.auditId)) {
      throw new Error("Durable Judge egress audit ID is invalid");
    }
    this.auditId = options.auditId;
    this.#root = safeRoot(options.rootPath);
  }

  async recordAuthorizedAttempt(
    audit: JudgeEgressAttemptAudit,
  ): Promise<void> {
    immutableJsonWrite(
      this.#root,
      `${sha256(`${audit.attemptId}\u0000${audit.idempotencyKey}`)}.json`,
      audit,
    );
  }
}

export function assertHarnessOwnedDurableJudgeEgressAudit(
  audit: JudgeEgressAuditPort,
): void {
  if (!HARNESS_OWNED_JUDGE_EGRESS_AUDITS.has(audit)) {
    throw new Error(
      "Production Codex CLI Judge requires a harness-owned durable egress attempt audit",
    );
  }
}

export class FileSystemReferencePackStore
  implements ReferencePackStorePort
{
  readonly durability = "durable" as const;
  readonly #temporaryRoot: OperationalRootIdentity;
  readonly #usedRoot: OperationalRootIdentity;
  readonly #now: () => string;

  constructor(options: {
    readonly rootPath: string;
    readonly now?: () => string;
  }) {
    const root = safeRoot(options.rootPath);
    this.#temporaryRoot = safeRoot(join(root.canonicalPath, "temporary"));
    this.#usedRoot = safeRoot(join(root.canonicalPath, "used"));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  stage(
    pack: ReferencePack,
    input: { readonly jobId: string },
  ): StagedReferencePack {
    const stagingId =
      `temporary:${input.jobId}:${pack.contentHash}`;
    const staged = { stagingId, pack };
    immutableJsonWrite(
      this.#temporaryRoot,
      `${sha256(stagingId)}.json`,
      staged,
    );
    return Object.freeze(staged);
  }

  retainUsed(
    stagingId: string,
    input: {
      readonly jobId: string;
      readonly scorecardIds: readonly string[];
      readonly evaluationAttemptIds: readonly string[];
    },
  ): UsedReferencePackRecord {
    const existing = readJsonFiles<UsedReferencePackRecord>(
      this.#usedRoot,
    ).find((candidate) => candidate.stagingId === stagingId);
    if (existing !== undefined) {
      if (
        existing.jobId !== input.jobId ||
        !isDeepStrictEqual(existing.scorecardIds, input.scorecardIds) ||
        !isDeepStrictEqual(
          existing.evaluationAttemptIds,
          input.evaluationAttemptIds,
        )
      ) {
        throw new Error(
          `Durable Reference Pack usage conflict: ${stagingId}`,
        );
      }
      secureRemove(this.#temporaryRoot, `${sha256(stagingId)}.json`);
      return Object.freeze(existing);
    }
    if (input.evaluationAttemptIds.length === 0) {
      throw new Error(
        "A used Reference Pack requires at least one evaluation attempt",
      );
    }
    const filename = `${sha256(stagingId)}.json`;
    let staged: StagedReferencePack;
    try {
      staged = secureJsonRead<StagedReferencePack>(
        this.#temporaryRoot,
        filename,
      );
    } catch (error) {
      throw new Error(`Temporary Reference Pack not found: ${stagingId}`, {
        cause: error,
      });
    }
    const record = Object.freeze({
      recordId:
        `reference-pack-usage:${input.jobId}:${staged.pack.contentHash}`,
      stagingId,
      jobId: input.jobId,
      pack: staged.pack,
      scorecardIds: Object.freeze([...input.scorecardIds]),
      evaluationAttemptIds: Object.freeze([
        ...input.evaluationAttemptIds,
      ]),
      usedAt: this.#now(),
    });
    immutableJsonWrite(
      this.#usedRoot,
      `${sha256(record.recordId)}.json`,
      record,
    );
    secureRemove(this.#temporaryRoot, filename);
    return record;
  }

  deleteUnused(stagingId: string): boolean {
    return secureRemove(
      this.#temporaryRoot,
      `${sha256(stagingId)}.json`,
    );
  }
}

export function assertHarnessOwnedDurableReferencePackStore(
  store: ReferencePackStorePort,
): void {
  if (!HARNESS_OWNED_REFERENCE_PACK_STORES.has(store)) {
    throw new Error(
      "Production Bakeoff requires a harness-owned durable Reference Pack store",
    );
  }
}

// Package-internal production assembly seam. These factories are deliberately
// not re-exported from index.ts: public filesystem constructors create durable
// objects, but only the harness assembly path may attach production ownership.
export function createHarnessOwnedFileSystemEgressAuthorizationAudit(
  options: ConstructorParameters<
    typeof FileSystemEgressAuthorizationAudit
  >[0],
): FileSystemEgressAuthorizationAudit {
  const audit = new FileSystemEgressAuthorizationAudit(options);
  HARNESS_OWNED_EGRESS_AUTHORIZATION_AUDITS.add(audit);
  return audit;
}

export function createHarnessOwnedFileSystemJudgeEgressAudit(
  options: ConstructorParameters<typeof FileSystemJudgeEgressAudit>[0],
): FileSystemJudgeEgressAudit {
  const audit = new FileSystemJudgeEgressAudit(options);
  HARNESS_OWNED_JUDGE_EGRESS_AUDITS.add(audit);
  return audit;
}

export function createHarnessOwnedFileSystemReferencePackStore(
  options: ConstructorParameters<typeof FileSystemReferencePackStore>[0],
): FileSystemReferencePackStore {
  const store = new FileSystemReferencePackStore(options);
  HARNESS_OWNED_REFERENCE_PACK_STORES.add(store);
  return store;
}
