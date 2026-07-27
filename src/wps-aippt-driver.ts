import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ProductAdapterImplementationPackage } from "./product-adapter.ts";
import type {
  WpsAiPptBrowserCommand,
  WpsAiPptBrowserResult,
} from "./wps-aippt.ts";
import {
  reconcileHarnessOwnedWpsAiPptTask,
  runHarnessOwnedWpsAiPptBrowser,
} from "./wps-aippt-external-runtime.ts";

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
  readonly driverId: "wps-aippt-test-fixture";
  readonly provenance: "TEST_FAKE";
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
  readonly driverId:
    | WpsAiPptBrowserDriverPort["driverId"]
    | "wps-aippt-harness-browser-bridge";
  readonly provenance: "PRODUCTION" | "TEST_FAKE";
  readonly driverVersion: typeof WPS_AIPPT_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest: typeof WPS_AIPPT_BROWSER_PROFILE_DIGEST;
  readonly implementationDigest: `sha256:${string}`;
  readonly configurationDigest: `sha256:${string}`;
}

const HARNESS_OWNED_PRODUCTION_DRIVER_EVIDENCE:
  WpsAiPptBrowserDriverEvidence = Object.freeze({
    driverId: "wps-aippt-harness-browser-bridge",
    provenance: "PRODUCTION",
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
    driver.driverId !== "wps-aippt-test-fixture" ||
    driver.provenance !== "TEST_FAKE" ||
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
  ) => Promise<void>,
): (command: WpsAiPptBrowserCommand) => Promise<WpsAiPptBrowserResult> {
  registeredWpsAiPptBrowserDriverEvidence(driver);
  const frozenSessions = driver?.sessions ?? [];
  return async (command) => {
    if (
      command.evaluationProvenance === "PRODUCTION" &&
      driver !== undefined
    ) {
      throw new Error(
        "Production WPS Run rejects caller-supplied browser sessions",
      );
    }
    if (command.evaluationProvenance === "PRODUCTION") {
      return await runHarnessOwnedWpsAiPptBrowser(
        command,
        checkpointSink,
      );
    }
    const result = frozenSessions[command.attemptSeq - 1];
    if (result === undefined) {
      throw new Error(
        `WPS browser driver has no captured session for attempt ${command.attemptSeq}`,
      );
    }
    for (const event of result.events) {
      await checkpointSink(event);
    }
    return Object.freeze(cloneValue(result));
  };
}

export function reconcileRegisteredWpsAiPptTask(
  driver: WpsAiPptBrowserDriverPort | undefined,
  query: WpsAiPptTaskReconciliationQuery,
): Promise<WpsAiPptTaskReconciliationEvidence> {
  registeredWpsAiPptBrowserDriverEvidence(driver);
  if (driver === undefined) {
    return reconcileHarnessOwnedWpsAiPptTask(query);
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
