import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ProductAdapterImplementationPackage } from "./product-adapter.ts";
import type {
  WpsAiPptBrowserCommand,
  WpsAiPptBrowserResult,
} from "./wps-aippt.ts";

export const WPS_AIPPT_BROWSER_DRIVER_VERSION =
  "wps-aippt-captured-chrome-session@1" as const;

const textEncoder = new TextEncoder();
const moduleContent = Uint8Array.from(readFileSync(new URL(import.meta.url)));

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
  return Object.freeze({
    packageName:
      "src/wps-aippt-driver.ts#captured-chrome-session-driver",
    contentHash: sha256(moduleContent),
    content: Uint8Array.from(moduleContent),
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
      "wps-aippt-browser-driver-configuration#captured-chrome-session",
    contentHash: sha256(content),
    content,
  });
}

export interface WpsAiPptBrowserDriverPort {
  readonly driverId: "wps-aippt-captured-chrome-session";
  readonly provenance: "PRODUCTION" | "TEST_FAKE";
  readonly driverVersion: typeof WPS_AIPPT_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest: typeof WPS_AIPPT_BROWSER_PROFILE_DIGEST;
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly configurationPackage: ProductAdapterImplementationPackage;
  readonly sessions: readonly WpsAiPptBrowserResult[];
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
}): WpsAiPptBrowserDriverPort {
  return Object.freeze({
    driverId: "wps-aippt-captured-chrome-session",
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
  readonly driverId: WpsAiPptBrowserDriverPort["driverId"];
  readonly provenance: WpsAiPptBrowserDriverPort["provenance"];
  readonly driverVersion: typeof WPS_AIPPT_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest: typeof WPS_AIPPT_BROWSER_PROFILE_DIGEST;
  readonly implementationDigest: `sha256:${string}`;
  readonly configurationDigest: `sha256:${string}`;
}

export function registeredWpsAiPptBrowserDriverEvidence(
  driver: WpsAiPptBrowserDriverPort | undefined,
): WpsAiPptBrowserDriverEvidence {
  if (driver === undefined) {
    throw new Error(
      "WPS production adapter requires an explicit registered browser driver package",
    );
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
    driver.driverId !== "wps-aippt-captured-chrome-session" ||
    driver.driverVersion !== WPS_AIPPT_BROWSER_DRIVER_VERSION ||
    driver.browserProfileDigest !== WPS_AIPPT_BROWSER_PROFILE_DIGEST
  ) {
    throw new Error("WPS browser driver identity is not allowlisted");
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
): (command: WpsAiPptBrowserCommand) => Promise<WpsAiPptBrowserResult> {
  registeredWpsAiPptBrowserDriverEvidence(driver);
  const frozenSessions = driver?.sessions ?? [];
  return async (command) => {
    if (
      command.evaluationProvenance === "PRODUCTION" &&
      driver?.provenance !== "PRODUCTION"
    ) {
      throw new Error(
        "Production WPS Run rejects TEST_FAKE browser driver provenance",
      );
    }
    const result = frozenSessions[command.attemptSeq - 1];
    if (result === undefined) {
      throw new Error(
        `WPS browser driver has no captured session for attempt ${command.attemptSeq}`,
      );
    }
    return Object.freeze(cloneValue(result));
  };
}
