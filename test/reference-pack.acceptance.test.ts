import assert from "node:assert/strict";
import test from "node:test";

import {
  VOLCANO_EVALUATION_CASE,
  InMemoryReferencePackStore,
  InMemoryFeishuProjection,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  createBakeoffHarness,
  createContentAddressedReferencePack,
  resolveReferencePackForCase,
} from "../src/index.ts";

test("Reference Pack selection defaults to automatic and freezes the volcano pack", () => {
  const selection = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  const secondSelection = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });

  assert.equal(selection.mode, "automatic");
  assert.equal(selection.pack?.caseId, VOLCANO_EVALUATION_CASE.caseId);
  assert.match(selection.pack?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(selection.pack), true);
  assert.notEqual(selection.pack, secondSelection.pack);
  assert.equal(selection.pack?.contentHash, secondSelection.pack?.contentHash);
});

test("Reference Pack off mode suppresses a matching volcano pack", () => {
  const selection = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
    mode: "off",
  });

  assert.deepEqual(selection, { mode: "off", pack: null });
});

test("Bakeoff off mode leaves no staged pack and marks factual scoring NOT_ASSESSABLE", async () => {
  const store = new InMemoryReferencePackStore();
  const outcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: new MockWpsProductAdapter(),
    referencePackStore: store,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    referencePackMode: "off",
  });
  const factual = outcome.scorecard?.dimensions.find(
    ({ dimension }) => dimension === "factual_accuracy_and_content_quality",
  );

  assert.equal(factual?.assessmentStatus, "NOT_ASSESSABLE");
  assert.equal(factual?.value, null);
  assert.deepEqual(store.snapshot(), { temporary: [], used: [] });
});

test("Reference Pack force mode fails closed when no reviewed pack exists", () => {
  assert.throws(
    () =>
      resolveReferencePackForCase({
        evaluationCase: {
          ...VOLCANO_EVALUATION_CASE,
          caseId: "generic-query-v1",
          title: "通用产品介绍",
          vendorPrompt: "制作一份通用产品介绍 PPT。",
        },
        mode: "force",
      }),
    /force.*no reviewed reference pack/i,
  );
});

test("content-addressed Reference Packs retain only allowlisted authoritative sources", () => {
  const pack = createContentAddressedReferencePack({
    packId: "education-earth-science-volcano-test-v1",
    version: 1,
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    sources: [
      {
        sourceId: "usgs-eruption",
        title: "How Do Volcanoes Erupt?",
        url: "https://www.usgs.gov/faqs/how-do-volcanoes-erupt?page=1",
        publisher: "U.S. Geological Survey",
        authority: "official_agency",
      },
      {
        sourceId: "unreviewed-blog",
        title: "Volcano notes",
        url: "https://example.com/volcanoes",
        publisher: "Unknown",
        authority: "other",
      },
    ],
    facts: [
      {
        factId: "magma-rises",
        statement:
          "Magma is lighter than surrounding solid rock, so it rises and may reach the surface.",
        sourceIds: ["usgs-eruption"],
      },
    ],
  });

  assert.deepEqual(
    pack.sources.map(({ sourceId }) => sourceId),
    ["usgs-eruption"],
  );
  assert.equal(Object.isFrozen(pack.sources), true);
  assert.equal(Object.isFrozen(pack.facts), true);
});

test("Reference Pack hashes are canonical across caller object key order", () => {
  const base = {
    packId: "education-earth-science-volcano-canonical-v1",
    version: 1,
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    facts: [
      {
        factId: "magma-rises",
        statement: "Magma rises.",
        sourceIds: ["usgs-eruption"],
      },
    ],
  };
  const first = createContentAddressedReferencePack({
    ...base,
    sources: [
      {
        sourceId: "usgs-eruption",
        title: "How Do Volcanoes Erupt?",
        url: "https://www.usgs.gov/faqs/how-do-volcanoes-erupt?page=1",
        publisher: "U.S. Geological Survey",
        authority: "official_agency",
      },
    ],
  });
  const second = createContentAddressedReferencePack({
    ...base,
    sources: [
      {
        authority: "official_agency",
        publisher: "U.S. Geological Survey",
        url: "https://www.usgs.gov/faqs/how-do-volcanoes-erupt?page=1",
        title: "How Do Volcanoes Erupt?",
        sourceId: "usgs-eruption",
      },
    ],
  });

  assert.equal(first.contentHash, second.contentHash);
});

test("a staged Reference Pack becomes an immutable persisted usage when scoring uses it", () => {
  const pack = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  }).pack;
  assert.notEqual(pack, null);
  const store = new InMemoryReferencePackStore();

  const staged = store.stage(pack!, { jobId: "MOCK-job-volcano-v1" });
  const usage = store.retainUsed(staged.stagingId, {
    jobId: "MOCK-job-volcano-v1",
    scorecardIds: [
      "MOCK-scorecard-wps-volcano-v1",
      "MOCK-scorecard-qwen-volcano-v1",
      "MOCK-scorecard-doubao-volcano-v1",
    ],
    evaluationAttemptIds: [
      "MOCK-evaluation-attempt-wps",
      "MOCK-evaluation-attempt-qwen",
      "MOCK-evaluation-attempt-doubao",
    ],
  });

  assert.equal(usage.pack.contentHash, pack?.contentHash);
  assert.equal(usage.scorecardIds.length, 3);
  assert.equal(store.snapshot().temporary.length, 0);
  assert.equal(store.snapshot().used.length, 1);
  assert.equal(store.deleteUnused(staged.stagingId), false);
});

test("an unused temporary Reference Pack can be deleted", () => {
  const pack = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  }).pack;
  assert.notEqual(pack, null);
  const store = new InMemoryReferencePackStore();
  const staged = store.stage(pack!, { jobId: "MOCK-job-unused" });

  assert.equal(store.deleteUnused(staged.stagingId), true);
  assert.deepEqual(store.snapshot(), { temporary: [], used: [] });
});

test("concurrent Jobs stage independent usages of the same canonical Reference Pack", () => {
  const pack = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  }).pack;
  assert.notEqual(pack, null);
  const store = new InMemoryReferencePackStore();

  const first = store.stage(pack!, { jobId: "MOCK-job-concurrent-a" });
  const second = store.stage(pack!, { jobId: "MOCK-job-concurrent-b" });
  assert.notEqual(first.stagingId, second.stagingId);

  store.retainUsed(first.stagingId, {
    jobId: "MOCK-job-concurrent-a",
    scorecardIds: ["MOCK-scorecard-a"],
    evaluationAttemptIds: ["MOCK-evaluation-attempt-a"],
  });
  store.retainUsed(second.stagingId, {
    jobId: "MOCK-job-concurrent-b",
    scorecardIds: ["MOCK-scorecard-b"],
    evaluationAttemptIds: ["MOCK-evaluation-attempt-b"],
  });

  assert.equal(store.snapshot().temporary.length, 0);
  assert.equal(store.snapshot().used.length, 2);
});

test("one Bakeoff Job shares one frozen automatic pack across three scorecards without exposing it to vendors", async () => {
  const store = new InMemoryReferencePackStore(
    () => "2026-01-01T00:00:00.000Z",
  );
  const productAdapters = [
    new MockWpsProductAdapter(),
    new MockQwenProductAdapter(),
    new MockDoubaoProductAdapter(),
  ];
  const outcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapters,
    referencePackStore: store,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  const used = store.snapshot().used[0];
  assert.notEqual(used, undefined);
  assert.equal(outcome.scorecards.length, 3);
  assert.deepEqual(
    outcome.scorecards.map(
      ({ evaluationInputManifest }) =>
        evaluationInputManifest.referencePackHash,
    ),
    Array(3).fill(used?.pack.contentHash),
  );
  assert.deepEqual(
    used?.scorecardIds,
    outcome.scorecards.map(({ scorecardId }) => scorecardId),
  );
  assert.equal(
    VOLCANO_EVALUATION_CASE.vendorPrompt.includes("usgs.gov") ||
      VOLCANO_EVALUATION_CASE.vendorPrompt.includes("Magma is"),
    false,
  );
});
