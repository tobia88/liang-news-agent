export const meta = {
  name: 'digest-text-qa',
  description: 'Audit every rendered surface of the DIGEST news report for text bugs (duplication, overlap, clipping, leaked templates, copy/grammar) and adversarially verify each finding to drop false positives',
  phases: [
    { title: 'Audit', detail: 'one agent per render surface, against a text-bug taxonomy' },
    { title: 'Verify', detail: 'independently refute each finding to kill false positives' },
  ],
}

const FILE = 'f:\\AI\\liang-news-agent\\prototype.html'

// Audit method + text-bug taxonomy now live in the news-qa-auditor project agent
// (.claude/agents/news-qa-auditor.md); refute-by-default method lives in news-qa-verifier.
// This workflow only fans out per-surface / per-finding data to those named agents.

const SURFACES = [
  {key:'ticker',     fns:'buildTicker',                          css:'.ticker, .tick-item'},
  {key:'brief-meta', fns:'renderBriefMeta, readMins',            css:'.brief-meta'},
  {key:'lede',       fns:'renderLede',                           css:'.lede, .lede-head, .lede-brief, .lede-kicker, .lede-bottom, .lede-media'},
  {key:'tldr',       fns:'renderTLDR',                           css:'.tldr, .tldr-head, .tldr-row, .tldr-row .t'},
  {key:'cards',      fns:'storyCard, drawReadNext, renderFeed, mediaThumb', css:'.story, .s-head, .s-brief, .s-top, .s-foot, .s-srcs, .s-go, .cat-chip, .hot-badge, .s-time'},
  {key:'article',    fns:'openArticle, parseCites, confidenceOf, mediaInner', css:'.art-hero, .art-meta, .art-head, .art-why, .art-sec, .art-txt, .src-item, .src-quote, .src-tier, .src-meta, .src-go, .art-srchead'},
  {key:'trust',      fns:'drawFunnel, drawCredMix, wireTrust',   css:'.trust-zone, .trust-pill, .funnel, .credmix, .audit-list, .reject-break'},
  {key:'chrome',     fns:'stamps, tickClock, init (header markup)', css:'.brand, .tabs, .tab, .topbar, .clock, .live, .section-head'},
]

const FINDINGS_SCHEMA = {
  type:'object',
  properties:{
    surface:{type:'string'},
    findings:{type:'array', items:{
      type:'object',
      properties:{
        type:{type:'string', enum:['DUP','OVERLAP','CLIP','OVERFLOW','LEAK','GLYPH','COPY','TRUNC']},
        severity:{type:'string', enum:['high','med','low']},
        text:{type:'string', description:'the exact buggy text or element as it renders'},
        location:{type:'string', description:'function name + approx line number and/or CSS selector'},
        explanation:{type:'string', description:'what is wrong and why a reader would notice'},
        suggestedFix:{type:'string', description:'concrete change'}
      },
      required:['type','severity','text','location','explanation','suggestedFix']
    }}
  },
  required:['surface','findings']
}

const VERDICT_SCHEMA = {
  type:'object',
  properties:{
    isReal:{type:'boolean', description:'true only if the code+data genuinely produce this and it is a real defect, not intended design'},
    confidence:{type:'string', enum:['high','med','low']},
    reasoning:{type:'string'},
    refinedFix:{type:'string'}
  },
  required:['isReal','confidence','reasoning','refinedFix']
}

phase('Audit')

const results = await pipeline(
  SURFACES,
  s => agent(
    `Audit ONE surface of the DIGEST HTML report for text bugs.
File: ${FILE}
Surface: "${s.key}".  Render function(s) to study: ${s.fns}.  Relevant CSS classes: ${s.css}.
Follow your auditing method and the text-bug taxonomy. Report ONLY concrete, defensible findings for THIS surface; empty findings array if clean.`,
    {label:`audit:${s.key}`, phase:'Audit', schema:FINDINGS_SCHEMA, agentType:'news-qa-auditor'}
  ),
  (res, s) => (res && res.findings && res.findings.length)
    ? parallel(res.findings.map(f => () =>
        agent(
          `Refute (or confirm) this reported text bug by re-reading the actual code + DIGEST data.
File: ${FILE}
Surface: ${s.key}
Reported [${f.type} / ${f.severity}]: ${f.explanation}
Rendered text/element: ${f.text}
Claimed location: ${f.location}
Proposed fix: ${f.suggestedFix}`,
          {label:`verify:${s.key}`, phase:'Verify', schema:VERDICT_SCHEMA, agentType:'news-qa-verifier'}
        ).then(v => ({...f, surface:s.key, verdict:v}))
      ))
    : []
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter(x => x.verdict && x.verdict.isReal)
const order = {high:0, med:1, low:2}
confirmed.sort((a,b) => (order[a.severity]-order[b.severity]) || a.surface.localeCompare(b.surface))
log(`Audited ${SURFACES.length} surfaces · ${all.length} raw findings · ${confirmed.length} confirmed after verify`)
return {
  surfaces: SURFACES.length,
  rawFindings: all.length,
  confirmedCount: confirmed.length,
  confirmed: confirmed.map(x => ({surface:x.surface, type:x.type, severity:x.severity, text:x.text, location:x.location, explanation:x.explanation, fix:x.verdict.refinedFix, confidence:x.verdict.confidence})),
}
