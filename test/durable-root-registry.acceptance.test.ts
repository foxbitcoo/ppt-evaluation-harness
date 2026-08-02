import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  loadDurableRootRegistry,
  registerDurableRoots,
} from "../src/durable-root-registry.ts";

const execFileAsync = promisify(execFile);

function registryPath(registryId: string): string {
  return join(
    homedir(),
    ".local",
    "share",
    "ppt-evaluation-harness",
    "root-registries",
    `${registryId}.json`,
  );
}

test("a durable root registry rejects symbolic roots and same-device inode replacement", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "durable-root-identity-"),
  );
  const originalRoot = join(fixtureRoot, "registered");
  const movedRoot = join(fixtureRoot, "registered-original");
  const symbolicRoot = join(fixtureRoot, "symbolic");
  const registryId =
    `test-durable-identity-${process.pid}-${Date.now()}`;
  try {
    await mkdir(originalRoot, { mode: 0o700 });
    await symlink(originalRoot, symbolicRoot, "dir");
    await assert.rejects(
      registerDurableRoots({
        registryId: `${registryId}-symlink`,
        roots: [
          {
            rootReference: "root:test-symbolic",
            absolutePath: symbolicRoot,
          },
        ],
      }),
      /symbolic link/i,
    );

    const registered = await registerDurableRoots({
      registryId,
      roots: [
        {
          rootReference: "root:test-identity",
          absolutePath: originalRoot,
        },
      ],
    });
    assert.equal(registered.schemaVersion, "durable-root-registry-v2");
    assert.match(registered.roots[0]?.deviceId ?? "", /^\d+$/);
    assert.match(registered.roots[0]?.inodeId ?? "", /^\d+$/);
    assert.equal(typeof registered.roots[0]?.ownerUid, "number");
    assert.equal(typeof registered.roots[0]?.mode, "number");

    const replay = await registerDurableRoots({
      registryId,
      roots: [
        {
          rootReference: "root:test-identity",
          absolutePath: originalRoot,
        },
      ],
    });
    assert.equal(replay.registryHash, registered.registryHash);

    await chmod(originalRoot, 0o722);
    await assert.rejects(
      loadDurableRootRegistry(registryId),
      /group\/other writable/i,
    );
    await chmod(originalRoot, 0o700);
    assert.equal(
      (await loadDurableRootRegistry(registryId)).registryHash,
      registered.registryHash,
    );

    await rename(originalRoot, movedRoot);
    await mkdir(originalRoot, { mode: 0o700 });
    await assert.rejects(
      loadDurableRootRegistry(registryId),
      /root identity changed/i,
    );
  } finally {
    await Promise.all([
      rm(fixtureRoot, { recursive: true, force: true }),
      rm(registryPath(registryId), { force: true }),
      rm(registryPath(`${registryId}-symlink`), { force: true }),
    ]);
  }
});

test("a legacy v1 registry requires explicit migration", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "durable-root-legacy-"),
  );
  const registryId =
    `test-durable-legacy-${process.pid}-${Date.now()}`;
  const path = registryPath(registryId);
  const legacyPayload = JSON.stringify({
    schemaVersion: "durable-root-registry-v1",
    registryId,
    roots: [
      {
        rootReference: "root:test-legacy",
        absolutePath: fixtureRoot,
        backendType: "local-filesystem",
        deviceIdentity:
          `fs-device:sha256:${createHash("sha256")
            .update("legacy-device")
            .digest("hex")}`,
      },
    ],
  });
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${legacyPayload}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await assert.rejects(
      loadDurableRootRegistry(registryId),
      /legacy.*explicit migration/i,
    );
    await assert.rejects(
      registerDurableRoots({
        registryId,
        roots: [
          {
            rootReference: "root:test-legacy",
            absolutePath: fixtureRoot,
          },
        ],
      }),
      /legacy.*explicit migration/i,
    );
  } finally {
    await Promise.all([
      rm(fixtureRoot, { recursive: true, force: true }),
      rm(path, { force: true }),
    ]);
  }
});

test("conflicting cross-process durable-root registrations publish exactly one identity", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "durable-root-process-race-"),
  );
  const firstRoot = join(fixtureRoot, "first");
  const secondRoot = join(fixtureRoot, "second");
  const registryId =
    `test-durable-race-${process.pid}-${Date.now()}`;
  const moduleUrl = new URL(
    "../src/durable-root-registry.ts",
    import.meta.url,
  ).href;
  const worker = (absolutePath: string) => [
    `import { registerDurableRoots } from ${JSON.stringify(moduleUrl)};`,
    "await registerDurableRoots({",
    `  registryId: ${JSON.stringify(registryId)},`,
    "  roots: [{",
    '    rootReference: "root:test-process-race",',
    `    absolutePath: ${JSON.stringify(absolutePath)},`,
    "  }],",
    "});",
  ].join("\n");
  try {
    await Promise.all([
      mkdir(firstRoot, { mode: 0o700 }),
      mkdir(secondRoot, { mode: 0o700 }),
    ]);
    const outcomes = await Promise.allSettled([
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        worker(firstRoot),
      ]),
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        worker(secondRoot),
      ]),
    ]);
    assert.equal(
      outcomes.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter(({ status }) => status === "rejected").length,
      1,
    );
    const registry = await loadDurableRootRegistry(registryId);
    const acceptedRoot = registry.roots[0]?.absolutePath;
    assert.ok(
      acceptedRoot === await realpath(firstRoot) ||
        acceptedRoot === await realpath(secondRoot),
    );
    const replayRoot = acceptedRoot === await realpath(firstRoot)
      ? firstRoot
      : secondRoot;
    const replayOutcomes = await Promise.allSettled([
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        worker(replayRoot),
      ]),
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        worker(replayRoot),
      ]),
    ]);
    assert.ok(
      replayOutcomes.every(({ status }) => status === "fulfilled"),
      "same-identity concurrent re-registration must be idempotent",
    );
  } finally {
    await Promise.all([
      rm(fixtureRoot, { recursive: true, force: true }),
      rm(registryPath(registryId), { force: true }),
    ]);
  }
});
