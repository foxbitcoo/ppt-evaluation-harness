import type {
  WpsAiPptBrowserCommand,
  WpsAiPptBrowserEvent,
  WpsAiPptBrowserResult,
} from "./wps-aippt.ts";
import type {
  WpsAiPptTaskReconciliationEvidence,
  WpsAiPptTaskReconciliationQuery,
} from "./wps-aippt-driver.ts";

const MAX_BRIDGE_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_BRIDGE_LINE_BYTES = 72 * 1024 * 1024;

function configuredBridgeUrl(
  operation: "run" | "reconcile",
): URL {
  const configured =
    process.env.PPT_EVALUATION_WPS_BROWSER_BRIDGE_URL;
  if (configured === undefined) {
    throw new Error(
      "Harness-owned WPS production driver requires the build-configured browser bridge",
    );
  }
  const parsed = new URL(configured);
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1" &&
      parsed.hostname !== "localhost") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/v1/wps-aippt/run"
  ) {
    throw new Error(
      "Harness-owned WPS browser bridge must be the allowlisted loopback endpoint",
    );
  }
  parsed.pathname = `/v1/wps-aippt/${operation}`;
  return parsed;
}

async function boundedJsonResponse(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new Error("WPS browser bridge rejected reconciliation");
  }
  const content = new Uint8Array(await response.arrayBuffer());
  if (content.byteLength > 1024 * 1024) {
    throw new Error("WPS reconciliation response exceeded its bound");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
}

function decodedReconciliationEvidence(
  value: unknown,
  query: WpsAiPptTaskReconciliationQuery,
): WpsAiPptTaskReconciliationEvidence {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("WPS reconciliation response is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(record.query) !== JSON.stringify(query) ||
    !["unknown", "submitted", "artifact_ready", "failed"].includes(
      String(record.observedState),
    ) ||
    typeof record.observedAt !== "string" ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    typeof record.evidenceId !== "string" ||
    !/^ev_[a-zA-Z0-9_-]{16,128}$/.test(record.evidenceId)
  ) {
    throw new Error(
      "WPS reconciliation response does not match task/history/hash query",
    );
  }
  return Object.freeze({
    query,
    observedState: record.observedState as
      WpsAiPptTaskReconciliationEvidence["observedState"],
    observedAt: record.observedAt,
    evidenceId:
      record.evidenceId as WpsAiPptTaskReconciliationEvidence["evidenceId"],
  });
}

export async function reconcileHarnessOwnedWpsAiPptTask(
  query: WpsAiPptTaskReconciliationQuery,
): Promise<WpsAiPptTaskReconciliationEvidence> {
  const response = await fetch(configuredBridgeUrl("reconcile"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "wps-aippt-task-reconciliation-query-v1",
      query,
    }),
  });
  return decodedReconciliationEvidence(
    await boundedJsonResponse(response),
    query,
  );
}

function decodedResult(
  value: unknown,
  streamedEvents: readonly WpsAiPptBrowserEvent[],
): WpsAiPptBrowserResult {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("WPS browser bridge result is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record.outcome === "captured" &&
    record.artifact !== null &&
    typeof record.artifact === "object"
  ) {
    const artifact = record.artifact as Record<string, unknown>;
    const contentBase64 = artifact.contentBase64;
    if (
      typeof contentBase64 !== "string" ||
      contentBase64.length > MAX_BRIDGE_LINE_BYTES
    ) {
      throw new Error("WPS browser bridge Artifact payload is unsafe");
    }
    const content = Uint8Array.from(
      Buffer.from(contentBase64, "base64"),
    );
    return {
      ...(record as unknown as Omit<
        Extract<WpsAiPptBrowserResult, { outcome: "captured" }>,
        "artifact" | "events"
      >),
      events: Object.freeze([...streamedEvents]),
      artifact: {
        ...(artifact as unknown as Omit<
          Extract<
            WpsAiPptBrowserResult,
            { outcome: "captured" }
          >["artifact"],
          "content"
        >),
        content,
      },
    };
  }
  return {
    ...(record as unknown as Exclude<
      WpsAiPptBrowserResult,
      { outcome: "captured" }
    >),
    events: Object.freeze([...streamedEvents]),
  };
}

export async function runHarnessOwnedWpsAiPptBrowser(
  command: WpsAiPptBrowserCommand,
  checkpointSink: (event: WpsAiPptBrowserEvent) => Promise<void>,
): Promise<WpsAiPptBrowserResult> {
  const response = await fetch(configuredBridgeUrl("run"), {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "wps-aippt-browser-command-v1",
      command: {
        jobId: command.jobId,
        runId: command.runId,
        attemptId: command.attemptId,
        attemptSeq: command.attemptSeq,
        timeoutMs: command.timeoutMs,
        evaluationProvenance: command.evaluationProvenance,
        url: command.url,
        prompt: command.prompt,
        accountScope: command.accountScope,
        packageSelection: command.packageSelection,
        mode: command.mode,
        networking: command.networking,
        pageCount: command.pageCount,
      },
    }),
    signal: command.signal,
  });
  if (
    !response.ok ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-ndjson") ||
    response.body === null
  ) {
    throw new Error("WPS browser bridge rejected the execution request");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: WpsAiPptBrowserEvent[] = [];
  let pending = "";
  let totalBytes = 0;
  let terminalResult: WpsAiPptBrowserResult | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BRIDGE_RESPONSE_BYTES) {
      throw new Error("WPS browser bridge response exceeded its bound");
    }
    pending += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BRIDGE_LINE_BYTES) {
        throw new Error("WPS browser bridge line exceeded its bound");
      }
      const envelope = JSON.parse(line) as {
        readonly type?: unknown;
        readonly event?: unknown;
        readonly result?: unknown;
      };
      if (envelope.type === "checkpoint") {
        const event = envelope.event as WpsAiPptBrowserEvent;
        await checkpointSink(event);
        events.push(Object.freeze(structuredClone(event)));
      } else if (envelope.type === "result") {
        if (terminalResult !== null) {
          throw new Error("WPS browser bridge emitted duplicate results");
        }
        terminalResult = decodedResult(envelope.result, events);
      } else {
        throw new Error("WPS browser bridge envelope is not allowlisted");
      }
    }
  }
  pending += decoder.decode();
  if (pending.trim().length !== 0 || terminalResult === null) {
    throw new Error("WPS browser bridge response is incomplete");
  }
  return terminalResult;
}
