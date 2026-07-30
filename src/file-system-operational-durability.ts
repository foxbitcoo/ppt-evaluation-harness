import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";

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

function safeRoot(rootPath: string): string {
  const root = resolve(rootPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function immutableJsonWrite(path: string, value: unknown): void {
  const content = JSON.stringify(value);
  const temporaryPath =
    `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error: unknown) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw error;
    }
    if (!isDeepStrictEqual(existing, value)) {
      throw new Error(`Durable immutable JSON conflict: ${path}`, {
        cause: error,
      });
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
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
}

function readJsonFiles<T>(root: string): readonly T[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(root, name), "utf8")) as T);
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
  readonly #root: string;
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
      join(this.#root, `${sha256(event.eventId)}.json`),
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
  readonly #root: string;

  constructor(options: {
    readonly auditId: string;
    readonly rootPath: string;
  }) {
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(options.auditId)) {
      throw new Error("Durable egress authorization audit ID is invalid");
    }
    this.auditId = options.auditId;
    this.#root = safeRoot(options.rootPath);
    HARNESS_OWNED_EGRESS_AUTHORIZATION_AUDITS.add(this);
  }

  async append(decision: ApprovedEgressAuthorization): Promise<void> {
    immutableJsonWrite(
      join(this.#root, `${sha256(decision.decisionId)}.json`),
      decision,
    );
  }

  async assertRecorded(
    decision: ApprovedEgressAuthorization,
  ): Promise<void> {
    const path = join(
      this.#root,
      `${sha256(decision.decisionId)}.json`,
    );
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
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
  readonly #root: string;

  constructor(options: {
    readonly auditId: string;
    readonly rootPath: string;
  }) {
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(options.auditId)) {
      throw new Error("Durable Judge egress audit ID is invalid");
    }
    this.auditId = options.auditId;
    this.#root = safeRoot(options.rootPath);
    HARNESS_OWNED_JUDGE_EGRESS_AUDITS.add(this);
  }

  async recordAuthorizedAttempt(
    audit: JudgeEgressAttemptAudit,
  ): Promise<void> {
    immutableJsonWrite(
      join(
        this.#root,
        `${sha256(`${audit.attemptId}\u0000${audit.idempotencyKey}`)}.json`,
      ),
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
  readonly #temporaryRoot: string;
  readonly #usedRoot: string;
  readonly #now: () => string;

  constructor(options: {
    readonly rootPath: string;
    readonly now?: () => string;
  }) {
    const root = safeRoot(options.rootPath);
    this.#temporaryRoot = safeRoot(join(root, "temporary"));
    this.#usedRoot = safeRoot(join(root, "used"));
    this.#now = options.now ?? (() => new Date().toISOString());
    HARNESS_OWNED_REFERENCE_PACK_STORES.add(this);
  }

  stage(
    pack: ReferencePack,
    input: { readonly jobId: string },
  ): StagedReferencePack {
    const stagingId =
      `temporary:${input.jobId}:${pack.contentHash}`;
    const staged = { stagingId, pack };
    immutableJsonWrite(
      join(this.#temporaryRoot, `${sha256(stagingId)}.json`),
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
      rmSync(
        join(this.#temporaryRoot, `${sha256(stagingId)}.json`),
        { force: true },
      );
      return Object.freeze(existing);
    }
    if (input.evaluationAttemptIds.length === 0) {
      throw new Error(
        "A used Reference Pack requires at least one evaluation attempt",
      );
    }
    const path = join(
      this.#temporaryRoot,
      `${sha256(stagingId)}.json`,
    );
    let staged: StagedReferencePack;
    try {
      staged = JSON.parse(
        readFileSync(path, "utf8"),
      ) as StagedReferencePack;
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
      join(this.#usedRoot, `${sha256(record.recordId)}.json`),
      record,
    );
    rmSync(path, { force: true });
    return record;
  }

  deleteUnused(stagingId: string): boolean {
    const path = join(
      this.#temporaryRoot,
      `${sha256(stagingId)}.json`,
    );
    try {
      rmSync(path);
      return true;
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
