import assert from "node:assert/strict";
import test from "node:test";

import type { WpsAiPptBrowserResult } from "../src/wps-aippt.ts";
import {
  createWpsAiPptRealProviderReplayPackage,
} from "../src/wps-aippt-driver.ts";
import type {
  QwenBrowserExecution,
} from "../src/qwen-production-adapter.ts";
import {
  createQwenRealProviderReplayPackage,
} from "../src/qwen-production-adapter.ts";

const MOCK_PPTX_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

const callerMintedWpsCapture = {
  outcome: "captured",
  submissionEvidence: "submitted",
  elapsedMs: 1,
  events: [],
  manualActions: [],
  observedConfiguration: {},
  artifact: {
    filename: "caller-mock.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    content: MOCK_PPTX_BYTES,
    pageCount: 16,
    capturedAt: "2026-07-31T00:00:00.000Z",
  },
} as unknown as WpsAiPptBrowserResult;

const callerMintedQwenCapture = {
  status: "completed",
  submissionEvidence: "submitted",
  elapsedMs: 1,
  observedConfiguration: {},
  milestones: [],
  manualActions: [],
  download: {
    filename: "caller-mock.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    capturedAt: "2026-07-31T00:00:00.000Z",
    content: MOCK_PPTX_BYTES,
  },
  staticRenders: [],
} as unknown as QwenBrowserExecution;

test("WPS caller sessions cannot self-sign the known REAL_PROVIDER_CAPTURE identity", () => {
  assert.throws(
    () =>
      createWpsAiPptRealProviderReplayPackage({
        captureId:
          "wps-real-provider-20260728-round5-resolution-final",
        sessions: [callerMintedWpsCapture],
      } as Parameters<
        typeof createWpsAiPptRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|artifact.*receipt|trace.*receipt/i,
  );
});

test("WPS rejects an unregistered REAL_PROVIDER_CAPTURE identity", () => {
  assert.throws(
    () =>
      createWpsAiPptRealProviderReplayPackage({
        captureId: "caller-invented-wps-capture",
        sessions: [callerMintedWpsCapture],
      } as Parameters<
        typeof createWpsAiPptRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|unregistered capture/i,
  );
});

test("Qwen mock bytes cannot register themselves as a REAL_PROVIDER_CAPTURE", () => {
  assert.throws(
    () =>
      createQwenRealProviderReplayPackage({
        captureId: "caller-invented-qwen-capture",
        sessions: [callerMintedQwenCapture],
      } as Parameters<
        typeof createQwenRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|unregistered capture/i,
  );
});
