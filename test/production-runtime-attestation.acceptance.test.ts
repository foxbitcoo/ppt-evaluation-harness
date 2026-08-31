import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  rendererVerifiedCodeDirectoryHashForTest,
} from "../src/production-capabilities.ts";

test("current dyld executable and shared-cache bytes pass strict signature verification", () => {
  for (const path of [
    "/usr/lib/dyld",
    "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e",
  ]) {
    assert.match(
      rendererVerifiedCodeDirectoryHashForTest(path),
      /^sha256:[a-f0-9]{64}$/,
    );
  }
});

test("verified OS runtime identity rejects same-size signed binary byte drift", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "renderer-runtime-byte-drift-"),
  );
  const binary = join(root, "signed-runtime");
  try {
    await copyFile("/usr/bin/true", binary);
    const verifiedIdentity =
      rendererVerifiedCodeDirectoryHashForTest(binary);
    assert.match(verifiedIdentity, /^sha256:[a-f0-9]{64}$/);

    const content = Uint8Array.from(await readFile(binary));
    const byteSize = content.byteLength;
    const driftOffset = Math.min(4_096, content.byteLength - 1);
    content[driftOffset] = content[driftOffset]! ^ 0x01;
    await writeFile(binary, content, { mode: 0o755 });
    assert.equal((await stat(binary)).size, byteSize);

    assert.throws(
      () => rendererVerifiedCodeDirectoryHashForTest(binary),
      /signature verification|actual runtime bytes/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
