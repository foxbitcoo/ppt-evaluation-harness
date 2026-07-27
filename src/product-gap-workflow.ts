import type {
  GitHubIssueLinkEventRecord,
  LinkedGitHubIssue,
  ProductGapCardWorkflowEventRecord,
  ProductGapCardWorkflowView,
} from "./domain.ts";
import type { ProductGapCardWorkflowTablePort } from "./feishu.ts";

export interface GitHubIssueCreateCommand {
  readonly idempotencyKey: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly ["needs-triage"];
}

export interface GitHubIssuePort {
  createIssue(
    command: GitHubIssueCreateCommand,
  ): Promise<LinkedGitHubIssue>;
}

export interface RecordProductGapCardDecisionCommand {
  readonly workflowEventId: string;
  readonly gapCardId: string;
  readonly decision: "confirmed_for_delivery" | "rejected";
  readonly actorId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly priorWorkflowEventId: string | null;
}

export interface CreateLinkedGitHubIssueCommand {
  readonly gapCardId: string;
  readonly actorId: string;
  readonly occurredAt: string;
}

export interface ProductGapCardWorkflowService {
  getGapCard(
    gapCardId: string,
  ): Promise<ProductGapCardWorkflowView>;
  recordDecision(
    command: RecordProductGapCardDecisionCommand,
  ): Promise<ProductGapCardWorkflowEventRecord>;
  createLinkedIssue(
    command: CreateLinkedGitHubIssueCommand,
  ): Promise<ProductGapCardWorkflowView>;
}

export interface ProductGapCardWorkflowServiceDependencies {
  readonly feishu: ProductGapCardWorkflowTablePort;
  readonly githubIssues: GitHubIssuePort;
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
}

function requireTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error("occurredAt must be an ISO timestamp");
  }
}

function issueBody(
  view: ProductGapCardWorkflowView,
): string {
  const card = view.gapCard;
  const links = [
    ...card.leftEvidence.links,
    ...card.rightEvidence.links,
  ]
    .map(
      ({ pageNumber, url }) =>
        `- Page ${pageNumber}: ${url}`,
    )
    .join("\n");
  return `## Product Gap Card

- Gap Card ID: \`${card.gapCardId}\`
- Comparison ID: \`${card.comparisonId}\`
- Dimension: \`${card.dimension}\`
- Workflow state: \`${view.workflowState}\`
- Cause attribution: **${card.causeAttribution}**

## Impact

${card.impact}

## Evidence

${links}

## Cause hypothesis

${card.causeHypothesis.statement}

## Proposed experiment

${card.proposedExperiment}

## Acceptance metric

${card.acceptanceMetric}
`;
}

export function createProductGapCardWorkflowService({
  feishu,
  githubIssues,
}: ProductGapCardWorkflowServiceDependencies): ProductGapCardWorkflowService {
  const issueCreations = new Map<
    string,
    Promise<ProductGapCardWorkflowView>
  >();

  const getGapCard = async (
    gapCardId: string,
  ): Promise<ProductGapCardWorkflowView> => {
    const [gapCard, workflowEvents, linkEvents] = await Promise.all([
      feishu.loadProductGapCard(gapCardId),
      feishu.listProductGapCardWorkflowEvents(gapCardId),
      feishu.listGitHubIssueLinkEvents(gapCardId),
    ]);
    const latestWorkflow = workflowEvents.at(-1);
    const link = linkEvents.at(-1);
    return {
      gapCard,
      workflowState:
        latestWorkflow?.decision ?? gapCard.workflowState,
      latestWorkflowEventId:
        latestWorkflow?.workflowEventId ?? null,
      githubIssue:
        link === undefined
          ? null
          : {
              issueNumber: link.issueNumber,
              issueUrl: link.issueUrl,
            },
    };
  };

  return {
    getGapCard,

    async recordDecision(command) {
      requireNonBlank(command.workflowEventId, "workflowEventId");
      requireNonBlank(command.actorId, "actorId");
      requireNonBlank(command.reason, "reason");
      requireTimestamp(command.occurredAt);
      const view = await getGapCard(command.gapCardId);
      const event: ProductGapCardWorkflowEventRecord = {
        recordType: "gap_card_workflow_event",
        schemaVersion: "gap-card-workflow-event-v1",
        workflowEventId: command.workflowEventId,
        gapCardId: command.gapCardId,
        decision: command.decision,
        actorId: command.actorId,
        occurredAt: command.occurredAt,
        createdAt: command.occurredAt,
        lastSyncedAt: command.occurredAt,
        reason: command.reason,
        priorWorkflowEventId: command.priorWorkflowEventId,
        provenance: view.gapCard.provenance,
        environmentOrigin: view.gapCard.environmentOrigin,
      };
      await feishu.appendProductGapCardWorkflowEvent(event);
      return event;
    },

    async createLinkedIssue(command) {
      requireNonBlank(command.actorId, "actorId");
      requireTimestamp(command.occurredAt);
      const existingCreation = issueCreations.get(command.gapCardId);
      if (existingCreation !== undefined) {
        return existingCreation;
      }
      const creation = (async () => {
        const view = await getGapCard(command.gapCardId);
        if (view.githubIssue !== null) {
          return view;
        }
        if (view.workflowState !== "confirmed_for_delivery") {
          throw new Error(
            "Product Gap Card must be confirmed_for_delivery before GitHub Issue creation",
          );
        }
        const confirmationId = view.latestWorkflowEventId;
        if (confirmationId === null) {
          throw new Error(
            "Confirmed Product Gap Card is missing its workflow event",
          );
        }
        const idempotencyKey = `product-gap-card:${command.gapCardId}`;
        const githubIssue = await githubIssues.createIssue({
          idempotencyKey,
          title: `[Product Gap] ${view.gapCard.dimension}`,
          body: issueBody(view),
          labels: ["needs-triage"],
        });
        if (
          !Number.isInteger(githubIssue.issueNumber) ||
          githubIssue.issueNumber < 1 ||
          !/^https:\/\//.test(githubIssue.issueUrl)
        ) {
          throw new Error("GitHub Issue port returned an invalid reference");
        }
        const linkEvent: GitHubIssueLinkEventRecord = {
          recordType: "github_issue_link_event",
          schemaVersion: "github-issue-link-event-v1",
          linkEventId: `github-link:${command.gapCardId}`,
          gapCardId: command.gapCardId,
          idempotencyKey,
          confirmedByWorkflowEventId: confirmationId,
          issueNumber: githubIssue.issueNumber,
          issueUrl: githubIssue.issueUrl,
          actorId: command.actorId,
          occurredAt: command.occurredAt,
          createdAt: command.occurredAt,
          lastSyncedAt: command.occurredAt,
          provenance: view.gapCard.provenance,
          environmentOrigin: view.gapCard.environmentOrigin,
        };
        try {
          await feishu.appendGitHubIssueLinkEvent(linkEvent);
        } catch (error) {
          const concurrent = await getGapCard(command.gapCardId);
          if (
            concurrent.githubIssue?.issueNumber ===
              githubIssue.issueNumber &&
            concurrent.githubIssue.issueUrl === githubIssue.issueUrl
          ) {
            return concurrent;
          }
          if (concurrent.githubIssue !== null) {
            throw new Error(
              `Product Gap Card GitHub linkage conflict: ${command.gapCardId}`,
              { cause: error },
            );
          }
          throw error;
        }
        return getGapCard(command.gapCardId);
      })();
      issueCreations.set(command.gapCardId, creation);
      try {
        return await creation;
      } finally {
        if (issueCreations.get(command.gapCardId) === creation) {
          issueCreations.delete(command.gapCardId);
        }
      }
    },
  };
}
