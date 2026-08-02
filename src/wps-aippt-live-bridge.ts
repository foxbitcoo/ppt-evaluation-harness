import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { EMBEDDED_BUILD_MANIFEST } from "./embedded-build-manifest.ts";
import { terminateChildProcessGroup } from "./process-group-supervisor.ts";

export interface HarnessOwnedWpsLiveBridgeSession {
  readonly executableHash: `sha256:${string}`;
  readonly transcriptHash: `sha256:${string}`;
}

interface InternalLiveBridgeSession
  extends HarnessOwnedWpsLiveBridgeSession {
  readonly challenge: Uint8Array;
  readonly child: ReturnType<typeof spawn>;
}

const liveSessions = new WeakSet<object>();
const transcriptBySession = new WeakMap<object, `sha256:${string}`>();
const fixedExecutableUrl = new URL(
  "../bin/wps-aippt-live-bridge",
  import.meta.url,
);

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function hmac(
  challenge: Uint8Array,
  content: string,
): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac("sha256", challenge)
    .update(content)
    .digest("hex")}`;
}

export function assertHarnessOwnedWpsLiveBridgeReady():
  `sha256:${string}` {
  const expectedHash =
    EMBEDDED_BUILD_MANIFEST.trustedWpsLiveBridgeExecutableHash;
  if (expectedHash === null) {
    throw new Error(
      "Trusted WPS live bridge executable is unavailable in this build",
    );
  }
  let executable: Uint8Array;
  try {
    executable = Uint8Array.from(readFileSync(fixedExecutableUrl));
  } catch {
    throw new Error(
      "Trusted WPS live bridge executable is unavailable in this build",
    );
  }
  if (sha256(executable) !== expectedHash) {
    throw new Error(
      "Trusted WPS live bridge executable content hash verification failed",
    );
  }
  return expectedHash;
}

export async function startHarnessOwnedWpsLiveBridge():
    Promise<HarnessOwnedWpsLiveBridgeSession> {
  const expectedHash = assertHarnessOwnedWpsLiveBridgeReady();
  let executable: Uint8Array;
  try {
    executable = Uint8Array.from(await readFile(fixedExecutableUrl));
  } catch {
    throw new Error(
      "Trusted WPS live bridge executable is unavailable in this build",
    );
  }
  if (sha256(executable) !== expectedHash) {
    throw new Error(
      "Trusted WPS live bridge executable content hash verification failed",
    );
  }
  const challenge = Uint8Array.from(randomBytes(32));
  const child = spawn(fixedExecutableUrl.pathname, [], {
    stdio: ["pipe", "ignore", "ignore"],
    env: {},
    detached: true,
  });
  child.stdin.end(Buffer.from(challenge).toString("base64"));
  const session: InternalLiveBridgeSession = {
    challenge,
    child,
    executableHash: expectedHash,
    transcriptHash: sha256(
      `${expectedHash}:${Buffer.from(challenge).toString("hex")}`,
    ),
  };
  liveSessions.add(session);
  transcriptBySession.set(session, session.transcriptHash);
  return session;
}

function internalSession(
  session: HarnessOwnedWpsLiveBridgeSession | undefined,
): InternalLiveBridgeSession {
  if (
    session === undefined ||
    !liveSessions.has(session as object)
  ) {
    throw new Error(
      "Trusted live bridge executable session is unavailable",
    );
  }
  return session as InternalLiveBridgeSession;
}

export function liveBridgeRequestProof(
  session: HarnessOwnedWpsLiveBridgeSession | undefined,
  requestId: string,
  payloadHash: `sha256:${string}`,
): {
  readonly previousTranscriptHash: `sha256:${string}`;
  readonly requestProof: `hmac-sha256:${string}`;
} {
  const internal = internalSession(session);
  const transcriptHash =
    transcriptBySession.get(internal) ?? internal.transcriptHash;
  return {
    previousTranscriptHash: transcriptHash,
    requestProof: hmac(
      internal.challenge,
      `request:${requestId}:${payloadHash}:${transcriptHash}`,
    ),
  };
}

export function verifyAndAdvanceLiveBridgeTranscript(
  session: HarnessOwnedWpsLiveBridgeSession | undefined,
  input: {
    readonly requestId: string;
    readonly payloadHash: `sha256:${string}`;
    readonly responseHash: `sha256:${string}`;
    readonly responseProof: `hmac-sha256:${string}`;
    readonly transcriptHash: `sha256:${string}`;
  },
): `sha256:${string}` {
  const internal = internalSession(session);
  const previousTranscriptHash =
    transcriptBySession.get(internal) ?? internal.transcriptHash;
  const expectedProof = hmac(
    internal.challenge,
    `response:${input.requestId}:${input.payloadHash}:${input.responseHash}:${previousTranscriptHash}`,
  );
  const expectedTranscriptHash = sha256(
    `${previousTranscriptHash}:${input.requestId}:${input.payloadHash}:${input.responseHash}`,
  );
  if (
    input.transcriptHash !== expectedTranscriptHash ||
    input.responseProof.length !== expectedProof.length ||
    !timingSafeEqual(
      Buffer.from(input.responseProof),
      Buffer.from(expectedProof),
    )
  ) {
    throw new Error(
      "Trusted live bridge challenge or transcript verification failed",
    );
  }
  transcriptBySession.set(internal, expectedTranscriptHash);
  return expectedTranscriptHash;
}

export async function stopHarnessOwnedWpsLiveBridge(
  session: HarnessOwnedWpsLiveBridgeSession | undefined,
): Promise<void> {
  const internal = internalSession(session);
  liveSessions.delete(internal);
  transcriptBySession.delete(internal);
  await terminateChildProcessGroup(internal.child);
}
