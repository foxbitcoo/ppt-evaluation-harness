import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ProductAdapterImplementationPackage } from "./product-adapter.ts";
import type { ObservableAttemptEvent } from "./domain.ts";
import type {
  WpsAiPptBrowserCommand,
  WpsAiPptBrowserResult,
} from "./wps-aippt.ts";
import {
  reconcileHarnessOwnedWpsAiPptTask,
  runHarnessOwnedWpsAiPptBrowser,
} from "./wps-aippt-external-runtime.ts";
import {
  startHarnessOwnedWpsLiveBridge,
  stopHarnessOwnedWpsLiveBridge,
} from "./wps-aippt-live-bridge.ts";

export const WPS_AIPPT_BROWSER_DRIVER_VERSION =
  "wps-aippt-harness-browser-bridge@2" as const;

const textEncoder = new TextEncoder();
const moduleContent = Uint8Array.from(readFileSync(new URL(import.meta.url)));
const runtimeModuleContent = Uint8Array.from(
  readFileSync(new URL("./wps-aippt-external-runtime.ts", import.meta.url)),
);

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export const WPS_AIPPT_BROWSER_PROFILE_DIGEST = sha256(
  textEncoder.encode(
    JSON.stringify({
      automationSurface: "codex-external-chrome",
      credentialSource: "existing-user-profile",
      engine: "chrome",
      profileSchemaVersion: "wps-aippt-browser-profile-v1",
    }),
  ),
);

function implementationPackage(): ProductAdapterImplementationPackage {
  const content = Uint8Array.from([
    ...moduleContent,
    ...textEncoder.encode("\n/* external runtime */\n"),
    ...runtimeModuleContent,
  ]);
  return Object.freeze({
    packageName:
      "src/wps-aippt-driver.ts#harness-owned-external-browser-runtime",
    contentHash: sha256(content),
    content,
  });
}

function configurationPackage(): ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      browserProfileDigest: WPS_AIPPT_BROWSER_PROFILE_DIGEST,
      driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
      schemaVersion: "wps-aippt-browser-driver-configuration-v1",
    }),
  );
  return Object.freeze({
    packageName:
      "wps-aippt-browser-driver-configuration#harness-owned-bridge",
    contentHash: sha256(content),
    content,
  });
}

export interface WpsAiPptBrowserDriverPort {
  readonly driverId:
    | "wps-aippt-test-fixture"
    | "wps-aippt-real-provider-replay";
  readonly provenance: "TEST_FAKE" | "PRODUCTION_REPLAY";
  readonly captureSource: "TEST_FIXTURE" | "REAL_PROVIDER_CAPTURE";
  readonly driverVersion: typeof WPS_AIPPT_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest: typeof WPS_AIPPT_BROWSER_PROFILE_DIGEST;
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly configurationPackage: ProductAdapterImplementationPackage;
  readonly sessions: readonly WpsAiPptBrowserResult[];
  readonly reconciliations: readonly WpsAiPptTaskReconciliationEvidence[];
}

export interface WpsAiPptTaskReconciliationQuery {
  readonly vendorTaskId: `task_${string}`;
  readonly taskStateVersion: string;
  readonly eventHistoryHash: `sha256:${string}`;
  readonly artifactContentHash: `sha256:${string}` | null;
}

export interface WpsAiPptTaskReconciliationEvidence {
  readonly query: WpsAiPptTaskReconciliationQuery;
  readonly observedState: "unknown" | "submitted" | "artifact_ready" | "failed";
  readonly observedAt: string;
  readonly evidenceId: `ev_${string}`;
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneValue(entry),
      ]),
    ) as T;
  }
  return value;
}

export function createWpsAiPptBrowserDriverPackage(input: {
  readonly provenance: "PRODUCTION" | "TEST_FAKE";
  readonly sessions: readonly WpsAiPptBrowserResult[];
  readonly reconciliations?: readonly WpsAiPptTaskReconciliationEvidence[];
}): WpsAiPptBrowserDriverPort {
  if (input.provenance !== "TEST_FAKE") {
    throw new Error(
      "The public WPS browser-driver fixture factory cannot mint PRODUCTION sessions",
    );
  }
  return Object.freeze({
    driverId: "wps-aippt-test-fixture",
    provenance: input.provenance,
    captureSource: "TEST_FIXTURE",
    driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
    browserProfileDigest: WPS_AIPPT_BROWSER_PROFILE_DIGEST,
    implementationPackage: implementationPackage(),
    configurationPackage: configurationPackage(),
    sessions: Object.freeze(
      input.sessions.map((session) =>
        Object.freeze(cloneValue(session)),
      ),
    ),
    reconciliations: Object.freeze(
      (input.reconciliations ?? []).map((entry) =>
        Object.freeze(cloneValue(entry)),
      ),
    ),
  });
}

export function createWpsAiPptRealProviderReplayPackage(input: {
  readonly sessions: readonly WpsAiPptBrowserResult[];
  readonly reconciliations?: readonly WpsAiPptTaskReconciliationEvidence[];
}): WpsAiPptBrowserDriverPort {
  if (
    input.sessions.length === 0 &&
    (input.reconciliations?.length ?? 0) === 0
  ) {
    throw new Error(
      "WPS replay ingest requires retained real-provider evidence",
    );
  }
  return Object.freeze({
    driverId: "wps-aippt-real-provider-replay",
    provenance: "PRODUCTION_REPLAY",
    captureSource: "REAL_PROVIDER_CAPTURE",
    driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
    browserProfileDigest: WPS_AIPPT_BROWSER_PROFILE_DIGEST,
    implementationPackage: implementationPackage(),
    configurationPackage: configurationPackage(),
    sessions: Object.freeze(
      input.sessions.map((session) =>
        Object.freeze(cloneValue(session)),
      ),
    ),
    reconciliations: Object.freeze(
      (input.reconciliations ?? []).map((entry) =>
        Object.freeze(cloneValue(entry)),
      ),
    ),
  });
}

function assertPackage(
  actual: ProductAdapterImplementationPackage | undefined,
  expected: ProductAdapterImplementationPackage,
  label: string,
): void {
  if (
    actual === undefined ||
    actual.packageName !== expected.packageName ||
    actual.contentHash !== expected.contentHash ||
    sha256(actual.content) !== expected.contentHash ||
    !Buffer.from(actual.content).equals(Buffer.from(expected.content))
  ) {
    throw new Error(`WPS browser driver ${label} is not allowlisted`);
  }
}

export interface WpsAiPptBrowserDriverEvidence {
  readonly driverId: string;
  readonly provenance:
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY"
    | "TEST_FAKE";
  readonly captureSource:
    | "LIVE_BROWSER_AUTOMATION"
    | "REAL_PROVIDER_CAPTURE"
    | "TEST_FIXTURE";
  readonly driverVersion: string;
  readonly browserProfileDigest: `sha256:${string}`;
  readonly implementationDigest: `sha256:${string}`;
  readonly configurationDigest: `sha256:${string}`;
  readonly captureReceipt?: {
    readonly captureId: string;
    readonly artifactContentHash: `sha256:${string}`;
    readonly traceDigest: `sha256:${string}`;
    readonly renderDigest: `sha256:${string}`;
  };
}

const HARNESS_OWNED_PRODUCTION_DRIVER_EVIDENCE:
  WpsAiPptBrowserDriverEvidence = Object.freeze({
    driverId: "wps-aippt-harness-browser-bridge",
    provenance: "LIVE_PRODUCTION",
    captureSource: "LIVE_BROWSER_AUTOMATION",
    driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
    browserProfileDigest: WPS_AIPPT_BROWSER_PROFILE_DIGEST,
    implementationDigest: implementationPackage().contentHash,
    configurationDigest: configurationPackage().contentHash,
  });

export function registeredWpsAiPptBrowserDriverEvidence(
  driver: WpsAiPptBrowserDriverPort | undefined,
): WpsAiPptBrowserDriverEvidence {
  if (driver === undefined) {
    return HARNESS_OWNED_PRODUCTION_DRIVER_EVIDENCE;
  }
  assertPackage(
    driver.implementationPackage,
    implementationPackage(),
    "implementation package",
  );
  assertPackage(
    driver.configurationPackage,
    configurationPackage(),
    "configuration package",
  );
  if (
    ((driver.driverId !== "wps-aippt-test-fixture" ||
      driver.provenance !== "TEST_FAKE" ||
      driver.captureSource !== "TEST_FIXTURE") &&
      (driver.driverId !== "wps-aippt-real-provider-replay" ||
        driver.provenance !== "PRODUCTION_REPLAY" ||
        driver.captureSource !== "REAL_PROVIDER_CAPTURE")) ||
    driver.driverVersion !== WPS_AIPPT_BROWSER_DRIVER_VERSION ||
    driver.browserProfileDigest !== WPS_AIPPT_BROWSER_PROFILE_DIGEST
  ) {
    throw new Error(
      "Caller-supplied WPS browser driver identity is not an allowlisted TEST_FAKE fixture",
    );
  }
  return Object.freeze({
    driverId: driver.driverId,
    provenance: driver.provenance,
    captureSource: driver.captureSource,
    driverVersion: driver.driverVersion,
    browserProfileDigest: driver.browserProfileDigest,
    implementationDigest: driver.implementationPackage.contentHash,
    configurationDigest: driver.configurationPackage.contentHash,
  });
}

export function resolveRegisteredWpsAiPptBrowserDriver(
  driver: WpsAiPptBrowserDriverPort | undefined,
  checkpointSink: (
    event: WpsAiPptBrowserResult["events"][number],
  ) => Promise<ObservableAttemptEvent>,
  executionMode: "live" | "replay",
): (command: WpsAiPptBrowserCommand) => Promise<WpsAiPptBrowserResult> {
  registeredWpsAiPptBrowserDriverEvidence(driver);
  const frozenSessions = driver?.sessions ?? [];
  return async (command) => {
    if (executionMode === "live" &&
      command.evaluationProvenance === "PRODUCTION" &&
      driver !== undefined) {
      throw new Error(
        "Production WPS Run rejects caller-supplied browser sessions",
      );
    }
    if (executionMode === "live" &&
      command.evaluationProvenance === "PRODUCTION") {
      const liveSession = await startHarnessOwnedWpsLiveBridge();
      try {
        return await runHarnessOwnedWpsAiPptBrowser(
          command,
          checkpointSink,
          liveSession,
        );
      } finally {
        await stopHarnessOwnedWpsLiveBridge(liveSession);
      }
    }
    if (
      executionMode === "replay" &&
      (command.evaluationProvenance !== "PRODUCTION" ||
        driver?.provenance !== "PRODUCTION_REPLAY" ||
        driver.captureSource !== "REAL_PROVIDER_CAPTURE")
    ) {
      throw new Error(
        "WPS production replay requires a REAL_PROVIDER_CAPTURE replay package",
      );
    }
    if (
      command.evaluationProvenance !== "PRODUCTION" &&
      driver?.provenance !== "TEST_FAKE"
    ) {
      throw new Error(
        "WPS test execution requires a TEST_FAKE browser package",
      );
    }
    const result = frozenSessions[command.attemptSeq - 1];
    if (result === undefined) {
      throw new Error(
        `WPS browser driver has no captured session for attempt ${command.attemptSeq}`,
      );
    }
    const persistedEvents: ObservableAttemptEvent[] = [];
    for (const event of result.events) {
      persistedEvents.push(await checkpointSink(event));
    }
    if (
      driver?.provenance === "PRODUCTION_REPLAY" &&
      result.outcome === "captured"
    ) {
      const contentHash = sha256(result.artifact.content);
      const latest = result.events.at(-1);
      if (
        latest?.vendorTaskId === null ||
        latest?.vendorTaskId === undefined ||
        latest.taskStateVersion === null
      ) {
        throw new Error(
          "WPS real-provider replay requires retained task lineage",
        );
      }
      return Object.freeze({
        ...cloneValue(result),
        productionExecutionEvidence: Object.freeze({
          executionMode: "PRODUCTION_REPLAY",
          captureSource: "REAL_PROVIDER_CAPTURE",
          driverSessionId:
            `session_replay_${contentHash.slice(7, 39)}` as const,
          vendorTaskId: latest.vendorTaskId,
          taskStateVersion: latest.taskStateVersion,
          driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
          adapterVersion: latest.adapterVersion,
          outcome: "captured",
          artifactContentHash: contentHash,
          traceHash: sha256(
            textEncoder.encode(JSON.stringify(persistedEvents)),
          ),
        }),
      });
    }
    return Object.freeze(cloneValue(result));
  };
}

export function reconcileRegisteredWpsAiPptTask(
  driver: WpsAiPptBrowserDriverPort | undefined,
  query: WpsAiPptTaskReconciliationQuery,
  executionMode: "live" | "replay",
): Promise<WpsAiPptTaskReconciliationEvidence> {
  registeredWpsAiPptBrowserDriverEvidence(driver);
  if (executionMode === "live" && driver === undefined) {
    return startHarnessOwnedWpsLiveBridge().then(
      async (liveSession) => {
        try {
          return await reconcileHarnessOwnedWpsAiPptTask(
            query,
            liveSession,
          );
        } finally {
          await stopHarnessOwnedWpsLiveBridge(liveSession);
        }
      },
    );
  }
  if (
    executionMode === "replay" &&
    driver?.provenance !== "PRODUCTION_REPLAY"
  ) {
    return Promise.reject(
      new Error(
        "WPS production replay reconciliation requires REAL_PROVIDER_CAPTURE evidence",
      ),
    );
  }
  if (driver === undefined) {
    return Promise.reject(
      new Error("WPS reconciliation driver is unavailable"),
    );
  }
  const evidence = driver.reconciliations.find(
    (candidate) =>
      JSON.stringify(candidate.query) === JSON.stringify(query),
  );
  if (evidence === undefined) {
    return Promise.reject(
      new Error(
        "WPS reconciliation API has no task/history/hash match",
      ),
    );
  }
  return Promise.resolve(Object.freeze(cloneValue(evidence)));
}
