# -*- coding: utf-8 -*-
import json, re, os
from playwright.sync_api import sync_playwright

import argparse as _ap, pathlib as _pl
_pa = _ap.ArgumentParser(description='DIGEST Playwright render check')
_pa.add_argument('--file', default=None, help='Path or file:// URL of the HTML report to check')
_pargs = _pa.parse_args()
if _pargs.file:
    _f = _pargs.file
    FILE = _f if _f.startswith('file://') else _pl.Path(_f).resolve().as_uri()
else:
    FILE = "file:///F:/AI/liang-news-agent/prototype.html"
OUT  = r"F:\AI\liang-news-agent\.qa"
os.makedirs(OUT, exist_ok=True)

def norm(t):
    t = re.sub(r"\s+", " ", (t or "").strip()).lower()
    return t.strip(" .…·,;:—–-")

report = {"dupes": [], "clamped": [], "clipped": [], "viewport_overflow": None,
          "leaks": [], "tldr_count": None, "lede_in_tldr": None, "tabs": {}, "modal_opened": None}

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width":1440,"height":900}, device_scale_factor=2)
    page.goto(FILE, wait_until="domcontentloaded")
    page.wait_for_selector(".lede-head", timeout=15000)  # .tldr-row absent on small (<5 story) reports
    page.wait_for_timeout(1500)
    page.screenshot(path=os.path.join(OUT,"dashboard.png"), full_page=True)

    # ---- 1. cross-surface duplicate text (same-screen dashboard: lede + tldr + read-next) ----
    items = page.eval_on_selector_all(
        "#view-dashboard .lede-head, #view-dashboard .lede-brief, #view-dashboard .tldr-row .tx, #view-dashboard #read-next .s-head, #view-dashboard #read-next .s-brief",
        """els => els.map(e => ({
            surface: e.classList.contains('lede-head') ? 'lede:head'
                   : e.classList.contains('lede-brief') ? 'lede:brief'
                   : e.classList.contains('tx') ? 'tldr'
                   : e.classList.contains('s-head') ? 'readnext:head'
                   : e.classList.contains('s-brief') ? 'readnext:brief' : 'other',
            text: e.textContent.trim()
        }))"""
    )
    groups = {}
    for it in items:
        k = norm(it["text"])
        if k: groups.setdefault(k, []).append(it)
    for g in groups.values():
        if len(g) > 1:
            report["dupes"].append({"text": g[0]["text"], "count": len(g),
                                    "surfaces": sorted(set(x["surface"] for x in g))})

    # explicit regression: is the lede story's brief also a tldr row?
    lede_brief = page.eval_on_selector("#view-dashboard .lede-brief", "e => e.textContent.trim()")
    tldr_texts = page.eval_on_selector_all("#view-dashboard .tldr-row .tx", "els => els.map(e=>e.textContent.trim())")
    report["tldr_count"] = len(tldr_texts)
    report["lede_in_tldr"] = norm(lede_brief) in [norm(t) for t in tldr_texts]

    # ---- 2. line-clamped (text cut by -webkit-line-clamp) + 3. true clipping ----
    clamp_clip = page.eval_on_selector_all(
        "#view-dashboard *",
        """els => els.filter(e => e.children.length===0 && e.textContent.trim().length>0
                                  && !e.closest('#ticker') && e.clientWidth>0 && e.clientHeight>0)
            .map(e => {
                const cs = getComputedStyle(e);
                const clamped = cs.webkitLineClamp && cs.webkitLineClamp!=='none' && e.scrollHeight > e.clientHeight+2;
                const hClip = cs.overflowX!=='visible' && e.scrollWidth > e.clientWidth+1;
                const vClip = !clamped && cs.overflowY!=='visible' && cs.display!=='inline' && e.scrollHeight > e.clientHeight+2;
                if (clamped || hClip || vClip)
                    return {cls:e.className||e.tagName.toLowerCase(),
                            kind: clamped?'line-clamp':(hClip?'horizontal':'vertical'),
                            text:e.textContent.trim().slice(0,90)};
                return null;
            }).filter(Boolean)"""
    )
    report["clamped"] = [c for c in clamp_clip if c["kind"]=="line-clamp"]
    report["clipped"] = [c for c in clamp_clip if c["kind"]!="line-clamp"]

    # ---- 4. viewport horizontal overflow ----
    vp = page.evaluate("() => ({docW: document.documentElement.scrollWidth, winW: window.innerWidth})")
    if vp["docW"] > vp["winW"]+1: report["viewport_overflow"] = vp

    # ---- 5. un-interpolated template / placeholder leaks (whole DOM) ----
    vis = page.inner_text("body")  # rendered text only — excludes <script>/<style>, avoids false ${ } hits in JS source
    for pat in ["${", "[object Object]", "undefined", "NaN"]:
        if pat in vis:
            i = vis.find(pat); report["leaks"].append({"pattern":pat,"snippet":vis[max(0,i-40):i+40]})

    # ---- 6. tab sweep: screenshots + clamped briefs per view ----
    for tab in ["ai","markets","gamedev"]:
        page.click(f'.tab[data-tab="{tab}"]'); page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(OUT,f"tab-{tab}.png"), full_page=True)
        clamped_n = page.eval_on_selector_all(
            f"#view-{tab} .s-brief",
            "els => els.filter(e => { const cs=getComputedStyle(e); return cs.webkitLineClamp!=='none' && e.scrollHeight>e.clientHeight+2; }).length"
        )
        # also dup check within this single visible view (head vs brief per card)
        dups_v = page.eval_on_selector_all(
            f"#view-{tab} .story",
            """els => els.filter(s => { const h=s.querySelector('.s-head'), b=s.querySelector('.s-brief');
                return h&&b && h.textContent.trim().replace(/[.\\s]+$/,'').toLowerCase()===b.textContent.trim().replace(/[.\\s]+$/,'').toLowerCase(); })
              .map(s => s.querySelector('.s-head').textContent.trim())"""
        )
        report["tabs"][tab] = {"briefs_clamped": clamped_n, "head_eq_brief": dups_v}

    # ---- 7. open an article modal, screenshot ----
    page.click('.tab[data-tab="dashboard"]'); page.wait_for_timeout(300)
    page.click("#read-next .story"); page.wait_for_timeout(700)
    report["modal_opened"] = page.is_visible("#article-modal.open")
    if report["modal_opened"]:
        page.screenshot(path=os.path.join(OUT,"article-modal.png"))

    browser.close()

print("="*70)
print("PLAYWRIGHT RENDER CHECK")
print("="*70)
print(f"TL;DR rows rendered: {report['tldr_count']}  (lede story also in TL;DR? {report['lede_in_tldr']})")
print(f"Cross-surface duplicate strings (dashboard): {len(report['dupes'])}")
for d in report["dupes"]:
    print(f"   x{d['count']} {d['surfaces']}  \"{d['text'][:70]}\"")
print(f"True clipping bugs: {len(report['clipped'])} | line-clamped (info): {len(report['clamped'])}")
for c in report["clipped"]: print(f"   CLIP[{c['kind']}] .{c['cls']}: {c['text']}")
print(f"Viewport horizontal overflow: {report['viewport_overflow']}")
print(f"Template/placeholder leaks: {len(report['leaks'])}  {report['leaks']}")
for t,v in report["tabs"].items():
    print(f"Tab {t}: briefs clamped={v['briefs_clamped']}, head==brief cards={v['head_eq_brief']}")
print(f"Article modal opened OK: {report['modal_opened']}")
print("="*70)
print(json.dumps(report, ensure_ascii=False))
