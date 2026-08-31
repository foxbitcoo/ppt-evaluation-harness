import type {
  Artifact,
  ArtifactScorecard,
  ProvenanceLabel,
  RenderManifest,
} from "./domain.ts";

export function captureExecutionProvenance(
  artifact: Artifact,
  renderManifest: RenderManifest,
  scorecard?: ArtifactScorecard,
): ProvenanceLabel | null {
  if (
    artifact.provenance !== renderManifest.provenance ||
    (scorecard !== undefined &&
      artifact.provenance !== scorecard.provenance)
  ) {
    return null;
  }
  return artifact.provenance;
}

export function projectionProvenanceCoversCapture(
  projectionProvenance: ProvenanceLabel,
  captureProvenance: ProvenanceLabel,
): boolean {
  if (projectionProvenance === "PRODUCTION") {
    return captureProvenance !== "MOCK";
  }
  return projectionProvenance === captureProvenance;
}
