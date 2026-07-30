import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type {
  FeishuReport,
  RunRecord,
} from "./domain.ts";
import {
  InMemoryFeishuProjection,
  type FeishuProjectionSnapshot,
} from "./feishu.ts";
import type {
  ApprovedEgressAuthorization,
  EgressDestinationMetadata,
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
  preflight(options?: {
    readonly requireReportDocument?: boolean;
  }): Promise<void>;
  upsertRecord(command: {
    readonly tableKey: LarkProjectionTableKey;
    readonly stableId: string;
    readonly payload: string;
    readonly payloadHash: `sha256:${string}`;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly remoteRecordId: string;
    readonly recordUrl: string;
  }>;
  uploadAttachment(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
    readonly stableId: string;
    readonly attachmentRole: string;
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentHash: `sha256:${string}`;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly fileToken: string;
    readonly remoteHash: `sha256:${string}`;
    readonly attachmentUrl: string;
  }>;
  downloadAttachment(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
    readonly fileToken: string;
    /**
     * Test transports may use this immutable expected value. Verified
     * production transports always download through lark-cli.
     */
    readonly expectedContent: Uint8Array;
  }): Promise<Uint8Array>;
  upsertReport(command: {
    readonly reportId: string;
    readonly title: string;
    readonly markdown: string;
    readonly payloadHash: `sha256:${string}`;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly url: string;
    readonly remoteContentHash: `sha256:${string}`;
  }>;
  readCommitMarker(command: {
    readonly jobId: string;
  }): Promise<{
    readonly batchHash: `sha256:${string}`;
    readonly reportUrls: readonly {
      readonly reportId: string;
      readonly url: string;
    }[];
  } | null>;
  commitBatch(command: {
    readonly jobId: string;
    readonly batchHash: `sha256:${string}`;
    readonly authorizationDecisionId: string;
    readonly recordCount: number;
    readonly attachmentCount: number;
    readonly reportUrls: readonly {
      readonly reportId: string;
      readonly url: string;
    }[];
    readonly committedAt: string;
  }): Promise<void>;
}

const VERIFIED_LARK_TRANSPORTS =
  new WeakSet<LarkBaseProjectionTransportPort>();
const HARNESS_OWNED_LARK_PROJECTIONS =
  new WeakMap<object, LarkBaseProjectionTransportPort>();

export const FROZEN_LARK_CLI_BINARY =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/lark-cli";
export const FROZEN_LARK_CLI_SHA256 =
  "sha256:b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577" as const;

export interface LarkCliProjectionConfiguration {
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
   * A production resolver must turn stable Artifact/page identities and
   * attachment tokens into readable evidence. A Base URL alone is not a
   * resolver and is rejected by preflight.
   */
  readonly pageEvidenceBaseUrl: string;
  readonly pageEvidenceResolverHealthUrl: string;
  /**
   * Production report delivery updates one pre-provisioned Docx document.
   * Provisioning that document is an explicit external readiness gate.
   */
  readonly reportDocumentTokenEnvironmentVariable: string;
  readonly reportDocumentExpectedOrigin: string;
  readonly targetAccount: string;
  readonly targetRegion: string;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

class LarkBaseProjection extends InMemoryFeishuProjection {
  readonly #transport: LarkBaseProjectionTransportPort;
  #materializationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly transport: LarkBaseProjectionTransportPort;
    readonly targetEnvironment: "test" | "production";
    readonly destination: EgressDestinationMetadata;
  }) {
    super({
      targetEnvironment: options.targetEnvironment,
      egressDestination: options.destination,
    });
    this.#transport = options.transport;
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

  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
    authorization: ApprovedEgressAuthorization,
  ): Promise<FeishuProjectionSnapshot> {
    const previous = this.#materializationTail;
    let release = () => {};
    this.#materializationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      await this.#transport.preflight({
        requireReportDocument: snapshot.reports.length > 0,
      });
      const batchHash = sha256Bytes(canonicalJsonBytes(snapshot));
      const jobId =
        snapshot.runRecordTable.find(
          ({ recordType }) => recordType === "bakeoff_job",
        )?.jobId;
      if (jobId === undefined) {
        throw new Error("Lark Base projection batch has no Bakeoff Job");
      }
      const existingMarker =
        await this.#transport.readCommitMarker({ jobId });
      if (
        existingMarker !== null &&
        existingMarker.batchHash !== batchHash
      ) {
        throw new Error(
          `Lark Base commit marker conflict for ${jobId}`,
        );
      }
      if (existingMarker !== null) {
        return withMaterializedReportUrls(
          snapshot,
          new Map(
            existingMarker.reportUrls.map(({ reportId, url }) => [
              reportId,
              url,
            ]),
          ),
        );
      }

      const remoteRecords = new Map<string, string>();
      const rows = tableRows(snapshot);
      for (const { tableKey, value } of rows) {
        const stableId = stableRecordId(tableKey, value);
        const payload = JSON.stringify(sanitizedPayload(value));
        const payloadHash = sha256(payload);
        const remote = await this.#transport.upsertRecord({
          tableKey,
          stableId,
          payload,
          payloadHash,
          idempotencyKey:
            `lark-record:${tableKey}:${stableId}:${payloadHash}`,
        });
        assertHttps(remote.recordUrl, "Lark Base record");
        remoteRecords.set(`${tableKey}:${stableId}`, remote.remoteRecordId);
      }

      let attachmentCount = 0;
      for (const capture of snapshot.capturedArtifactTable) {
        const remoteRecordId = remoteRecords.get(
          `artifacts:${capture.recordId}`,
        );
        if (remoteRecordId === undefined) {
          throw new Error(
            `Lark Base Artifact row is missing: ${capture.recordId}`,
          );
        }
        const derivatives = [
          {
            role: "original",
            filename: capture.artifact.filename,
            content: capture.artifact.content,
            contentHash: capture.artifact.contentHash,
          },
          ...capture.renderManifest.slides.map((slide) => ({
            role: `page-${slide.pageNumber}`,
            filename: slide.filename,
            content:
              typeof slide.content === "string"
                ? new TextEncoder().encode(slide.content)
                : slide.content,
            contentHash: slide.contentHash,
          })),
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
        for (const derivative of derivatives) {
          const upload = await this.#transport.uploadAttachment({
            tableKey: "artifacts",
            remoteRecordId,
            stableId: capture.recordId,
            attachmentRole: derivative.role,
            filename: derivative.filename,
            content: derivative.content,
            contentHash: derivative.contentHash,
            idempotencyKey:
              `lark-attachment:${capture.recordId}:${derivative.role}:${derivative.contentHash}`,
          });
          assertHttps(upload.attachmentUrl, "Lark Base attachment");
          if (upload.remoteHash !== derivative.contentHash) {
            throw new Error(
              `Lark Base attachment upload hash mismatch: ${derivative.role}`,
            );
          }
          const downloaded =
            await this.#transport.downloadAttachment({
              tableKey: "artifacts",
              remoteRecordId,
              fileToken: upload.fileToken,
              expectedContent: derivative.content,
            });
          if (sha256(downloaded) !== derivative.contentHash) {
            throw new Error(
              `Lark Base attachment download hash mismatch: ${derivative.role}`,
            );
          }
          attachmentCount += 1;
        }
      }

      const reportUrls = new Map<string, string>();
      for (const report of snapshot.reports) {
        const payloadHash = sha256(
          JSON.stringify({
            reportId: report.reportId,
            title: report.title,
            markdown: report.markdown,
          }),
        );
        const result = await this.#transport.upsertReport({
          reportId: report.reportId,
          title: report.title,
          markdown: report.markdown,
          payloadHash,
          idempotencyKey:
            `lark-report:${report.reportId}:${payloadHash}`,
        });
        assertHttps(result.url, "Lark report");
        if (!/^sha256:[a-f0-9]{64}$/.test(result.remoteContentHash)) {
          throw new Error("Lark report readback hash is invalid");
        }
        reportUrls.set(report.reportId, result.url);
      }

      const reportUrlEntries = [...reportUrls].map(
        ([reportId, url]) => ({ reportId, url }),
      );
      await this.#transport.commitBatch({
        jobId,
        batchHash,
        authorizationDecisionId: authorization.decisionId,
        recordCount: rows.length,
        attachmentCount,
        reportUrls: reportUrlEntries,
        committedAt:
          snapshot.runRecordTable.find(
            ({ recordType }) => recordType === "bakeoff_job",
          )?.createdAt ?? authorization.request.requestedAt,
      });
      return withMaterializedReportUrls(snapshot, reportUrls);
    } finally {
      release();
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
}): InMemoryFeishuProjection {
  return new LarkBaseProjection({
    transport: options.transport,
    targetEnvironment: options.targetEnvironment ?? "test",
    destination: larkDestination(
      options.targetEnvironment ?? "test",
      "test-lark-account",
      "test",
    ),
  });
}

export function createHarnessOwnedLarkBaseProjection(options: {
  readonly transport: LarkBaseProjectionTransportPort;
  readonly targetAccount: string;
  readonly targetRegion: string;
}): InMemoryFeishuProjection {
  if (!VERIFIED_LARK_TRANSPORTS.has(options.transport)) {
    throw new Error(
      "Production Lark Base projection requires the verified fixed lark-cli transport",
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

function collectStrings(value: unknown): readonly string[] {
  const strings: string[] = [];
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      strings.push(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const entry of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate)) {
      visit(entry);
    }
  };
  visit(value);
  return strings;
}

class VerifiedLarkCliTransport
  implements LarkBaseProjectionTransportPort
{
  readonly transportId: string;
  readonly pageEvidenceBaseUrl: string;
  readonly #configuration: LarkCliProjectionConfiguration;
  readonly #binaryPath: string;

  constructor(
    binaryPath: string,
    configuration: LarkCliProjectionConfiguration,
  ) {
    this.#binaryPath = binaryPath;
    this.#configuration = Object.freeze({
      ...configuration,
      tables: Object.freeze({ ...configuration.tables }),
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
    options: {
      readonly cwd?: string;
    } = {},
  ): Promise<unknown> {
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      const child = spawn(this.#binaryPath, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      });
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
    const value =
      process.env[
        this.#configuration.reportDocumentTokenEnvironmentVariable
      ];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(
        `Lark report document ${this.#configuration.reportDocumentTokenEnvironmentVariable} is unavailable`,
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

  #reportDocumentUrl(
    response: unknown,
    reportToken: string,
  ): string {
    const candidates = [
      ...new Set(
        collectStrings(response).filter((value) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              url.origin ===
                this.#configuration.reportDocumentExpectedOrigin &&
              url.pathname.split("/").includes(reportToken)
            );
          } catch {
            return false;
          }
        }),
      ),
    ];
    if (candidates.length !== 1) {
      throw new Error(
        "lark-cli report readback returned no unique trusted Docx URL",
      );
    }
    const url = new URL(candidates[0]!);
    if (!/^\/docx\/[a-zA-Z0-9_-]{8,128}\/?$/.test(url.pathname)) {
      throw new Error(
        "lark-cli report readback URL is not the configured Docx",
      );
    }
    return url.toString();
  }

  async preflight(
    options: {
      readonly requireReportDocument?: boolean;
    } = {},
  ): Promise<void> {
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
    if (!baseWebUrl.pathname.split("/").includes(baseToken)) {
      throw new Error(
        "Lark Base web URL is not bound to the configured Base token",
      );
    }
    const identity = await this.#run(["whoami"]);
    const identityRecord =
      identity !== null && typeof identity === "object"
        ? (identity as Record<string, unknown>)
        : {};
    if (
      identityRecord.available !== true ||
      identityRecord.identity !== "user"
    ) {
      throw new Error(
        "lark-cli production preflight requires a ready user identity",
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
      const resolverResponse = await fetch(
        this.#configuration.pageEvidenceResolverHealthUrl,
        {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
        },
      );
      if (!resolverResponse.ok) {
        throw new Error(
          "Lark page-evidence resolver preflight is not ready",
        );
      }
      const resolverEvidence = await resolverResponse.json() as unknown;
      if (
        resolverEvidence === null ||
        typeof resolverEvidence !== "object" ||
        (resolverEvidence as Record<string, unknown>).service !==
          "ppt-evaluation-evidence-resolver" ||
        (resolverEvidence as Record<string, unknown>).status !== "ready"
      ) {
        throw new Error(
          "Lark page-evidence resolver returned invalid readiness evidence",
        );
      }
      const reportToken = this.#reportDocumentToken();
      const reportReadback = await this.#run([
        "docs",
        "+fetch",
        "--doc",
        reportToken,
        "--scope",
        "outline",
        "--max-depth",
        "0",
        "--format",
        "json",
        "--as",
        "user",
      ]);
      this.#reportDocumentUrl(reportReadback, reportToken);
    }
  }

  async #findRecord(
    tableKey: LarkProjectionTableKey,
    stableId: string,
  ): Promise<Record<string, unknown> | null> {
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
      "2",
      "--format",
      "json",
      "--as",
      "user",
    ]);
    const matches = collectRecords(response).filter((record) => {
      const fields =
        record.fields !== null && typeof record.fields === "object"
          ? (record.fields as Record<string, unknown>)
          : record;
      return fields[this.#configuration.stableIdField] === stableId;
    });
    if (matches.length > 1) {
      throw new Error(
        `Lark Base stable identity has duplicate records: ${stableId}`,
      );
    }
    return matches[0] ?? null;
  }

  async upsertRecord(
    command: Parameters<LarkBaseProjectionTransportPort["upsertRecord"]>[0],
  ): Promise<{
    readonly remoteRecordId: string;
    readonly recordUrl: string;
  }> {
    const existing = await this.#findRecord(
      command.tableKey,
      command.stableId,
    );
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
    const response = await this.#run([
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
    ]);
    const resultRecord = collectRecords(response).find(
      (record) =>
        typeof record.record_id === "string" ||
        typeof record.recordId === "string",
    );
    const remoteRecordId =
      recordId ??
      (typeof resultRecord?.record_id === "string"
        ? resultRecord.record_id
        : typeof resultRecord?.recordId === "string"
          ? resultRecord.recordId
          : null);
    if (remoteRecordId === null) {
      throw new Error("lark-cli record upsert returned no record ID");
    }
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
    if (sha256(command.content) !== command.contentHash) {
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
    const directory = await mkdtemp(join(tmpdir(), "ppt-lark-upload-"));
    const path = join(directory, filename);
    try {
      await writeFile(path, command.content, { mode: 0o600 });
      const response = await this.#run([
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
      ], { cwd: directory });
      const token = collectRecords(response)
        .map((record) => record.file_token ?? record.fileToken)
        .find((value): value is string => typeof value === "string");
      if (token === undefined) {
        throw new Error("lark-cli attachment upload returned no file token");
      }
      return {
        fileToken: token,
        remoteHash: sha256(Uint8Array.from(await readFile(path))),
        attachmentUrl:
          `${this.pageEvidenceBaseUrl}/attachments/${encodeURIComponent(token)}`,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async downloadAttachment(
    command: Parameters<LarkBaseProjectionTransportPort["downloadAttachment"]>[0],
  ): Promise<Uint8Array> {
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

  async upsertReport(
    command: Parameters<LarkBaseProjectionTransportPort["upsertReport"]>[0],
  ): Promise<{
    readonly url: string;
    readonly remoteContentHash: `sha256:${string}`;
  }> {
    const reportToken = this.#reportDocumentToken();
    const directory = await mkdtemp(join(tmpdir(), "ppt-lark-report-"));
    const filename = "report.md";
    const content =
      `${command.markdown.trimEnd()}\n\n---\n` +
      `Report evidence ID: ${command.reportId}\n\n` +
      `Projection payload hash: ${command.payloadHash}\n`;
    try {
      await writeFile(join(directory, filename), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      const update = await this.#run([
        "docs",
        "+update",
        "--doc",
        reportToken,
        "--command",
        "overwrite",
        "--doc-format",
        "markdown",
        "--content",
        `@${filename}`,
        "--format",
        "json",
        "--as",
        "user",
      ], { cwd: directory });
      if (
        JSON.stringify(update).includes('"partial_success"') ||
        JSON.stringify(update).includes('"failed"')
      ) {
        throw new Error("Lark report update was not fully successful");
      }
      const fetched = await this.#run([
        "docs",
        "+fetch",
        "--doc",
        reportToken,
        "--doc-format",
        "markdown",
        "--scope",
        "full",
        "--format",
        "json",
        "--as",
        "user",
      ]);
      const remoteText = JSON.stringify(fetched);
      if (
        !remoteText.includes(command.reportId) ||
        !remoteText.includes(command.payloadHash)
      ) {
        throw new Error(
          "Lark report readback is not bound to the projected report",
        );
      }
      return {
        url: this.#reportDocumentUrl(fetched, reportToken),
        remoteContentHash: sha256(remoteText),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async readCommitMarker(
    command: Parameters<LarkBaseProjectionTransportPort["readCommitMarker"]>[0],
  ): Promise<{
    readonly batchHash: `sha256:${string}`;
    readonly reportUrls: readonly {
      readonly reportId: string;
      readonly url: string;
    }[];
  } | null> {
    const record = await this.#findRecord(
      "commit_markers",
      command.jobId,
    );
    if (record === null) return null;
    const fields =
      record.fields !== null && typeof record.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : record;
    const value = fields[this.#configuration.payloadHashField];
    if (
      typeof value !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value)
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
    const marker =
      parsedPayload !== null && typeof parsedPayload === "object"
        ? (parsedPayload as Record<string, unknown>)
        : {};
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
      return Object.freeze({
        reportId: record.reportId,
        url: record.url,
      });
    });
    if (
      new Set(parsedReportUrls.map(({ reportId }) => reportId)).size !==
      parsedReportUrls.length
    ) {
      throw new Error("Lark Base commit marker has duplicate report IDs");
    }
    return {
      batchHash: value as `sha256:${string}`,
      reportUrls: parsedReportUrls,
    };
  }

  async commitBatch(
    command: Parameters<LarkBaseProjectionTransportPort["commitBatch"]>[0],
  ): Promise<void> {
    await this.upsertRecord({
      tableKey: "commit_markers",
      stableId: command.jobId,
      payload: JSON.stringify(command),
      payloadHash: command.batchHash,
      idempotencyKey:
        `lark-commit:${command.jobId}:${command.batchHash}`,
    });
  }
}

export async function createVerifiedLarkCliTransport(options: {
  readonly configuration: LarkCliProjectionConfiguration;
}): Promise<LarkBaseProjectionTransportPort> {
  const binaryPath = resolve(FROZEN_LARK_CLI_BINARY);
  const actualHash = sha256(Uint8Array.from(await readFile(binaryPath)));
  if (actualHash !== FROZEN_LARK_CLI_SHA256) {
    throw new Error(
      "Fixed lark-cli binary hash does not match the reviewed executable",
    );
  }
  for (const [label, value] of Object.entries({
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
  assertHttps(
    options.configuration.pageEvidenceResolverHealthUrl,
    "Lark page evidence resolver health",
  );
  assertHttpsBase(
    options.configuration.baseWebUrl,
    "Lark Base web URL",
  );
  assertHttpsBase(
    options.configuration.reportDocumentExpectedOrigin,
    "Lark report document expected origin",
  );
  const transport = new VerifiedLarkCliTransport(
    binaryPath,
    options.configuration,
  );
  VERIFIED_LARK_TRANSPORTS.add(transport);
  return transport;
}
