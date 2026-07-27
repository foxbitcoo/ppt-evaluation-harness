export const MOCK_SCENARIO = Object.freeze({
  jobId: "MOCK-job-volcano-v1",
  runId: "MOCK-run-wps-volcano-v1",
  artifactId: "MOCK-artifact-wps-volcano-v1",
  renderManifestId: "MOCK-render-wps-volcano-v1",
  scorecardId: "MOCK-scorecard-wps-volcano-v1",
  reportId: "MOCK-report-volcano-v1",
  fixedTime: "2026-01-01T00:00:00.000Z",
  vendors: Object.freeze({
    "MOCK-wps-package-v1": Object.freeze({
      runId: "MOCK-run-wps-volcano-v1",
      artifactId: "MOCK-artifact-wps-volcano-v1",
      renderManifestId: "MOCK-render-wps-volcano-v1",
      scorecardId: "MOCK-scorecard-wps-volcano-v1",
      filename: "MOCK-wps-volcano-16.pptx",
    }),
    "MOCK-qwen-package-v1": Object.freeze({
      runId: "MOCK-run-qwen-volcano-v1",
      artifactId: "MOCK-artifact-qwen-volcano-v1",
      renderManifestId: "MOCK-render-qwen-volcano-v1",
      scorecardId: "MOCK-scorecard-qwen-volcano-v1",
      filename: "MOCK-qwen-volcano-16.pptx",
    }),
    "MOCK-doubao-package-v1": Object.freeze({
      runId: "MOCK-run-doubao-volcano-v1",
      artifactId: "MOCK-artifact-doubao-volcano-v1",
      renderManifestId: "MOCK-render-doubao-volcano-v1",
      scorecardId: "MOCK-scorecard-doubao-volcano-v1",
      filename: "MOCK-doubao-volcano-16.pptx",
    }),
  }),
  gapCards: Object.freeze({
    qwen: "MOCK-gap-wps-vs-qwen-volcano-v1",
    doubao: "MOCK-gap-wps-vs-doubao-volcano-v1",
  }),
});
