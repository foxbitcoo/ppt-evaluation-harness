import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import type {
  FeishuReport,
  RunRecord,
} from "./domain.ts";
import {
  InMemoryFeishuProjection,
  type FeishuProjectionPort,
  type FeishuProjectionSnapshot,
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
  createRecordShareLink(command: {
    readonly tableKey: "artifacts";
    readonly remoteRecordId: string;
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
  }): Promise<void>;
  upsertReportCollection(command: {
    readonly reports: readonly {
      readonly reportId: string;
      readonly title: string;
      readonly markdown: string;
      readonly payloadHash: `sha256:${string}`;
    }[];
    readonly collectionHash: `sha256:${string}`;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly url: string;
    readonly remoteContentHash: `sha256:${string}`;
  }>;
  verifyReportCollection(command: {
    readonly reports: readonly {
      readonly reportId: string;
      readonly title: string;
      readonly markdown: string;
      readonly payloadHash: `sha256:${string}`;
    }[];
    readonly collectionHash: `sha256:${string}`;
    readonly expectedUrl: string;
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
    readonly authorizationDecisionId: string;
    readonly claimedAt: string;
  }): Promise<"claimed" | "already_claimed">;
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
    readonly pageEvidenceUrls: readonly {
      readonly artifactId: string;
      readonly pageNumber: number;
      readonly url: string;
    }[];
    readonly committedAt: string;
    readonly previousBatchHash: `sha256:${string}` | null;
    readonly revision: number;
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
  readonly pageEvidenceUrls: readonly {
    readonly artifactId: string;
    readonly pageNumber: number;
    readonly url: string;
  }[];
  readonly committedAt: string;
  readonly previousBatchHash: `sha256:${string}` | null;
  readonly revision: number;
}

export interface ProductionJobRemoteState {
  readonly state:
    | "absent"
    | "committed"
    | "job_record_present"
    | "vendor_run_present";
  readonly marker: LarkCommitMarker | null;
  readonly observedStableIds: readonly string[];
}

const VERIFIED_LARK_TRANSPORTS =
  new WeakSet<LarkBaseProjectionTransportPort>();
const HARNESS_OWNED_LARK_PROJECTIONS =
  new WeakMap<object, LarkBaseProjectionTransportPort>();

export const FROZEN_LARK_CLI_BINARY =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/lark-cli";
export const FROZEN_LARK_CLI_SHA256 =
  "sha256:b6b575a31d62ea45f55155f1090a49d31e79a1b0e5c70af15f9431ab850ca577" as const;
export const FROZEN_LARK_NODE_BINARY =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/bin/node";
export const FROZEN_LARK_NODE_SHA256 =
  "sha256:1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8" as const;
export const FROZEN_LARK_CLI_SCRIPT =
  "/Users/chenyifan/.local/node-v24.16.0-darwin-arm64/lib/node_modules/@larksuite/cli/scripts/run.js";

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

export function createLarkReportCollectionMarkdown(command: {
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
  const replacements = [...pageEvidenceUrls].map(([key, url]) => {
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
    return [placeholderFor(artifactId, pageNumber), url] as const;
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
      const jobId =
        snapshot.runRecordTable.find(
          ({ recordType }) => recordType === "bakeoff_job",
        )?.jobId;
      if (jobId === undefined) {
        throw new Error("Lark Base projection batch has no Bakeoff Job");
      }
      const rows = tableRows(snapshot);
      const expectedPageEvidence =
        expectedPageEvidenceIdentities(snapshot);
      const expectedAttachmentCount =
        snapshot.capturedArtifactTable.reduce(
          (count, capture) =>
            count + capture.renderManifest.slides.length + 2,
          0,
        );
      const existingMarker =
        await this.#transport.readCommitMarker({ jobId });
      assertAuthorizationCurrent();
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
          if (
            existingMarker.recordCount !==
              rows.length + expectedPageEvidence.length ||
            existingMarker.attachmentCount !==
              expectedAttachmentCount ||
            !isDeepStrictEqual(markerReportIds, expectedReportIds) ||
            !isDeepStrictEqual(
              markerPageEvidenceKeys,
              expectedPageEvidenceKeys,
            )
          ) {
            throw new Error(
              `Lark Base commit marker counts or reports conflict for ${jobId}`,
            );
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
                  `${capture.artifactId}:page:${slide.pageNumber}`,
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
              reports: replayReportCollection,
              collectionHash: replayReportCollectionHash,
              expectedUrl: [...reportDocumentUrls][0]!,
            });
            assertAuthorizationCurrent();
          }
          return withMaterializedReportUrls(
            pageMaterialized,
            new Map(
              existingMarker.reportUrls.map(({ reportId, url }) => [
                reportId,
                url,
              ]),
            ),
          );
        }
      }

      const remoteRecords = new Map<string, string>();
      for (const { tableKey, value } of rows) {
        assertAuthorizationCurrent();
        const stableId = stableRecordId(tableKey, value);
        const { payload, payloadHash } = serializedRow(value);
        const remote = await this.#transport.upsertRecord({
          tableKey,
          stableId,
          payload,
          payloadHash,
          idempotencyKey:
            `lark-record:${tableKey}:${stableId}:${payloadHash}`,
        });
        assertAuthorizationCurrent();
        assertHttps(remote.recordUrl, "Lark Base record");
        remoteRecords.set(`${tableKey}:${stableId}`, remote.remoteRecordId);
      }

      let attachmentCount = 0;
      const pageEvidenceUrls = new Map<string, string>();
      for (const capture of snapshot.capturedArtifactTable) {
        const remoteRecordId = remoteRecords.get(
          `artifacts:${capture.recordId}`,
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
            stableId: capture.recordId,
            attachmentRole: derivative.role,
            filename: derivative.filename,
            content: derivative.content,
            contentHash: derivative.contentHash,
            idempotencyKey:
              `lark-attachment:${capture.recordId}:${derivative.role}:${derivative.contentHash}`,
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
              fileToken: upload.fileToken,
              expectedContent: derivative.content,
            });
          assertAuthorizationCurrent();
          if (sha256(downloaded) !== derivative.contentHash) {
            throw new Error(
              `Lark Base attachment download hash mismatch: ${derivative.role}`,
            );
          }
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
            `${capture.artifactId}:page:${slide.pageNumber}`;
          const content =
            typeof slide.content === "string"
              ? new TextEncoder().encode(slide.content)
              : slide.content;
          const pagePayload = canonicalPayload({
            schemaVersion: "lark-artifact-page-evidence-v1",
            recordType: "artifact_page_evidence",
            recordId: stableId,
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
              fileToken: upload.fileToken,
              expectedContent: content,
            });
          assertAuthorizationCurrent();
          if (sha256(downloaded) !== slide.contentHash) {
            throw new Error(
              `Lark page evidence download hash mismatch: ${stableId}`,
            );
          }
          const shareUrl =
            await this.#transport.createRecordShareLink({
              tableKey: "artifacts",
              remoteRecordId: pageRecord.remoteRecordId,
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
          snapshot,
          pageEvidenceUrls,
          (artifactId, pageNumber) =>
            this.artifactPageEvidenceUrl(artifactId, pageNumber),
        );
      const reportUrls = new Map<string, string>();
      const reportCollection =
        reportCollectionForSnapshot(pageMaterializedSnapshot);
      const materializedReportCollectionHash =
        reportCollectionHash(reportCollection);
      if (reportCollection.length > 0) {
        assertAuthorizationCurrent();
        const collectionHash = materializedReportCollectionHash!;
        const result = await this.#transport.upsertReportCollection({
          reports: reportCollection,
          collectionHash,
          idempotencyKey:
            `lark-report-collection:${jobId}:${collectionHash}`,
        });
        assertAuthorizationCurrent();
        assertHttps(result.url, "Lark report");
        if (
          result.remoteContentHash !==
          sha256(createLarkReportCollectionMarkdown({
            reports: reportCollection,
            collectionHash,
          }))
        ) {
          throw new Error("Lark report readback hash is invalid");
        }
        for (const report of reportCollection) {
          reportUrls.set(report.reportId, result.url);
        }
      }

      const materializedSnapshot = withMaterializedReportUrls(
        pageMaterializedSnapshot,
        reportUrls,
      );
      const originalRows = new Map(
        rows.map(({ tableKey, value }) => [
          `${tableKey}:${stableRecordId(tableKey, value)}`,
          serializedRow(value).payloadHash,
        ]),
      );
      for (const { tableKey, value } of tableRows(
        materializedSnapshot,
      )) {
        const stableId = stableRecordId(tableKey, value);
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
        pageEvidenceUrls: [...pageEvidenceUrls].map(([key, url]) => {
          const separator = key.lastIndexOf(":");
          return {
            artifactId: key.slice(0, separator),
            pageNumber: Number(key.slice(separator + 1)),
            url,
          };
        }),
        committedAt:
          snapshot.runRecordTable.find(
            ({ recordType }) => recordType === "bakeoff_job",
          )?.createdAt ?? authorization.request.requestedAt,
        previousBatchHash: existingMarker?.batchHash ?? null,
        revision: (existingMarker?.revision ?? 0) + 1,
      });
      assertAuthorizationCurrent();
      return materializedSnapshot;
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
    authorizationDecisionId: command.authorization.decisionId,
    claimedAt: command.authorization.request.requestedAt,
  });
  assertApprovedEgressAuthorizationCurrent(command.authorization, clock);
  return result;
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
  const snapshot = options.projection.snapshot();
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

class VerifiedLarkCliTransport
  implements LarkBaseProjectionTransportPort
{
  readonly transportId: string;
  readonly pageEvidenceBaseUrl: string;
  readonly #configuration: LarkCliProjectionConfiguration;
  readonly #nodePath: string;
  readonly #scriptPath: string;

  constructor(
    nodePath: string,
    scriptPath: string,
    configuration: LarkCliProjectionConfiguration,
  ) {
    this.#nodePath = nodePath;
    this.#scriptPath = scriptPath;
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
      const child = spawn(this.#nodePath, [this.#scriptPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
      const reportToken = this.#reportDocumentToken();
      const reportReadback = await this.#run([
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
      parseLarkDocumentReadback(
        reportReadback,
        reportToken,
        this.#configuration.reportDocumentExpectedOrigin,
      );
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
    const matches = parseLarkRecordSearchEnvelope(response).filter((record) => {
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

  async createRecordShareLink(
    command: Parameters<LarkBaseProjectionTransportPort["createRecordShareLink"]>[0],
  ): Promise<string> {
    const response = await this.#run([
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
    ]);
    return parseLarkRecordShareLinkEnvelope(
      response,
      command.remoteRecordId,
      this.#configuration.reportDocumentExpectedOrigin,
    );
  }

  async verifyPageEvidence(
    command: Parameters<LarkBaseProjectionTransportPort["verifyPageEvidence"]>[0],
  ): Promise<void> {
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
      recordId: command.stableId,
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
      fileToken: tokens[0]!,
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
  }> {
    const reportToken = this.#reportDocumentToken();
    const directory = await mkdtemp(join(tmpdir(), "ppt-lark-report-"));
    const filename = "report.md";
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
      const updateRevision = parseLarkDocumentUpdateRevision(
        update,
        reportToken,
        this.#configuration.reportDocumentExpectedOrigin,
      );
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
      const readback = parseLarkDocumentReadback(
        fetched,
        reportToken,
        this.#configuration.reportDocumentExpectedOrigin,
      );
      if (
        readback.revisionId < updateRevision ||
        normalizeMarkdown(readback.content) !== normalizeMarkdown(content)
      ) {
        throw new Error(
          "Lark report readback content or revision is not bound to the projected report",
        );
      }
      return {
        url: readback.url,
        remoteContentHash: sha256(normalizeMarkdown(readback.content)),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async verifyReportCollection(
    command: Parameters<LarkBaseProjectionTransportPort["verifyReportCollection"]>[0],
  ): Promise<void> {
    if (
      command.reports.length === 0 ||
      sha256(canonicalPayload(command.reports)) !==
        command.collectionHash
    ) {
      throw new Error(
        "Lark report collection replay hash is invalid",
      );
    }
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
    const readback = parseLarkDocumentReadback(
      fetched,
      reportToken,
      this.#configuration.reportDocumentExpectedOrigin,
    );
    const expectedContent =
      createLarkReportCollectionMarkdown(command);
    if (
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
    const record = await this.#findRecord(
      "commit_markers",
      command.jobId,
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
      pageEvidenceUrls: parsedPageEvidenceUrls,
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
    const marker = await this.readCommitMarker({ jobId: command.jobId });
    if (marker !== null) {
      return {
        state: "committed",
        marker,
        observedStableIds: [command.jobId],
      };
    }
    if ((await this.#findRecord("runs", command.jobId)) !== null) {
      return {
        state: "job_record_present",
        marker: null,
        observedStableIds: [command.jobId],
      };
    }
    const observedStableIds: string[] = [];
    for (const runId of command.runIds) {
      if ((await this.#findRecord("runs", runId)) !== null) {
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

  async claimProductionJob(command: {
    readonly jobId: string;
    readonly runIds: readonly string[];
    readonly claimHash: `sha256:${string}`;
    readonly authorizationDecisionId: string;
    readonly claimedAt: string;
  }): Promise<"claimed" | "already_claimed"> {
    const stableId = `job-claim:${command.jobId}`;
    const existing = await this.#findRecord("commit_markers", stableId);
    if (existing !== null) return "already_claimed";
    const payload = canonicalPayload({
      schemaVersion: "lark-production-job-claim-v1",
      ...command,
    });
    const payloadHash = sha256(payload);
    await this.upsertRecord({
      tableKey: "commit_markers",
      stableId,
      payload,
      payloadHash,
      idempotencyKey:
        `lark-job-claim:${command.jobId}:${command.claimHash}`,
    });
    const readback = await this.#findRecord("commit_markers", stableId);
    const fields =
      readback?.fields !== null &&
      typeof readback?.fields === "object"
        ? (readback.fields as Record<string, unknown>)
        : readback;
    if (
      fields?.[this.#configuration.payloadField] !== payload ||
      fields?.[this.#configuration.payloadHashField] !== payloadHash
    ) {
      throw new Error(
        "Production Job claim readback is missing or conflicting",
      );
    }
    return "claimed";
  }

  async commitBatch(
    command: Parameters<LarkBaseProjectionTransportPort["commitBatch"]>[0],
  ): Promise<void> {
    const payload = canonicalPayload(command);
    await this.upsertRecord({
      tableKey: "commit_markers",
      stableId: command.jobId,
      payload,
      payloadHash: sha256(payload),
      idempotencyKey:
        `lark-commit:${command.jobId}:${command.batchHash}`,
    });
  }
}

export async function createVerifiedLarkCliTransport(options: {
  readonly configuration: LarkCliProjectionConfiguration;
}): Promise<LarkBaseProjectionTransportPort> {
  const binaryPath = resolve(FROZEN_LARK_CLI_BINARY);
  const nodePath = resolve(FROZEN_LARK_NODE_BINARY);
  const scriptPath = resolve(FROZEN_LARK_CLI_SCRIPT);
  const [actualHash, actualNodeHash, actualScriptHash] =
    await Promise.all([
      readFile(binaryPath).then((value) => sha256(Uint8Array.from(value))),
      readFile(nodePath).then((value) => sha256(Uint8Array.from(value))),
      readFile(scriptPath).then((value) => sha256(Uint8Array.from(value))),
    ]);
  if (
    actualHash !== FROZEN_LARK_CLI_SHA256 ||
    actualScriptHash !== FROZEN_LARK_CLI_SHA256
  ) {
    throw new Error(
      "Fixed lark-cli script hash does not match the reviewed executable",
    );
  }
  if (actualNodeHash !== FROZEN_LARK_NODE_SHA256) {
    throw new Error(
      "Fixed lark-cli Node runtime hash does not match the reviewed executable",
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
  const transport = new VerifiedLarkCliTransport(
    nodePath,
    scriptPath,
    options.configuration,
  );
  VERIFIED_LARK_TRANSPORTS.add(transport);
  return transport;
}
