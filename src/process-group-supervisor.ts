import type { ChildProcess } from "node:child_process";

export interface ProcessGroupTerminationOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

export interface OwnerFailStopRequired {
  readonly ownerFailStopRequired: true;
}

export function isOwnerFailStopRequiredError(
  error: unknown,
): error is Error & OwnerFailStopRequired {
  return (
    error instanceof Error &&
    "ownerFailStopRequired" in error &&
    error.ownerFailStopRequired === true
  );
}

export class ProcessGroupTerminationIncompleteError
  extends Error
  implements OwnerFailStopRequired
{
  readonly ownerFailStopRequired = true as const;

  constructor(processGroupId: number, cause?: unknown) {
    super(
      `Supervised process group ${processGroupId} termination is unresolved; owner fail-stop is required`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ProcessGroupTerminationIncompleteError";
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite duration`);
  }
  return value;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      // A just-terminated group can remain observable while its members are
      // being reaped. Treat it as present and keep waiting; the bounded
      // caller still fails closed if ESRCH never arrives.
      return true;
    }
    throw new ProcessGroupTerminationIncompleteError(
      processGroupId,
      error,
    );
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }
    throw new ProcessGroupTerminationIncompleteError(
      processGroupId,
      error,
    );
  }
}

async function waitForProcessGroupAbsence(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  return true;
}

export async function terminateChildProcessGroup(
  child: ChildProcess,
  options: ProcessGroupTerminationOptions = {},
): Promise<void> {
  const processGroupId = child.pid;
  if (
    processGroupId === undefined ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1 ||
    processGroupId === process.pid
  ) {
    throw new Error(
      "Supervised child process group has no safe leader identity",
    );
  }
  if (!processGroupExists(processGroupId)) return;

  const termGraceMs = positiveTimeout(
    options.termGraceMs ?? 2_000,
    "Process-group SIGTERM grace",
  );
  const killGraceMs = positiveTimeout(
    options.killGraceMs ?? 2_000,
    "Process-group SIGKILL grace",
  );
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupAbsence(processGroupId, termGraceMs)) {
    return;
  }

  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupAbsence(processGroupId, killGraceMs)) {
    return;
  }
  throw new ProcessGroupTerminationIncompleteError(processGroupId);
}
