# Query + Profile Case Candidates v1

Status: Approved by the product owner on 2026-08-10; six immutable `v1.0.0` Case payloads are frozen in the Feishu question-bank table. Vendor generation and Judge calls remain pending pipeline readiness.

Tracking: [GitHub Issue #26](https://github.com/foxbitcoo/ppt-evaluation-harness/issues/26)

Planned real Judge: Volcano Ark `doubao-seed-2-0-pro-260215` (ByteDance Seed 2.0 Pro). The six Case payloads are approved; no model call has yet been made.

## Purpose

Define six realistic Query Generation Track candidates for a controlled requester-profile experiment:

- three education cases with different presentation jobs;
- three office-reporting cases with different decision jobs;
- the same audience, use context, page count, Query, and product package in both experiment arms;
- `NO_REQUESTER_PROFILE` hides only requester-profile memory;
- `REQUESTER_PROFILE_INJECTED` adds the frozen requester profile;
- native product memory is not part of this first experiment.

Only vendor-visible fields may create scoring requirements. A control artifact must not be penalized for requester facts that were not supplied to the product.

## Research basis

The candidates target recurring presentation problems observed in institutional guidance and practitioner discussions:

- Teaching slides commonly fail through cognitive overload, excessive on-slide text, weak student engagement, and poor separation between projected material and speaker notes. [Penn State Center for Teaching Excellence](https://cte.psu.edu/2022/02/11/faculty-newsletter-making-powerpoint-work/), [Monash Teach HQ](https://www.monash.edu/learning-teaching/teachhq/Teaching-practices/using-multimedia/how-to/powerpoint-slides), and [Tsinghua University Center for Faculty Development](https://www.cfd.tsinghua.edu.cn/info/1019/1064.htm) describe these issues.
- Chinese compulsory-education material must be aligned to the applicable curriculum and should not treat decoration as a substitute for teaching design. [Ministry of Education curriculum notice](https://www.moe.gov.cn/srcsite/A26/s8001/202204/t20220420_619921.html).
- Teacher discussions report that preparation is time-consuming, supplied decks are often too advanced for the actual class, and effective slides need scaffolding and interaction. These are anecdotal pain-point signals, not population estimates. [new teacher preparing Newton's First Law slides](https://www.reddit.com/r/Teachers/comments/189st52), [trainee teacher adapting overly advanced supplied slides](https://www.reddit.com/r/Teachers/comments/1ot9fhn).
- Executive and project reporting needs a visible bottom line, risks, decisions, owners, and next actions rather than a data dump. [Microsoft project communication guidance](https://support.microsoft.com/en-us/project/project-management-goal-communicate-project-information), [executive status-report practitioner discussion](https://www.reddit.com/r/projectmanagement/comments/f2cxx3), and [consulting presentation practitioner discussion](https://www.reddit.com/r/consulting/comments/1p5o6jj) support these candidate jobs. Reddit evidence is used only to make scenarios realistic.

## Controlled experiment

For each approved base case, create two variants:

| Field | Control | Treatment |
| --- | --- | --- |
| Query | same | same |
| Audience | same and vendor-visible | same and vendor-visible |
| Use context | same and vendor-visible | same and vendor-visible |
| Page count | same | same |
| Requester profile | hidden | vendor-visible |
| Product package/time block | same | same |
| Native product memory | disabled or isolated | disabled or isolated |

The treatment effect is evaluated within the same case and product package. It is not inferred from unmatched vendor outputs.

The frozen Batch manifest binds each `ProductSurface` to `productPackageId`, a
canonical `configurationHash`, and `nativeMemoryPolicy=DISABLED|ISOLATED`.
Both Profile arms reuse that exact Surface snapshot, so model/tier, search,
template, account treatment, client version, entry point, and native Memory
cannot silently change between OFF and ON. Human-readable Feishu fields expose
the package and Memory policy; the stable English enum remains in the hashed
payload.

Both arms also persist the same `requesterProfileVersion` and canonical
`requesterProfileHash`. The OFF arm hides Profile fields from the vendor Prompt,
but it does not erase treatment lineage; changing the frozen Profile creates a
new Run identity for both arms.

## Education candidates

### EDU-01: Digital-information literacy class meeting

- `case_id`: `qprofile-v1-edu-01-digital-rumor-class-meeting`
- status: `DRAFT_REVIEW`
- presentation job: thematic class meeting that must trigger participation, not a lecture deck
- target page count: 12
- expected speaking duration: 40 minutes
- requester profile:
  - role: sixth-grade homeroom teacher who also teaches Chinese
  - experience: 8 years
  - organization: ordinary public primary school in an eastern Chinese city; synthetic context, no real school identity
  - teaching context: 44 students; classroom projector; students cannot use phones during class
  - working style: prefers concrete stories, short instructions, class voting, and a final take-home action card
  - recurring concern: students know internet slang but struggle to distinguish evidence, opinion, advertising, and rumor
  - visual preference: lively but not childish; avoid cartoon decoration unrelated to the teaching goal
- audience:
  - 11–12-year-old sixth-grade students
  - mixed reading ability and mixed familiarity with fact-checking
  - viewing from the back of a classroom rather than reading individually
- Query:
  - Create a 12-slide Chinese presentation titled “别让谣言跑得比真相快” for a 40-minute class meeting. Use one realistic short-video rumor scenario as the thread. Include a warm-up vote, three practical verification steps, one small-group discussion, one class exercise, and a final action checklist. Do not moralize or fill slides with long paragraphs.
- primary evaluation focus:
  - age-appropriate language and examples
  - interaction timing and instructions
  - distinction among fact, opinion, advertisement, and rumor
  - classroom readability and visual relevance
  - whether requester-profile injection improves teaching rhythm without inventing school-specific facts

### EDU-02: Scaffolded physics concept lesson

- `case_id`: `qprofile-v1-edu-02-newton-first-law`
- status: `DRAFT_REVIEW`
- presentation job: subject teaching that must explain a difficult concept and surface misconceptions
- target page count: 14
- expected speaking duration: 45 minutes
- requester profile:
  - role: eighth-grade physics teacher using the People's Education Press curriculum
  - experience: 3 years
  - organization: suburban public junior middle school; synthetic context
  - teaching context: 46 students with a wide attainment range; no specialized motion track
  - available materials: toy car, wooden board, towel, paper cup, and projector
  - working style: starts with a five-minute retrieval task, demonstrates before formal definition, and uses short checks for understanding
  - recurring concern: supplied teaching slides are often too advanced and assume students already understand force and motion
  - visual preference: diagrams should make forces and changes in motion explicit; avoid decorative science imagery
- audience:
  - eighth-grade students encountering Newton's First Law for the first time
  - several low-attaining students need concrete scaffolding before abstraction
- Query:
  - Create a 14-slide Chinese lesson presentation on Newton's First Law for a 45-minute eighth-grade physics class. Start from an everyday misconception, use the available low-cost materials for a demonstration, move from observation to explanation and then to the formal law, include three checks for understanding and one exit ticket, and clearly separate evidence from conclusion.
- primary evaluation focus:
  - scientific correctness and causal reasoning
  - progression from observable phenomenon to abstraction
  - misconception diagnosis and formative assessment
  - diagram correctness, labels, and readability
  - adaptation to the stated equipment and mixed-attainment classroom

### EDU-03: Parent meeting on primary-to-middle-school transition

- `case_id`: `qprofile-v1-edu-03-transition-parent-meeting`
- status: `DRAFT_REVIEW`
- presentation job: trust-building parent communication with clear shared actions
- target page count: 10
- expected speaking duration: 25 minutes plus questions
- requester profile:
  - role: sixth-grade homeroom teacher and Chinese teacher
  - experience: 10 years, including three graduating cohorts
  - organization: ordinary public primary school; synthetic context
  - working style: calm, evidence-oriented, and careful not to shame parents or students
  - recurring concern: parents focus on school ranking and extra tutoring while overlooking routines, reading, emotional transition, and independent learning
  - communication preference: acknowledge anxiety first, then present a small number of concrete family actions
- audience:
  - parents and guardians of sixth-grade students
  - mixed education backgrounds and uneven familiarity with current middle-school learning expectations
  - some will read the exported deck after the meeting
- Query:
  - Create a 10-slide Chinese parent-meeting presentation about supporting the transition from primary to middle school. Explain likely changes in learning rhythm and independence, address common parent anxieties without promising admission outcomes, propose a four-week family action plan, clarify the respective responsibilities of school, student, and family, and end with discussion questions.
- primary evaluation focus:
  - tone, empathy, and absence of blame
  - practical actions with owners and time horizon
  - distinction between general guidance and unsupported school-policy claims
  - suitability both for live projection and later self-reading
  - whether requester-profile injection produces credible teacher communication rather than generic parenting advice

## Office-reporting candidates

### OFFICE-01: Executive project status and resource decision

- `case_id`: `qprofile-v1-office-01-project-status-decision`
- status: `DRAFT_REVIEW`
- presentation job: short executive update that must lead to one explicit decision
- target page count: 8
- expected speaking duration: 10 minutes
- requester profile:
  - role: product manager responsible for a B2B SaaS release
  - experience: 5 years; first year presenting regularly to the executive committee
  - organization: 180-person software company; synthetic context
  - working style: detail-oriented and inclined to explain process before conclusion
  - recurring concern: leadership interrupts when the requested decision is not visible in the first two slides
  - communication preference: direct action titles, restrained visuals, detailed evidence in an appendix only
- audience:
  - CEO, head of engineering, sales director, and finance director
  - knows the product but not daily implementation details
- Query:
  - Create an 8-slide Chinese executive project-status presentation for a 10-minute meeting. The planned launch date is September 15; the current forecast is September 29. Core development is 85% complete, data migration is 60% complete, and security review has not started. Two options require a decision: add two frontend engineers for four weeks at an incremental cost of RMB 160,000, or remove two non-contractual dashboard features and keep the current team. Present the recommendation, trade-offs, risks, owners, and next milestone.
- primary evaluation focus:
  - conclusion-first executive structure
  - faithful use of supplied dates, percentages, cost, and options
  - visible decision request and trade-offs
  - risk/owner/next-action completeness
  - whether profile injection corrects the requester's tendency to over-explain process

### OFFICE-02: Monthly business review from synthetic KPI data

- `case_id`: `qprofile-v1-office-02-growth-mbr`
- status: `DRAFT_REVIEW`
- presentation job: turn a KPI table into an insight-and-action narrative
- target page count: 10
- expected speaking duration: 15 minutes
- requester profile:
  - role: growth operations manager for a consumer subscription app
  - experience: 6 years in operations, 2 years owning the monthly business review
  - organization: 320-person internet company; synthetic context
  - working style: strong with data extraction but tends to place every metric on slides
  - recurring concern: management says the report is comprehensive but does not explain what changed or what to do next
  - communication preference: highlight exceptions, show comparisons, and attach owners and deadlines to actions
- audience:
  - general manager, heads of product, marketing, and customer service
  - needs a decision-ready overview rather than raw operational detail
- Query:
  - Create a 10-slide Chinese July monthly business review for a 15-minute management meeting from these synthetic figures: new users 128,000 versus target 120,000; activation rate 41% versus target 46%; paid conversion 7.8% versus target 8.5%; monthly revenue RMB 9.6 million versus target RMB 10 million; customer-acquisition cost RMB 68 versus target RMB 60; day-30 retention 24% versus June 27%; refund rate 3.1% versus June 2.2%. Identify the three most important messages, distinguish facts from hypotheses, show the most useful comparisons, and propose no more than four actions with owners and deadlines.
- primary evaluation focus:
  - mathematical fidelity and denominator clarity
  - prioritization rather than metric dumping
  - fact/hypothesis separation
  - chart choice, annotation, and executive readability
  - actionable recommendations with owners and deadlines

### OFFICE-03: Blameless launch retrospective

- `case_id`: `qprofile-v1-office-03-launch-retrospective`
- status: `DRAFT_REVIEW`
- presentation job: explain failure causally without turning the deck into a blame document
- target page count: 12
- expected speaking duration: 30 minutes
- requester profile:
  - role: cross-functional program manager coordinating product, engineering, operations, and customer service
  - experience: 7 years
  - organization: online retail business; synthetic context
  - working style: emphasizes accountability but is cautious after a tense launch week
  - recurring concern: retrospective decks either hide the real causes or name individuals in ways that stop open discussion
  - communication preference: timeline, system causes, evidence, and concrete prevention mechanisms; no decorative celebration imagery
- audience:
  - functional leads and team representatives who participated in the launch
  - knows many incident details but does not share one causal account
- Query:
  - Create a 12-slide Chinese blameless retrospective for a delayed promotion launch. Planned go-live was 10:00; the actual go-live was 14:35. At 09:20 the final price list changed, at 09:50 operations uploaded the new file, at 10:05 validation found 312 mismatched SKUs, at 11:10 engineering discovered that the rollback script had not been tested on the latest schema, and at 13:40 validation passed. Customer service received 486 related inquiries. Build a factual timeline, separate trigger, contributing conditions, and detection gaps, quantify impact without inventing revenue loss, and end with preventive actions, owners, and deadlines.
- primary evaluation focus:
  - timestamp and quantity fidelity
  - causal structure without unsupported root-cause certainty
  - blame-free but accountable tone
  - separation of trigger, contributing condition, detection gap, and impact
  - actionable prevention items with ownership

## Approval record

The product owner approved the six Case definitions and the controlled experiment on 2026-08-10. The frozen records use these stable IDs:

- `case:qprofile-v1-edu-01-digital-rumor-class-meeting:v1.0.0`
- `case:qprofile-v1-edu-02-newton-first-law:v1.0.0`
- `case:qprofile-v1-edu-03-transition-parent-meeting:v1.0.0`
- `case:qprofile-v1-office-01-project-status-decision:v1.0.0`
- `case:qprofile-v1-office-02-growth-mbr:v1.0.0`
- `case:qprofile-v1-office-03-launch-retrospective:v1.0.0`

The approval covered:

- Query wording;
- requester profile and which fields are treated as memory;
- audience and use context;
- page count and duration;
- control/treatment visibility;
- reference-pack requirements;
- whether the case is accepted, revised, or rejected.

Each frozen payload has `case_version = 1.0.0` and a verified SHA-256 hash. Editing a confirmed Case creates a new version rather than overwriting the approved payload.
