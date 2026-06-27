export const meta = {
  name: 'digest-pipeline',
  description: 'The full DIGEST production pipeline (CLAUDE.md §5): fan the investigator out per domain → verifier per domain (trust gate) → consolidator (global cluster) → summarizer (Opus prose) → renderer (media + schema-validate + inject into the frozen template). Data-fill only; never regenerates HTML/CSS.',
  phases: [
    { title: 'Investigate + Verify', detail: 'per domain: WebFetch the open web + recover blocked sources, then gate-trim on trust' },
    { title: 'Consolidate', detail: 'global view: cluster the gated pool into one story per event', model: 'sonnet' },
    { title: 'Summarize', detail: 'Opus writes head/brief/tldr/why, grounded only in excerpts', model: 'opus' },
    { title: 'Render', detail: 'harvest real og:images, schema-validate, inject into prototype.html, write the run' },
  ],
}

// ── Prerequisite ──────────────────────────────────────────────────────────────
// The five news-* agents live in .claude/agents/. New agent files only enter the
// Agent registry at SESSION STARTUP, so this workflow's agentType:'news-*' calls
// require a fresh session after those files were created. If a call errors with
// "agent type not found", restart the session and re-run.
//
// ── Cost design (CLAUDE.md §5) ────────────────────────────────────────────────
// Models are set explicitly per stage because the §5 blueprint prescribes them:
// investigator/verifier/consolidator/renderer = sonnet (cheap), summarizer = opus
// (low-volume, high-stakes prose). We do NOT inherit the main-loop model here.
//
// ── Perf note (from the gamedev dry-run) ──────────────────────────────────────
// One domain's investigator returned a single large final payload that stalled
// mid-stream once. For production, consider having each stage WRITE its JSON to
// runs/<runDir>/.work/ and return a path + summary, so the next stage reads a file
// instead of receiving a huge inline payload. This draft passes JSON inline for
// clarity; switch to file-handoff if payloads stall.

const TEMPLATE = (args && args.templatePath) || 'prototype.html'

// Per-domain discovery config — sensible defaults (override via args.domains).
const DOMAINS = (args && args.domains) || [
  {
    domain: 'ai',
    seedSites: [
      'https://www.anthropic.com/news',
      'https://openai.com/news/',
      'https://deepmind.google/discover/blog/',
      'https://www.theverge.com/ai-artificial-intelligence',
    ],
    queryPacks: [
      'new AI model release this week',
      'AI agent tooling announcement',
      'frontier model research paper',
    ],
  },
  {
    domain: 'markets',
    seedSites: [
      'https://www.federalreserve.gov/newsevents/pressreleases.htm',
      'https://nvidianews.nvidia.com/',
      'https://www.theedgemalaysia.com/',
      'https://www.thestar.com.my/business',
    ],
    queryPacks: [
      'Bursa Malaysia semiconductor data centre order',
      'Fed interest rate decision dot plot',
      'HBM memory data center earnings US semiconductor',
    ],
  },
  {
    domain: 'gamedev',
    seedSites: [
      'https://dev.epicgames.com/community/',
      'https://www.unrealengine.com/en-US/news',
      'https://80.lv/',
    ],
    queryPacks: [
      'Unreal Engine release notes new version',
      'Unreal Engine 6 news',
      'UE5 rendering Nanite Lumen feature',
    ],
  },
]

// Run inputs (orchestrator / cron supplies these via args).
const SINCE        = (args && args.since) || null          // "YYYY-MM-DD"; if null the investigator computes "last 7 days" via Bash date
const PREV_HEADS   = (args && args.prevKeptHeads) || []    // headlines already shipped last digest (investigator dedup)
const PREV_KEPT    = (args && args.prevKept) || 0          // the contract's top-level prevKept COUNT
const USER_PROFILE = (args && args.userProfile) ||
  'A Malaysia-based engineer building AI agents on Claude and doing UE5 work (Nanite, materials/shaders, Unreal Insights); an investor tracking semiconductors, data-center, and energy across US + Bursa Malaysia.'
const MIN_CONF     = (args && args.minConfidence) || 0.6
const MAX_STORIES  = (args && args.maxStories) || null     // null = no cap; rank by rel
const GENERATED_AT = (args && args.generatedAt) || null    // ISO string; if null the renderer stamps it via Bash date
const RUN_DIR      = (args && args.runDir) || null         // "runs/YYYYMMDD-HHMM"; if null the renderer derives it via Bash date

// ── Schemas (force structured returns matching each agent's output contract) ───

const ROW = {
  type: 'object',
  properties: {
    cat:{type:'string'}, type:{type:'string'}, publisher:{type:'string'}, handle:{type:'string'},
    url:{type:'string'}, time:{type:'string'}, claim:{type:'string'}, excerpt:{type:'string'},
    summary:{type:'string'}, discoveredVia:{type:'string'},
    reachable:{type:'boolean'}, recovered:{type:'boolean'},
    recoverVia:{type:['string','null']}, archiveUrl:{type:['string','null']},
    excerptVerified:{type:'boolean'},
  },
  required:['cat','type','publisher','url','time','claim','excerpt','reachable','recovered','excerptVerified'],
}

const INV_SCHEMA = {
  type:'object',
  properties:{
    cat:{type:'string'},
    rows:{type:'array', items:ROW},
    fetchAudit:{type:'object', properties:{
      attempted:{type:'number'}, recorded:{type:'number'}, recovered:{type:'number'},
      methods:{type:'object'}, dropped:{type:'array'}, notes:{type:'string'},
    }, required:['attempted','recorded','dropped']},
  },
  required:['cat','rows','fetchAudit'],
}

const KEPT_ROW = {
  type:'object',
  properties:{
    ...ROW.properties,
    tier:{type:'string', enum:['T1','T2']},
    confidence:{type:'number'},
    trustReason:{type:'string'},
  },
  required:['publisher','url','excerpt','tier','confidence','excerptVerified'],
}

const VER_SCHEMA = {
  type:'object',
  properties:{
    cat:{type:'string'},
    kept:{type:'array', items:KEPT_ROW},
    rejected:{type:'array', items:{type:'object', properties:{
      kind:{type:'string', enum:['lowtrust']}, publisher:{type:'string'}, url:{type:'string'},
      claim:{type:'string'}, confidence:{type:'number'}, reason:{type:'string'},
    }, required:['kind','url','reason']}},
    verifyAudit:{type:'object', properties:{
      scored:{type:'number'}, kept:{type:'number'}, rejected:{type:'number'},
      minConfidence:{type:'number'}, tierMix:{type:'object'}, notes:{type:'string'},
    }, required:['scored','kept','rejected']},
  },
  required:['cat','kept','rejected','verifyAudit'],
}

const CONS_SCHEMA = {
  type:'object',
  properties:{
    stories:{type:'array', items:{type:'object', properties:{
      id:{type:'number'}, cat:{type:'string', enum:['ai','markets','gamedev']},
      type:{type:'string'}, time:{type:'string'}, eventClaim:{type:'string'}, rel:{type:'number'},
      sources:{type:'array', items:{type:'object', properties:{
        ...KEPT_ROW.properties, primary:{type:'boolean'},
      }, required:['publisher','url','excerpt','tier','primary']}},
    }, required:['id','cat','type','time','rel','sources']}},
    categories:{type:'object'},
    rejected:{type:'array', items:{type:'object', properties:{
      kind:{type:'string', enum:['redundant','recovered']}, publisher:{type:'string'},
      url:{type:'string'}, reason:{type:'string'}, method:{type:['string','null']},
    }, required:['kind','url','reason']}},
    consolidateAudit:{type:'object'},
  },
  required:['stories','consolidateAudit'],
}

const SUM_SCHEMA = {
  type:'object',
  properties:{
    stories:{type:'array', items:{type:'object', properties:{
      id:{type:'number'}, cat:{type:'string'}, type:{type:'string'}, time:{type:'string'}, rel:{type:'number'},
      head:{type:'string'}, brief:{type:'string'}, tldr:{type:'string'}, why:{type:'string'},
      tags:{type:'array', items:{type:'string'}},
      sentiment:{type:'string', enum:['up','down','none']},
      sources:{type:'array'},
    }, required:['id','head','brief','tldr','why','tags','sentiment','sources']}},
  },
  required:['stories'],
}

const REND_SCHEMA = {
  type:'object',
  properties:{
    ok:{type:'boolean'}, runDir:{type:'string'},
    storiesRendered:{type:'number'}, mediaFound:{type:'number'}, mediaMissing:{type:'number'},
    verified:{type:'number'}, filtered:{type:'number'},
    validationErrors:{type:'array', items:{type:'string'}},
    qaGate:{type:'string'}, notes:{type:'string'},
  },
  required:['ok','runDir','validationErrors'],
}

// ── Stage 1+2: per-domain investigate → verify (no cross-domain barrier) ───────

phase('Investigate + Verify')

const perDomain = await pipeline(
  DOMAINS,
  d => agent(
`Investigate the "${d.domain}" domain for DIGEST. Follow your operating instructions.
seedSites: ${JSON.stringify(d.seedSites)}
queryPacks: ${JSON.stringify(d.queryPacks)}
since: ${SINCE ? `"${SINCE}"` : 'null — compute "last 7 days" via Bash `date` and note it in fetchAudit.notes'}
prevKept: ${JSON.stringify(PREV_HEADS)}
Emit the investigator output object (cat, rows[], fetchAudit).`,
    {label:`investigate:${d.domain}`, phase:'Investigate + Verify', schema:INV_SCHEMA, agentType:'news-investigator', model:'sonnet'}
  ),
  async (inv, d) => {
    if (!inv || !inv.rows || !inv.rows.length) return null
    const ver = await agent(
`Verify (trust-gate) the "${d.domain}" investigator rows. Follow your operating instructions.
minConfidence: ${MIN_CONF}
rows: ${JSON.stringify(inv.rows)}
Emit the verifier output object (cat, kept[], rejected[], verifyAudit).`,
      {label:`verify:${d.domain}`, phase:'Investigate + Verify', schema:VER_SCHEMA, agentType:'news-verifier', model:'sonnet'}
    )
    if (!ver) return null
    // carry the investigator's fetchAudit forward so the renderer can build fallback[]/rejected[]
    return {...ver, fetchAudit: inv.fetchAudit}
  }
)

const live = perDomain.filter(Boolean)
const pool = live.flatMap(v => v.kept || [])
log(`Gated pool: ${pool.length} verified sources across ${live.length} domains`)
if (!pool.length) {
  log('Empty gated pool — nothing survived verification. Stopping before consolidate.')
  return { ok:false, reason:'empty gated pool', perDomain:live.map(v => ({cat:v.cat, kept:(v.kept||[]).length, rejected:(v.rejected||[]).length})) }
}

// ── Stage 3: consolidate (single global pass over the whole pool) ──────────────

phase('Consolidate')

const consolidated = await agent(
`Consolidate the gated pool into one story per event. Follow your operating instructions.
maxStories: ${MAX_STORIES === null ? 'null (no cap; rank by rel)' : MAX_STORIES}
pool: ${JSON.stringify(pool)}
Emit the consolidator output object (stories[], categories counts, consolidateAudit).`,
  {label:'consolidate', phase:'Consolidate', schema:CONS_SCHEMA, agentType:'news-consolidator', model:'sonnet'}
)
if (!consolidated || !consolidated.stories || !consolidated.stories.length) {
  return { ok:false, reason:'consolidator produced no stories', poolSize:pool.length }
}
log(`Consolidated ${pool.length} sources → ${consolidated.stories.length} stories`)

// ── Stage 4: summarize (single Opus pass over all stories; keeps briefs distinct) ─

phase('Summarize')

const summarized = await agent(
`Write the reader-facing prose for every story, strictly grounded in the source excerpts. Follow your operating instructions.
Keep every brief distinct (no brief == its head; no two briefs equal). Cite with [n] into each story's own sources[].
userProfile: ${JSON.stringify(USER_PROFILE)}
stories: ${JSON.stringify(consolidated.stories)}
Emit { stories: [...] } with head/brief/tldr/why/tags/sentiment added and all other fields preserved.`,
  {label:'summarize', phase:'Summarize', schema:SUM_SCHEMA, agentType:'news-summarizer', model:'opus'}
)
if (!summarized || !summarized.stories || !summarized.stories.length) {
  return { ok:false, reason:'summarizer produced no stories', stories:consolidated.stories.length }
}

// ── Stage 5: render (media + schema-validate + inject + write the run) ─────────

phase('Render')

const auditTrails = {
  fetchAudits:  live.map(v => v.fetchAudit).filter(Boolean),
  verifyAudits: live.map(v => ({cat:v.cat, rejected:v.rejected || [], verifyAudit:v.verifyAudit})), // kind:"lowtrust"
  consolidatorRejected: consolidated.rejected || [],   // kind:"redundant" | "recovered"
  consolidateAudit: consolidated.consolidateAudit,
}
const runMeta = { generatedAt: GENERATED_AT, prevKept: PREV_KEPT, runDir: RUN_DIR }

const rendered = await agent(
`Render the final DIGEST. IMPORTANT: use Read/Write/Bash tools for ALL file I/O — do NOT output file contents as text. Keep your text response minimal (tool calls + final JSON only).

Steps:
1. For each story, WebFetch its primary source URL and extract the og:image. Real newsroom asset only; if not genuine set src:"".
2. Read templatePath with the Read tool. Extract categories block and existing const DIGEST literal.
3. Assemble the full DIGEST object in memory. Format each story time to short display form (e.g. "Jun 27"). Schema-validate — stop and return ok:false if invalid.
4. Splice the new DIGEST object into the template (replace only the const DIGEST = {...}; literal). Write to runs/<runDir>/report.html using the Write tool. Do not touch any HTML/CSS/JS.
5. Write digest.json and audit.json using the Write tool.
6. Run QA gate via Bash: python .qa/check.py --file runs/<runDir>/report.html
7. Return ONLY your output contract JSON — no file contents in text.

templatePath: ${JSON.stringify(TEMPLATE)}
If runMeta.generatedAt / runMeta.runDir are null, stamp them via Bash \`date\` (YYYYMMDD-HHMM for runDir).
runMeta: ${JSON.stringify(runMeta)}
auditTrails: ${JSON.stringify(auditTrails)}
stories: ${JSON.stringify(summarized.stories)}`,
  {label:'render', phase:'Render', schema:REND_SCHEMA, agentType:'news-renderer', model:'sonnet'}
)

log(rendered && rendered.ok
  ? `Rendered ${rendered.storiesRendered} stories → ${rendered.runDir} (verified ${rendered.verified} · filtered ${rendered.filtered} · QA ${rendered.qaGate})`
  : `Render did NOT complete cleanly: ${rendered ? JSON.stringify(rendered.validationErrors) : 'no result'}`)

return {
  ok: !!(rendered && rendered.ok),
  runDir: rendered && rendered.runDir,
  domains: live.map(v => v.cat),
  pooled: pool.length,
  stories: summarized.stories.length,
  render: rendered,
}
