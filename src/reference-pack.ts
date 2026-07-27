import { createHash } from "node:crypto";

import type { EvaluationCaseRecord } from "./domain.ts";
import { VOLCANO_CASE_ID } from "./fixtures/volcano-case.ts";

export type ReferencePackMode = "automatic" | "force" | "off";

export type ReferenceSourceAuthority =
  | "official_agency"
  | "textbook"
  | "university"
  | "authoritative_organization";

export interface ReferenceSource {
  readonly sourceId: string;
  readonly title: string;
  readonly url: string;
  readonly publisher: string;
  readonly authority: ReferenceSourceAuthority;
}

export interface ReferenceFact {
  readonly factId: string;
  readonly statement: string;
  readonly sourceIds: readonly string[];
}

export interface ReferencePack {
  readonly packId: string;
  readonly version: number;
  readonly caseId: string;
  readonly sources: readonly ReferenceSource[];
  readonly facts: readonly ReferenceFact[];
  readonly contentHash: `sha256:${string}`;
}

export interface ReferencePackSelection {
  readonly mode: ReferencePackMode;
  readonly pack: ReferencePack | null;
}

export interface StagedReferencePack {
  readonly stagingId: string;
  readonly pack: ReferencePack;
}

export interface UsedReferencePackRecord {
  readonly recordId: string;
  readonly jobId: string;
  readonly pack: ReferencePack;
  readonly scorecardIds: readonly string[];
  readonly usedAt: string;
}

export interface ReferencePackStoreSnapshot {
  readonly temporary: readonly StagedReferencePack[];
  readonly used: readonly UsedReferencePackRecord[];
}

export interface ReferencePackStorePort {
  stage(pack: ReferencePack): StagedReferencePack;
  retainUsed(
    stagingId: string,
    input: {
      readonly jobId: string;
      readonly scorecardIds: readonly string[];
    },
  ): UsedReferencePackRecord;
  deleteUnused(stagingId: string): boolean;
}

export class InMemoryReferencePackStore implements ReferencePackStorePort {
  readonly #temporary = new Map<string, StagedReferencePack>();
  readonly #used: UsedReferencePackRecord[] = [];
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  stage(pack: ReferencePack): StagedReferencePack {
    const stagingId = `temporary:${pack.contentHash}`;
    const staged = Object.freeze({ stagingId, pack });
    this.#temporary.set(stagingId, staged);
    return staged;
  }

  retainUsed(
    stagingId: string,
    input: {
      readonly jobId: string;
      readonly scorecardIds: readonly string[];
    },
  ): UsedReferencePackRecord {
    const staged = this.#temporary.get(stagingId);
    if (staged === undefined) {
      throw new Error(`Temporary Reference Pack not found: ${stagingId}`);
    }
    const record = Object.freeze({
      recordId: `reference-pack-usage:${input.jobId}:${staged.pack.contentHash}`,
      jobId: input.jobId,
      pack: staged.pack,
      scorecardIds: Object.freeze([...input.scorecardIds]),
      usedAt: this.#now(),
    });
    this.#temporary.delete(stagingId);
    this.#used.push(record);
    return record;
  }

  deleteUnused(stagingId: string): boolean {
    return this.#temporary.delete(stagingId);
  }

  snapshot(): ReferencePackStoreSnapshot {
    return {
      temporary: [...this.#temporary.values()],
      used: [...this.#used],
    };
  }
}

export interface ReferenceSourceCandidate
  extends Omit<ReferenceSource, "authority"> {
  readonly authority: ReferenceSourceAuthority | "other";
}

const REVIEWED_SOURCE_ALLOWLIST = new Map<
  string,
  Pick<ReferenceSource, "publisher" | "authority">
>([
  [
    "https://www.usgs.gov/faqs/how-do-volcanoes-erupt?page=1",
    {
      publisher: "U.S. Geological Survey",
      authority: "official_agency",
    },
  ],
  [
    "https://pubs.usgs.gov/gip/volc/nature.html",
    {
      publisher: "U.S. Geological Survey",
      authority: "official_agency",
    },
  ],
]);

export function createContentAddressedReferencePack(input: {
  readonly packId: string;
  readonly version: number;
  readonly caseId: string;
  readonly sources: readonly ReferenceSourceCandidate[];
  readonly facts: readonly ReferenceFact[];
}): ReferencePack {
  const sources = input.sources.flatMap((source) => {
    const reviewed = REVIEWED_SOURCE_ALLOWLIST.get(source.url);
    if (
      reviewed === undefined ||
      source.publisher !== reviewed.publisher ||
      source.authority !== reviewed.authority
    ) {
      return [];
    }
    return [
      Object.freeze({
        sourceId: source.sourceId,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        authority: reviewed.authority,
      }),
    ];
  });
  const sourceIds = new Set(sources.map(({ sourceId }) => sourceId));
  const facts = input.facts.map((fact) => {
    if (
      fact.sourceIds.length === 0 ||
      fact.sourceIds.some((sourceId) => !sourceIds.has(sourceId))
    ) {
      throw new Error(
        `Reference fact ${fact.factId} must cite an allowlisted source`,
      );
    }
    return Object.freeze({
      factId: fact.factId,
      statement: fact.statement,
      sourceIds: Object.freeze([...fact.sourceIds]),
    });
  });
  const content = {
    packId: input.packId,
    version: input.version,
    caseId: input.caseId,
    sources: Object.freeze(sources),
    facts: Object.freeze(facts),
  };
  return Object.freeze({
    ...content,
    contentHash: `sha256:${createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex")}`,
  });
}

const VOLCANO_REFERENCE_PACK = createContentAddressedReferencePack({
  packId: "education-earth-science-volcano-v1",
  version: 1,
  caseId: VOLCANO_CASE_ID,
  sources: [
    {
      sourceId: "usgs-eruption-faq",
      title: "How Do Volcanoes Erupt?",
      url: "https://www.usgs.gov/faqs/how-do-volcanoes-erupt?page=1",
      publisher: "U.S. Geological Survey",
      authority: "official_agency",
    },
    {
      sourceId: "usgs-nature-of-volcanoes",
      title: "The Nature of Volcanoes",
      url: "https://pubs.usgs.gov/gip/volc/nature.html",
      publisher: "U.S. Geological Survey",
      authority: "official_agency",
    },
  ],
  facts: [
    {
      factId: "magma-rises",
      statement:
        "Magma is lighter than surrounding solid rock, so it rises and may reach the surface through vents and fissures.",
      sourceIds: ["usgs-eruption-faq"],
    },
    {
      factId: "viscosity-controls-gas-escape",
      statement:
        "Thin, runny magma lets gases escape more easily; thick, sticky magma traps gases so pressure can build toward an explosive eruption.",
      sourceIds: ["usgs-eruption-faq"],
    },
    {
      factId: "magma-and-lava",
      statement:
        "Molten rock below the surface is magma; after it erupts from a volcano it is called lava.",
      sourceIds: ["usgs-eruption-faq", "usgs-nature-of-volcanoes"],
    },
  ],
});

export function resolveReferencePackForCase(input: {
  readonly evaluationCase: EvaluationCaseRecord;
  readonly mode?: ReferencePackMode;
}): ReferencePackSelection {
  const mode = input.mode ?? "automatic";
  if (
    mode === "force" &&
    input.evaluationCase.caseId !== VOLCANO_CASE_ID
  ) {
    throw new Error(
      `Reference Pack force mode found no reviewed Reference Pack for ${input.evaluationCase.caseId}`,
    );
  }
  return Object.freeze({
    mode,
    pack:
      mode !== "off" && input.evaluationCase.caseId === VOLCANO_CASE_ID
        ? VOLCANO_REFERENCE_PACK
        : null,
  });
}
