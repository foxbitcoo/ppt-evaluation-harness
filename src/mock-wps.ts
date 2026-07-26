import { createHash } from "node:crypto";

import type {
  Artifact,
  RenderManifest,
  StaticSlideRender,
} from "./domain.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import {
  MOCK_WPS_VOLCANO_SLIDES,
  type MockSlideFixture,
} from "./fixtures/mock-wps-deck.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";
import type {
  ProductAttemptResult,
  ProductAdapterPort,
  ProductPackageSnapshot,
  ProductRunCommand,
} from "./product-adapter.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface ZipEntry {
  readonly name: string;
  readonly content: Uint8Array;
}

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function slideXml(slide: MockSlideFixture, pageNumber: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="MOCK slide ${pageNumber}">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm/></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="MOCK title ${pageNumber}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${escapeXml(slide.title)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="MOCK body ${pageNumber}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${escapeXml(slide.body)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRelationships(slideCount: number): string {
  const relationships = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function contentTypes(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slides}
</Types>`;
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(
    Buffer.concat([...localParts, centralDirectory, end]),
  );
}

function mockPptx(): Uint8Array {
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      content: textEncoder.encode(contentTypes(MOCK_WPS_VOLCANO_SLIDES.length)),
    },
    {
      name: "_rels/.rels",
      content: textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`),
    },
    {
      name: "docProps/app.xml",
      content: textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MOCK WPS AI PPT</Application><Slides>16</Slides></Properties>`),
    },
    {
      name: "ppt/presentation.xml",
      content: textEncoder.encode(
        presentationXml(MOCK_WPS_VOLCANO_SLIDES.length),
      ),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      content: textEncoder.encode(
        presentationRelationships(MOCK_WPS_VOLCANO_SLIDES.length),
      ),
    },
    ...MOCK_WPS_VOLCANO_SLIDES.map((slide, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      content: textEncoder.encode(slideXml(slide, index + 1)),
    })),
  ];
  return storedZip(entries);
}

function readStoredZip(content: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 4 <= content.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50 || offset + 30 > content.byteLength) {
      throw new Error("Artifact is not a verifiable stored PPTX fixture");
    }
    const compressionMethod = view.getUint16(offset + 8, true);
    if (compressionMethod !== 0) {
      throw new Error("Artifact uses an unsupported compression method");
    }
    const contentLength = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const contentEnd = contentStart + contentLength;
    if (contentEnd > content.byteLength) {
      throw new Error("Artifact contains a truncated PPTX entry");
    }
    const name = textDecoder.decode(
      content.subarray(nameStart, nameStart + nameLength),
    );
    entries.set(name, content.slice(contentStart, contentEnd));
    offset = contentEnd;
  }

  return entries;
}

function slidesFromArtifact(artifact: Artifact): readonly MockSlideFixture[] {
  if (sha256(artifact.content) !== artifact.contentHash) {
    throw new Error("Artifact content hash mismatch");
  }
  const entries = readStoredZip(artifact.content);
  const slideEntries = [...entries.entries()]
    .map(([name, content]) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      return match === null
        ? null
        : { pageNumber: Number(match[1]), content };
    })
    .filter(
      (
        entry,
      ): entry is { readonly pageNumber: number; readonly content: Uint8Array } =>
        entry !== null,
    )
    .sort((left, right) => left.pageNumber - right.pageNumber);

  if (slideEntries.length !== artifact.pageCount) {
    throw new Error(
      `Artifact page count mismatch: declared ${artifact.pageCount}, found ${slideEntries.length}`,
    );
  }
  return slideEntries.map(({ pageNumber, content }, index) => {
    if (pageNumber !== index + 1) {
      throw new Error("Artifact slide sequence is not contiguous");
    }
    const xml = textDecoder.decode(content);
    const textRuns = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(
      (match) => unescapeXml(match[1] ?? ""),
    );
    const title = textRuns[0];
    const body = textRuns[1];
    if (title === undefined || body === undefined) {
      throw new Error(`Artifact slide ${pageNumber} has no verifiable text`);
    }
    return { title, body };
  });
}

function renderSlide(
  slide: MockSlideFixture,
  pageNumber: number,
): StaticSlideRender {
  const content = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="MOCK page ${pageNumber}">
  <rect width="1600" height="900" fill="#211314"/>
  <rect x="0" y="0" width="30" height="900" fill="#ff6b35"/>
  <text x="90" y="100" fill="#ffb199" font-family="sans-serif" font-size="28">MOCK WPS AI PPT · ${pageNumber}/16</text>
  <text x="90" y="320" fill="#ffffff" font-family="sans-serif" font-size="64">${escapeXml(slide.title)}</text>
  <text x="90" y="430" fill="#f4ded5" font-family="sans-serif" font-size="30">${escapeXml(slide.body)}</text>
</svg>`;
  return {
    pageNumber,
    filename: `MOCK-wps-volcano-page-${String(pageNumber).padStart(2, "0")}.svg`,
    mimeType: "image/svg+xml",
    contentHash: sha256(content),
    content,
    extractedText: `${slide.title}\n${slide.body}`,
  };
}

function captureMockArtifact(
  runId: string,
  artifactId: string,
  filename: string,
): Artifact {
  const content = mockPptx();
  return {
    artifactId,
    runId,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    filename,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: content.byteLength,
    pageCount: MOCK_WPS_VOLCANO_SLIDES.length,
    contentHash: sha256(content),
    capturedAt: MOCK_SCENARIO.fixedTime,
    content,
  };
}

export type MockAdapterScenario =
  | "success"
  | "timeout"
  | "quota_blocked"
  | "payment_blocked"
  | "authentication_blocked"
  | "human_wait"
  | "retry_then_success"
  | "first_compliant_artifact"
  | "repeat_not_submitted_failure"
  | "submitted_technical_failure"
  | "unknown_submission_failure";

export interface MockAdapterOptions {
  readonly scenario?: MockAdapterScenario;
}

function executeMockScenario(
  scenario: MockAdapterScenario,
  artifact: Artifact,
  attemptSeq: number,
): ProductAttemptResult {
  if (scenario === "retry_then_success" && attemptSeq === 1) {
    return {
      terminalReason: "technical_failure",
      blockReason: null,
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
      artifactCandidates: [],
    };
  }
  const technicalFailureEvidence = {
    repeat_not_submitted_failure: "not_submitted",
    submitted_technical_failure: "submitted",
    unknown_submission_failure: "unknown",
  } as const;
  const isTechnicalFailureScenario = (
    value: MockAdapterScenario,
  ): value is keyof typeof technicalFailureEvidence =>
    Object.hasOwn(technicalFailureEvidence, value);
  if (isTechnicalFailureScenario(scenario)) {
    return {
      terminalReason: "technical_failure",
      blockReason: null,
      submissionEvidence:
        technicalFailureEvidence[scenario],
      elapsedMs: 1,
      artifactCandidates: [],
    };
  }
  if (scenario === "first_compliant_artifact") {
    return {
      terminalReason: "success",
      blockReason: null,
      submissionEvidence: "submitted",
      elapsedMs: 1,
      artifactCandidates: [false, true, true].map(
        (policyCompliant, index) => ({
          artifact: {
            ...artifact,
            artifactId: `${artifact.artifactId}-candidate-${index + 1}`,
            filename: artifact.filename.replace(
              ".pptx",
              `-candidate-${index + 1}.pptx`,
            ),
          },
          policyCompliant,
        }),
      ),
    };
  }
  const fixedOutcomes: Readonly<
    Record<
      Exclude<
        MockAdapterScenario,
        | "success"
        | "retry_then_success"
        | "first_compliant_artifact"
        | keyof typeof technicalFailureEvidence
      >,
      Omit<ProductAttemptResult, "artifactCandidates">
    >
  > = {
    timeout: {
      terminalReason: "vendor_timeout",
      blockReason: null,
      submissionEvidence: "submitted",
      elapsedMs: 30 * 60 * 1_000,
    },
    quota_blocked: {
      terminalReason: "quota",
      blockReason: "quota",
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
    },
    payment_blocked: {
      terminalReason: "payment",
      blockReason: "payment",
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
    },
    authentication_blocked: {
      terminalReason: "authentication",
      blockReason: "authentication",
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
    },
    human_wait: {
      terminalReason: "human_wait",
      blockReason: null,
      submissionEvidence: "submitted",
      elapsedMs: 1,
    },
  };
  if (
    scenario !== "success" &&
    scenario !== "retry_then_success"
  ) {
    return {
      ...fixedOutcomes[scenario],
      artifactCandidates: [],
    };
  }
  return {
    terminalReason: "success",
    blockReason: null,
    submissionEvidence: "submitted",
    elapsedMs: 1,
    artifactCandidates: [{ artifact, policyCompliant: true }],
  };
}

export function renderStaticArtifact(
  artifact: Artifact,
  renderManifestId: string = MOCK_SCENARIO.renderManifestId,
): RenderManifest {
  const slideFixtures = slidesFromArtifact(artifact);
  const slides = slideFixtures.map((slide, index) =>
    renderSlide(slide, index + 1),
  );
  const manifestPayload = JSON.stringify({
    artifactHash: artifact.contentHash,
    renderer: "mock-static-svg@1",
    slideHashes: slides.map(({ pageNumber, contentHash }) => ({
      pageNumber,
      contentHash,
    })),
  });
  return {
    renderManifestId,
    artifactId: artifact.artifactId,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    renderer: "mock-static-svg@1",
    pageCount: slides.length,
    contentHash: sha256(manifestPayload),
    slides,
  };
}

export class MockWpsProductAdapter implements ProductAdapterPort {
  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "MOCK-wps-package-v1",
    displayName: "Mock WPS AI PPT",
    adapterVersion: "mock-wps@1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  });

  async execute(command: ProductRunCommand): Promise<Artifact> {
    if (command.evaluationCase.targetPageCount !== 16) {
      throw new Error("Mock WPS fixture supports only the frozen 16-page Case");
    }
    return captureMockArtifact(
      command.runId,
      MOCK_SCENARIO.vendors["MOCK-wps-package-v1"].artifactId,
      MOCK_SCENARIO.vendors["MOCK-wps-package-v1"].filename,
    );
  }
}

export class MockQwenProductAdapter implements ProductAdapterPort {
  readonly #scenario: MockAdapterScenario;

  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "MOCK-qwen-package-v1",
    displayName: "Mock Qwen PPT",
    adapterVersion: "mock-qwen@1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  });

  constructor(options: MockAdapterOptions = {}) {
    this.#scenario = options.scenario ?? "success";
  }

  async execute(command: ProductRunCommand): Promise<ProductAttemptResult> {
    if (command.evaluationCase.targetPageCount !== 16) {
      throw new Error("Mock Qwen fixture supports only the frozen 16-page Case");
    }
    return executeMockScenario(
      this.#scenario,
      captureMockArtifact(
        command.runId,
        MOCK_SCENARIO.vendors["MOCK-qwen-package-v1"].artifactId,
        MOCK_SCENARIO.vendors["MOCK-qwen-package-v1"].filename,
      ),
      command.attemptSeq,
    );
  }
}

export class MockDoubaoProductAdapter implements ProductAdapterPort {
  readonly #scenario: MockAdapterScenario;

  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "MOCK-doubao-package-v1",
    displayName: "Mock Doubao PPT",
    adapterVersion: "mock-doubao@1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  });

  constructor(options: MockAdapterOptions = {}) {
    this.#scenario = options.scenario ?? "success";
  }

  async execute(command: ProductRunCommand): Promise<ProductAttemptResult> {
    if (command.evaluationCase.targetPageCount !== 16) {
      throw new Error(
        "Mock Doubao fixture supports only the frozen 16-page Case",
      );
    }
    return executeMockScenario(
      this.#scenario,
      captureMockArtifact(
        command.runId,
        MOCK_SCENARIO.vendors["MOCK-doubao-package-v1"].artifactId,
        MOCK_SCENARIO.vendors["MOCK-doubao-package-v1"].filename,
      ),
      command.attemptSeq,
    );
  }
}
