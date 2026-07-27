import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  InMemoryReferencePackStore,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  OpenAiResponsesJudgeAdapter,
  VOLCANO_EVALUATION_CASE,
  createBakeoffHarness,
  resolveReferencePackForCase,
  type OpenAiResponsesJudgeAdapterOptions,
} from "../src/index.ts";

const SIX_DIMENSIONS = [
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const;

const VALID_ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function testPng(...markers: number[]): Uint8Array {
  return Uint8Array.from([...VALID_ONE_PIXEL_PNG, ...markers]);
}

function createTestJudge(
  options: OpenAiResponsesJudgeAdapterOptions,
): OpenAiResponsesJudgeAdapter {
  return new OpenAiResponsesJudgeAdapter({
    egressAuthorization: {
      async authorize(request) {
        return {
          decisionId: "test-egress-decision-v1",
          decision: "approved",
          policyVersion: "test-public-synthetic-egress-v1",
          dataClassification: request.dataClassification,
          sourceOwner: request.sourceOwner,
          processingPurpose: request.processingPurpose,
          targetService: request.targetService,
          targetAccount: "test-openai-project",
          targetRegion: "us",
          subprocessors: [],
          allowedContentFields: request.contentFields,
          requiredRedactions: [],
          legalSecurityBasis: "synthetic test data policy",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    ...options,
  });
}

function validJudgePayload() {
  return {
    dimensions: SIX_DIMENSIONS.map((dimension, index) => ({
      dimension,
      value: index === 1 ? 4 : 5,
      evidencePages: [Math.min(index + 1, 16)],
      rationale: `第 ${Math.min(index + 1, 16)} 页提供该维度的直接证据。`,
    })),
    knowledgeErrors: [
      {
        pageNumber: 5,
        claim: "岩浆比周围固体岩石更重。",
        correction: "岩浆比周围固体岩石更轻，因而会上升。",
        factId: "magma-rises",
        sourceIds: ["usgs-eruption-faq"],
      },
    ],
  };
}

async function capturedVolcanoInput() {
  const outcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });
  assert.notEqual(outcome.artifact, null);
  assert.notEqual(outcome.renderManifest, null);
  return {
    artifact: outcome.artifact!,
    renderManifest: outcome.renderManifest!,
  };
}

async function volcanoJudgeCommand(scorecardId: string) {
  const { artifact, renderManifest } = await capturedVolcanoInput();
  return {
    jobId: "MOCK-job-volcano-v1",
    runId: artifact.runId,
    scorecardId,
    evaluationCase: VOLCANO_EVALUATION_CASE,
    artifact,
    renderManifest,
    referencePack: resolveReferencePackForCase({
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }).pack,
  };
}

test("OpenAiJudgePort makes one content-addressed Responses call with pinned multimodal structured-output config", async () => {
  const requests: Array<{ request: Record<string, unknown>; idempotencyKey: string }> = [];
  const transport = {
    async create(request: Record<string, unknown>, idempotencyKey: string) {
      requests.push({ request, idempotencyKey });
      return {
        id: "resp_test_volcano",
        model: "gpt-5.6-sol",
        status: "completed",
        incomplete_details: null,
        output: [
          {
            type: "message",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(validJudgePayload()),
              },
            ],
          },
        ],
      };
    },
  };
  const { artifact, renderManifest } = await capturedVolcanoInput();
  const referencePack = resolveReferencePackForCase({
    evaluationCase: VOLCANO_EVALUATION_CASE,
  }).pack;
  const judge = createTestJudge({ transport });
  const command = {
    jobId: "MOCK-job-volcano-v1",
    runId: artifact.runId,
    scorecardId: "MOCK-openai-scorecard-wps-volcano-v1",
    evaluationCase: VOLCANO_EVALUATION_CASE,
    artifact,
    renderManifest,
    referencePack,
  };

  const first = await judge.score(command);
  const second = await judge.score(command);

  assert.deepEqual(second, first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.request.model, "gpt-5.6-sol");
  assert.equal(requests[0]?.request.store, false);
  assert.equal(
    (
      requests[0]?.request.text as {
        format: { type: string; strict: boolean };
      }
    ).format.type,
    "json_schema",
  );
  assert.equal(
    (
      requests[0]?.request.text as {
        format: { type: string; strict: boolean };
      }
    ).format.strict,
    true,
  );
  const input = requests[0]?.request.input as Array<{
    content: Array<{
      type: string;
      detail?: string;
      image_url?: string;
    }>;
  }>;
  const images = input.flatMap(({ content }) =>
    content.filter(({ type }) => type === "input_image"),
  );
  assert.equal(images.length, 16);
  assert.equal(images.every(({ detail }) => detail === "high"), true);
  assert.equal(
    images.every(({ image_url }) =>
      image_url?.startsWith("data:image/png;base64,"),
    ),
    true,
  );
  assert.match(requests[0]?.idempotencyKey ?? "", /^judge_[a-f0-9]{64}$/);
  assert.equal(first.dimensions.length, 6);
  assert.equal(first.judgeLineage?.requestedModel, "gpt-5.6-sol");
  assert.equal(first.judgeLineage?.responseModel, "gpt-5.6-sol");
  assert.equal(first.judgeLineage?.responseId, "resp_test_volcano");
  assert.equal(
    first.judgeLineage?.egressAuthorization.policyVersion,
    "test-public-synthetic-egress-v1",
  );
  assert.equal(
    first.judgeLineage?.egressAuthorization.targetAccount,
    "test-openai-project",
  );
  assert.match(
    first.judgeLineage?.egressAuthorizationHash ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    first.judgeLineage?.payloadHash,
    `sha256:${createHash("sha256")
      .update(JSON.stringify(requests[0]?.request))
      .digest("hex")}`,
  );
});

test("OpenAiJudgePort blocks transport when egress authorization is missing or denied", async () => {
  let transportCalls = 0;
  const transport = {
    async create() {
      transportCalls += 1;
      throw new Error("transport must not be reached");
    },
  };
  const missing = new OpenAiResponsesJudgeAdapter({ transport });
  const denied = createTestJudge({
    transport,
    egressAuthorization: {
      async authorize(request) {
        return {
          decisionId: "test-denied-egress",
          decision: "denied",
          policyVersion: "test-public-synthetic-egress-v1",
          dataClassification: request.dataClassification,
          sourceOwner: request.sourceOwner,
          processingPurpose: request.processingPurpose,
          targetService: request.targetService,
          targetAccount: "test-openai-project",
          targetRegion: "us",
          subprocessors: [],
          allowedContentFields: request.contentFields,
          requiredRedactions: [],
          legalSecurityBasis: "synthetic test data policy",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    missing.score(
      await volcanoJudgeCommand(
        "MOCK-openai-missing-egress-scorecard-wps-volcano-v1",
      ),
    ),
    /egress authorization.*missing|submission blocked/i,
  );
  await assert.rejects(
    denied.score(
      await volcanoJudgeCommand(
        "MOCK-openai-denied-egress-scorecard-wps-volcano-v1",
      ),
    ),
    /egress authorization.*denied|incompatible/i,
  );
  assert.equal(transportCalls, 0);
});

test("OpenAiJudgePort fails closed when a message remains incomplete", async () => {
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_incomplete_message",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "incomplete",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(validJudgePayload()),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-incomplete-scorecard-wps-volcano-v1",
      ),
    ),
    /incomplete/i,
  );
});

test("OpenAiJudgePort rejects structured output that violates the strict schema", async () => {
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_schema_violation",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    ...validJudgePayload(),
                    unexpected: "not allowed by the strict schema",
                  }),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-invalid-schema-scorecard-wps-volcano-v1",
      ),
    ),
    /schema|unexpected|structured output/i,
  );
});

test("OpenAiJudgePort enforces knowledge-error string bounds in its offline strict-schema guard", async () => {
  const payload = validJudgePayload();
  payload.knowledgeErrors[0] = {
    ...payload.knowledgeErrors[0]!,
    claim: "错".repeat(241),
  };
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_long_claim",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(payload),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-long-claim-scorecard-wps-volcano-v1",
      ),
    ),
    /knowledge claim|schema/i,
  );
});

test("OpenAiJudgePort fails closed on an explicit refusal", async () => {
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_refusal",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(validJudgePayload()),
                },
                {
                  type: "refusal",
                  refusal: "I cannot evaluate this input.",
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-refusal-scorecard-wps-volcano-v1",
      ),
    ),
    /refused/i,
  );
});

test("OpenAiJudgePort rejects knowledge-error deductions outside the frozen pack", async () => {
  const payload = validJudgePayload();
  payload.knowledgeErrors[0] = {
    ...payload.knowledgeErrors[0]!,
    factId: "uncovered-fact",
  };
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_uncovered_fact",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(payload),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-uncovered-fact-scorecard-wps-volcano-v1",
      ),
    ),
    /uncovered fact or source/i,
  );
});

test("OpenAiJudgePort rejects a factual score containing hidden deductions not backed by cited pack errors", async () => {
  const payload = validJudgePayload();
  payload.knowledgeErrors = [];
  payload.dimensions[1] = {
    ...payload.dimensions[1]!,
    value: 1,
    rationale: "因知识包未覆盖的隐含事实问题而扣分。",
  };
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_hidden_deduction",
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(payload),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-hidden-deduction-scorecard-wps-volcano-v1",
      ),
    ),
    /hidden|factual|knowledge error/i,
  );
});

test("OpenAiJudgePort rejects claimed PNG input that lacks valid PNG bytes before transport", async () => {
  let transportCalls = 0;
  const judge = createTestJudge({
    rasterizer: {
      version: "invalid-rasterizer@1",
      async rasterize() {
        return {
          mimeType: "image/png",
          content: Uint8Array.from([1, 2, 3]),
        };
      },
    },
    transport: {
      async create() {
        transportCalls += 1;
        throw new Error("transport must not be reached");
      },
    },
  });

  await assert.rejects(
    judge.score(
      await volcanoJudgeCommand(
        "MOCK-openai-invalid-png-scorecard-wps-volcano-v1",
      ),
    ),
    /PNG/i,
  );
  assert.equal(transportCalls, 0);
});

test("OpenAiJudgePort hashes the exact rasterized PNG inputs and rasterizer version into lineage", async () => {
  const command = await volcanoJudgeCommand(
    "MOCK-openai-raster-lineage-scorecard-wps-volcano-v1",
  );
  const completedResponse = {
    id: "resp_raster_lineage",
    model: "gpt-5.6-sol",
    status: "completed",
    incomplete_details: null,
    output: [
      {
        type: "message",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(validJudgePayload()),
          },
        ],
      },
    ],
  };
  const createJudge = (marker: number) =>
    createTestJudge({
      rasterizer: {
        version: "test-rasterizer@1",
        async rasterize(slide) {
          return {
            mimeType: "image/png" as const,
            content: testPng(marker, slide.pageNumber),
          };
        },
      },
      transport: {
        async create() {
          return completedResponse;
        },
      },
    });

  const first = await createJudge(1).score(command);
  const second = await createJudge(2).score(command);

  assert.equal(
    first.judgeLineage?.rasterizerVersion,
    "test-rasterizer@1",
  );
  assert.equal(first.judgeLineage?.rasterizedImageHashes.length, 16);
  assert.match(
    first.judgeLineage?.rasterizedImageHashes[0]?.contentHash ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.notEqual(
    first.judgeLineage?.rasterizedImagesHash,
    second.judgeLineage?.rasterizedImagesHash,
  );
  assert.notEqual(
    first.judgeLineage?.inputHash,
    second.judgeLineage?.inputHash,
  );
});

test("OpenAiJudgePort hashes the exact evaluator context even when a Case version was not bumped", async () => {
  const requests: Record<string, unknown>[] = [];
  const judge = createTestJudge({
    rasterizer: {
      version: "test-rasterizer@1",
      async rasterize(slide) {
        return {
          mimeType: "image/png",
          content: testPng(slide.pageNumber),
        };
      },
    },
    transport: {
      async create(request) {
        requests.push(request);
        return {
          id: `resp_context_${requests.length}`,
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(validJudgePayload()),
                },
              ],
            },
          ],
        };
      },
    },
  });
  const firstCommand = await volcanoJudgeCommand(
    "MOCK-openai-context-scorecard-wps-volcano-v1",
  );
  const first = await judge.score(firstCommand);
  const second = await judge.score({
    ...firstCommand,
    scorecardId: "MOCK-openai-context-scorecard-wps-volcano-v2",
    evaluationCase: {
      ...firstCommand.evaluationCase,
      audience: "初中地理老师",
    },
  });

  assert.equal(requests.length, 2);
  assert.notEqual(first.judgeLineage?.contextHash, second.judgeLineage?.contextHash);
  assert.notEqual(first.judgeLineage?.inputHash, second.judgeLineage?.inputHash);
});

test("Bakeoff injects one OpenAI Judge call per captured Artifact and shares the same pack", async () => {
  const requests: Array<{
    request: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  const judge = createTestJudge({
    rasterizer: {
      version: "test-rasterizer@1",
      async rasterize(slide) {
        return {
          mimeType: "image/png",
          content: testPng(slide.pageNumber),
        };
      },
    },
    transport: {
      async create(request, idempotencyKey) {
        requests.push({ request, idempotencyKey });
        return {
          id: `resp_bakeoff_${requests.length}`,
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(validJudgePayload()),
                },
              ],
            },
          ],
        };
      },
    },
  });

  const outcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
    judge,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(requests.length, 3);
  assert.equal(outcome.scorecards.length, 3);
  assert.equal(
    outcome.scorecards.every(({ judgeLineage }) => judgeLineage !== null),
    true,
  );
  assert.equal(
    new Set(
      outcome.scorecards.map(
        ({ evaluationInputManifest }) =>
          evaluationInputManifest.referencePackHash,
      ),
    ).size,
    1,
  );
});

test("Bakeoff waits for sibling Judge calls and retains the shared pack when one Judge branch fails", async () => {
  const referencePackStore = new InMemoryReferencePackStore();
  const observedRuns: string[] = [];
  const judge = createTestJudge({
    rasterizer: {
      version: "test-rasterizer@1",
      async rasterize(slide) {
        return {
          mimeType: "image/png",
          content: testPng(slide.pageNumber),
        };
      },
    },
    transport: {
      async create(request) {
        const input = request.input as Array<{
          content: Array<{ type: string; text?: string }>;
        }>;
        const contextText = input[0]?.content.find(
          ({ type }) => type === "input_text",
        )?.text;
        assert.notEqual(contextText, undefined);
        const context = JSON.parse(contextText!) as {
          evaluationIdentity: { runId: string };
        };
        observedRuns.push(context.evaluationIdentity.runId);
        if (context.evaluationIdentity.runId.includes("-wps-")) {
          throw new Error("simulated WPS Judge failure");
        }
        return {
          id: `resp_sibling_${observedRuns.length}`,
          model: "gpt-5.6-sol",
          status: "completed",
          incomplete_details: null,
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(validJudgePayload()),
                },
              ],
            },
          ],
        };
      },
    },
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapters: [
        new MockWpsProductAdapter(),
        new MockQwenProductAdapter(),
        new MockDoubaoProductAdapter(),
      ],
      referencePackStore,
      judge,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /simulated WPS Judge failure/,
  );

  assert.equal(observedRuns.length, 3);
  assert.equal(referencePackStore.snapshot().temporary.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
  assert.equal(
    referencePackStore.snapshot().used[0]?.scorecardIds.length,
    3,
  );
});

test("Bakeoff fails closed without persisting scores and retains the pack involved in a failed Judge attempt", async () => {
  const feishu = new InMemoryFeishuProjection();
  const referencePackStore = new InMemoryReferencePackStore();
  const harness = createBakeoffHarness({
    feishu,
    productAdapter: new MockWpsProductAdapter(),
    referencePackStore,
    judge: {
      async score() {
        throw new Error("Judge unavailable");
      },
    },
  });

  await assert.rejects(
    harness.startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /Judge unavailable/,
  );

  assert.deepEqual(feishu.snapshot().artifactScoreTable, []);
  assert.equal(referencePackStore.snapshot().temporary.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
});
