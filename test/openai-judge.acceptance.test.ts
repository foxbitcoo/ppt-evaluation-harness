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
  PRODUCTION_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  createBakeoffHarness,
  defineProductAdapterExecutorFactory,
  resolveReferencePackForCase,
  type JudgeEgressAuditPort,
  type JudgeEgressAuthorizationRequest,
  type OpenAiResponsesJudgeAdapterOptions,
  type OpenAiResponsesTransport,
  type ProductAdapterPort,
  type ProductAdapterExecutor,
} from "../src/index.ts";
import { scoreRenderedArtifact } from "../src/mock-score.ts";

function testExecutorFactory(executor: ProductAdapterExecutor) {
  return defineProductAdapterExecutorFactory(() => executor);
}

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

function approvedEgressDecision(
  request: JudgeEgressAuthorizationRequest,
  decisionId = "test-egress-decision-v1",
) {
  return {
    decisionId,
    decision: "approved" as const,
    policyVersion: "test-public-synthetic-egress-v1",
    dataClassification: request.dataClassification,
    sourceOwner: request.sourceOwner,
    processingPurpose: request.processingPurpose,
    targetService: request.targetService,
    targetAccount: request.targetAccount,
    targetRegion: request.targetRegion,
    subprocessors: [],
    allowedContentFields: request.contentFields,
    requiredRedactions: [],
    legalSecurityBasis: "synthetic test data policy",
    approvedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function createTestJudge(
  options: Omit<
    OpenAiResponsesJudgeAdapterOptions,
    "transport" | "egressAudit"
  > & {
    readonly transport: Omit<OpenAiResponsesTransport, "destination"> & {
      readonly destination?: OpenAiResponsesTransport["destination"];
    };
    readonly egressAudit?: JudgeEgressAuditPort;
  },
): OpenAiResponsesJudgeAdapter {
  const { transport, egressAudit, ...rest } = options;
  return new OpenAiResponsesJudgeAdapter({
    egressAuthorization: {
      async authorize(request) {
        return approvedEgressDecision(request);
      },
    },
    ...rest,
    transport: {
      destination: transport.destination ?? {
        targetAccount: "test-openai-project",
        targetRegion: "us",
      },
      create: transport.create.bind(transport),
    },
    egressAudit: egressAudit ?? {
      async recordAuthorizedAttempt() {},
    },
  });
}

function validJudgePayload() {
  return {
    dimensions: SIX_DIMENSIONS.map((dimension, index) => ({
      dimension,
      assessmentStatus: "ASSESSED",
      value: (index === 1 ? 4 : 5) as number | null,
      deductionBasis:
        index === 1 ? "validated_reference_pack_errors" : "no_deduction",
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
    evaluationAttemptId: `judge-attempt:${scorecardId}`,
    evaluationCase: VOLCANO_EVALUATION_CASE,
    artifact,
    renderManifest,
    referencePack: resolveReferencePackForCase({
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }).pack,
  };
}

test("OpenAiJudgePort makes one content-addressed Responses call with pinned multimodal structured-output config", async () => {
  const requests: Array<{
    request: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
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
    evaluationAttemptId: "judge-attempt:MOCK-openai-scorecard-wps-volcano-v1",
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
  assert.equal(
    images.every(({ detail }) => detail === "high"),
    true,
  );
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
    destination: {
      targetAccount: "test-openai-project",
      targetRegion: "us",
    },
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
  const mismatchedDestination = createTestJudge({
    transport,
    egressAuthorization: {
      async authorize(request) {
        return {
          ...approvedEgressDecision(request),
          targetAccount: "different-openai-project",
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
  await assert.rejects(
    mismatchedDestination.score(
      await volcanoJudgeCommand(
        "MOCK-openai-mismatched-egress-scorecard-wps-volcano-v1",
      ),
    ),
    /egress authorization.*incompatible|denied/i,
  );
  assert.equal(transportCalls, 0);
});

test("OpenAiJudgePort binds authorization to transport destination and persists audit before a failed submission", async () => {
  const audits: Parameters<
    JudgeEgressAuditPort["recordAuthorizedAttempt"]
  >[0][] = [];
  let transportCalls = 0;
  const command = await volcanoJudgeCommand(
    "MOCK-openai-egress-audit-scorecard-wps-volcano-v1",
  );
  const judge = createTestJudge({
    egressAudit: {
      async recordAuthorizedAttempt(audit) {
        audits.push(audit);
      },
    },
    transport: {
      destination: {
        targetAccount: "bound-openai-project",
        targetRegion: "eu",
      },
      async create() {
        transportCalls += 1;
        throw new Error("simulated network uncertainty");
      },
    },
  });

  await assert.rejects(
    judge.score(command),
    /transport failed|network uncertainty/i,
  );

  assert.equal(transportCalls, 1);
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0]?.egressAuthorization.targetAccount,
    "bound-openai-project",
  );
  assert.equal(audits[0]?.egressAuthorization.targetRegion, "eu");
});

test("OpenAiJudgePort keeps idempotency payload-stable across renewed authorization decisions", async () => {
  const idempotencyKeys: string[] = [];
  const command = await volcanoJudgeCommand(
    "MOCK-openai-stable-idempotency-scorecard-wps-volcano-v1",
  );
  const createJudge = (decisionId: string) =>
    createTestJudge({
      egressAuthorization: {
        async authorize(request) {
          return approvedEgressDecision(request, decisionId);
        },
      },
      transport: {
        async create(_request, idempotencyKey) {
          idempotencyKeys.push(idempotencyKey);
          return {
            id: `resp_${decisionId}`,
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

  const first = await createJudge("renewal-a").score(command);
  const second = await createJudge("renewal-b").score(command);

  assert.equal(idempotencyKeys.length, 2);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal(
    first.judgeLineage?.payloadHash,
    second.judgeLineage?.payloadHash,
  );
  assert.notEqual(
    first.judgeLineage?.egressAuthorizationHash,
    second.judgeLineage?.egressAuthorizationHash,
  );
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
      await volcanoJudgeCommand("MOCK-openai-refusal-scorecard-wps-volcano-v1"),
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

test("OpenAiJudgePort forbids Reference Pack deductions from leaking into non-factual dimensions", async () => {
  const payload = validJudgePayload();
  payload.dimensions[0] = {
    ...payload.dimensions[0]!,
    value: 1,
    deductionBasis: "no_deduction",
    rationale: "因未覆盖的知识包事实而降低需求覆盖分。",
  };
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_cross_dimension_pack_deduction",
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
        "MOCK-openai-cross-dimension-scorecard-wps-volcano-v1",
      ),
    ),
    /non-factual|deduction basis|hidden/i,
  );
});

test("OpenAiJudgePort marks the factual criterion NOT_ASSESSABLE when Reference Pack mode is off", async () => {
  const payload = validJudgePayload();
  payload.knowledgeErrors = [];
  payload.dimensions[1] = {
    ...payload.dimensions[1]!,
    assessmentStatus: "NOT_ASSESSABLE",
    value: null,
    deductionBasis: "not_assessable_no_reference_pack",
    evidencePages: [],
    rationale: "未提供知识包，事实维度不作评估。",
  };
  const judge = createTestJudge({
    transport: {
      async create() {
        return {
          id: "resp_pack_off",
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
  const command = await volcanoJudgeCommand(
    "MOCK-openai-pack-off-scorecard-wps-volcano-v1",
  );
  const scorecard = await judge.score({
    ...command,
    referencePack: null,
  });
  const factual = scorecard.dimensions.find(
    ({ dimension }) => dimension === "factual_accuracy_and_content_quality",
  );

  assert.equal(factual?.assessmentStatus, "NOT_ASSESSABLE");
  assert.equal(factual?.value, null);
});

test("OpenAiJudgePort rejects claimed PNG input that lacks valid PNG bytes before transport", async () => {
  let transportCalls = 0;
  const judge = createTestJudge({
    rasterizer: {
      version: "invalid-rasterizer@1",
      async rasterize() {
        return {
          mimeType: "image/png",
          content: VALID_ONE_PIXEL_PNG.subarray(0, 41),
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

  assert.equal(first.judgeLineage?.rasterizerVersion, "test-rasterizer@1");
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
  assert.notEqual(
    first.judgeLineage?.contextHash,
    second.judgeLineage?.contextHash,
  );
  assert.notEqual(
    first.judgeLineage?.inputHash,
    second.judgeLineage?.inputHash,
  );
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

test("Bakeoff rejects an invalid injected Judge score while retaining its captured output", async () => {
  const feishu = new InMemoryFeishuProjection();
  const referencePackStore = new InMemoryReferencePackStore();
  const outcome = await createBakeoffHarness({
    feishu,
    referencePackStore,
    productAdapter: new MockWpsProductAdapter(),
    judge: {
      async score(command) {
        return scoreRenderedArtifact(command.artifact, command.renderManifest, {
          jobId: command.jobId,
          runId: command.runId,
          scorecardId: command.scorecardId,
          referencePack: command.referencePack,
        });
      },
    },
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(outcome.job.status, "failed");
  assert.equal(outcome.artifacts.length, 1);
  assert.equal(outcome.scorecards.length, 0);
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 1);
  assert.equal(feishu.snapshot().artifactScoreTable.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
  const vendorRun = feishu
    .snapshot()
    .runRecordTable.find((record) => record.recordType === "vendor_run");
  assert.match(
    vendorRun?.judgeFailure?.message ?? "",
    /non-OpenAI Scorecard lineage/i,
  );
});

test("Bakeoff rejects an Artifact with the wrong environment origin before Judge egress", async () => {
  const wps = new MockWpsProductAdapter();
  let judgeCalls = 0;
  const wrongOriginAdapter: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    executionConfigurationPackage:
      wps.executionConfigurationPackage,
    productPackage: wps.productPackage,
    executorFactory: testExecutorFactory(async (command) => {
      return {
        ...(await wps.execute(command)),
        environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      };
    }),
  };

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapter: wrongOriginAdapter,
      judge: {
        async score() {
          judgeCalls += 1;
          throw new Error("Judge must not be reached");
        },
      },
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /environment origin/i,
  );
  assert.equal(judgeCalls, 0);
});

test("Bakeoff waits for sibling Judge calls and retains the shared pack when one Judge branch fails", async () => {
  const referencePackStore = new InMemoryReferencePackStore();
  const feishu = new InMemoryFeishuProjection();
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

  const outcome = await createBakeoffHarness({
    feishu,
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
  });

  assert.equal(observedRuns.length, 3);
  assert.equal(outcome.job.status, "partial");
  assert.equal(outcome.artifact?.artifactId, "MOCK-artifact-wps-volcano-v1");
  assert.equal(outcome.scorecard, null);
  assert.equal(outcome.artifacts.length, 3);
  assert.equal(outcome.renderManifests.length, 3);
  assert.equal(outcome.scorecards.length, 2);
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 3);
  assert.equal(feishu.snapshot().artifactScoreTable.length, 2);
  assert.match(
    outcome.report.markdown,
    /MOCK-artifact-wps-volcano-v1[\s\S]*Judge：失败/,
  );
  const failedJudgeRun = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordId }) => recordId === "MOCK-run-wps-volcano-v1",
    );
  assert.equal(failedJudgeRun?.judgeFailure?.failureClass, "judge_failure");
  assert.equal(
    failedJudgeRun?.judgeEgressAttempt?.egressAuthorization.targetAccount,
    "test-openai-project",
  );
  assert.equal(referencePackStore.snapshot().temporary.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
  assert.equal(referencePackStore.snapshot().used[0]?.scorecardIds.length, 2);
  assert.equal(
    referencePackStore.snapshot().used[0]?.evaluationAttemptIds.length,
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

  const outcome = await harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(outcome.job.status, "failed");
  assert.equal(outcome.artifacts.length, 1);
  assert.equal(outcome.renderManifests.length, 1);
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 1);
  assert.deepEqual(feishu.snapshot().artifactScoreTable, []);
  assert.equal(referencePackStore.snapshot().temporary.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
  assert.equal(referencePackStore.snapshot().used[0]?.scorecardIds.length, 0);
  assert.equal(
    referencePackStore.snapshot().used[0]?.evaluationAttemptIds.length,
    1,
  );
});
