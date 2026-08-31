import type { ObservableAttemptEvent, RunRecord } from "./domain.ts";

export interface ConciseReportTiming {
  readonly totalMs: number | null;
  readonly queueMs: number | null;
  readonly generationMs: number | null;
  readonly exportMs: number | null;
  readonly captureMs: number | null;
}

const UNKNOWN_TIMING: ConciseReportTiming = Object.freeze({
  totalMs: null,
  queueMs: null,
  generationMs: null,
  exportMs: null,
  captureMs: null,
});

function sumKnown(
  attempts: readonly RunRecord[],
  select: (attempt: RunRecord) => number | null,
): number | null {
  const values = attempts
    .map(select)
    .filter((value): value is number => value !== null);
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0);
}

function elapsedBetween(
  events: readonly ObservableAttemptEvent[],
  startType: string,
  endType: string,
): number | null {
  const start = events.find(({ eventType }) => eventType === startType);
  const end = events.find(({ eventType }) => eventType === endType);
  if (start === undefined || end === undefined) return null;
  const elapsed = Date.parse(end.sourceAt) - Date.parse(start.sourceAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function stageTotalFromEvents(
  events: readonly ObservableAttemptEvent[],
  startType: string,
  endType: string,
): number | null {
  const byAttempt = new Map<string, ObservableAttemptEvent[]>();
  for (const event of events) {
    const attemptEvents = byAttempt.get(event.attemptId) ?? [];
    attemptEvents.push(event);
    byAttempt.set(event.attemptId, attemptEvents);
  }
  const values = [...byAttempt.values()]
    .map((attemptEvents) =>
      elapsedBetween(attemptEvents, startType, endType),
    )
    .filter((value): value is number => value !== null);
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0);
}

function stageTotal(
  attempts: readonly RunRecord[],
  startType: string,
  endType: string,
): number | null {
  return sumKnown(attempts, (attempt) =>
    stageTotalFromEvents(
      attempt.observableEvents ?? [],
      startType,
      endType,
    ),
  );
}

export function timingFromAttempts(
  attempts: readonly RunRecord[],
): ConciseReportTiming {
  return Object.freeze({
    totalMs: sumKnown(attempts, ({ elapsedMs }) => elapsedMs),
    queueMs: stageTotal(
      attempts,
      "preflight_observed",
      "query_submitted",
    ),
    generationMs:
      stageTotal(attempts, "query_submitted", "generation_ready") ??
      sumKnown(attempts, ({ vendorGenerationMs }) => vendorGenerationMs),
    exportMs: stageTotal(
      attempts,
      "generation_ready",
      "artifact_exported",
    ),
    captureMs: stageTotal(
      attempts,
      "artifact_exported",
      "static_render_completed",
    ),
  });
}

export function timingFromRun(run: RunRecord): ConciseReportTiming {
  const derived = timingFromAttempts([run]);
  return Object.freeze({
    ...derived,
    totalMs: run.elapsedMs,
    generationMs: derived.generationMs ?? run.vendorGenerationMs,
  });
}

function minutes(value: number | null): string {
  return value === null || !Number.isFinite(value) || value < 0
    ? "UNKNOWN"
    : `${(value / 60_000).toFixed(2)} 分钟`;
}

export function conciseTimingMarkdown(
  timing: ConciseReportTiming = UNKNOWN_TIMING,
): string {
  return `总计 ${minutes(timing.totalMs)}；队列 ${minutes(timing.queueMs)}；生成 ${minutes(timing.generationMs)}；导出 ${minutes(timing.exportMs)}；捕获 ${minutes(timing.captureMs)}`;
}
