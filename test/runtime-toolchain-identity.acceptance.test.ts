import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runtimeToolchainArchiveEntries } from "../src/runtime-toolchain-identity.ts";

test("runtime TypeScript toolchain identity changes with loaded bytes and modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runtime-toolchain-"));
  try {
    const packageRoot = join(root, "tsx");
    const loaderPath = join(packageRoot, "dist", "loader.mjs");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(loaderPath, "export default 1;\n", { mode: 0o600 });
    const roots = [{ label: "node_modules/tsx", path: packageRoot }];
    const original = runtimeToolchainArchiveEntries(roots);

    await writeFile(loaderPath, "export default 2;\n", { mode: 0o600 });
    const byteDrift = runtimeToolchainArchiveEntries(roots);
    assert.notDeepEqual(byteDrift, original);

    await writeFile(loaderPath, "export default 1;\n", { mode: 0o600 });
    await chmod(loaderPath, 0o700);
    const modeDrift = runtimeToolchainArchiveEntries(roots);
    assert.notDeepEqual(modeDrift, original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
