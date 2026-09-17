import type { CrawlResult, Finding, PageReport } from './types.js';

/** Pure report builders: data in, strings out. No filesystem here (that is the sink's job). */

export function buildFindingsJson(result: CrawlResult): string {
  return JSON.stringify(
    {
      baseUrl: result.baseUrl,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      summary: summarize(result.findings),
      findings: result.findings,
      pages: result.pages,
    },
    null,
    2,
  );
}

interface Summary {
  defects: number;
  taste: number;
  byType: Record<string, number>;
}

function summarize(findings: Finding[]): Summary {
  const s: Summary = { defects: 0, taste: 0, byType: {} };
  for (const f of findings) {
    if (f.bucket === 'defect') s.defects++;
    else s.taste++;
    s.byType[f.type] = (s.byType[f.type] ?? 0) + 1;
  }
  return s;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findingRow(f: Finding): string {
  const cls = f.bucket === 'defect' ? 'defect' : 'taste';
  const sev = `<span class="sev sev-${esc(f.severity)}">${esc(f.severity)}</span>`;
  const sel = f.evidence.selector ? `<code>${esc(f.evidence.selector)}</code>` : '';
  const console = f.evidence.consoleText?.length
    ? `<pre class="console">${esc(f.evidence.consoleText.join('\n'))}</pre>`
    : '';
  const triage = f.triage ? `<span class="triage">${esc(f.triage.by)}: ${esc(f.triage.verdict)}</span>` : '';
  const shot =
    f.evidence.screenshot && f.evidence.screenshot !== currentPageShot
      ? `<a href="${esc(f.evidence.screenshot)}" target="_blank">screenshot</a>`
      : '';

  let contrastBlock = '';
  if (f.evidence.contrast) {
    const c = f.evidence.contrast;
    contrastBlock = `<div class="contrast-row">
      <span class="swatch" style="background:${esc(c.bg)};color:${esc(c.fg)}">Aa</span>
      <span class="ratio-badge">${esc(c.ratio)}:1</span>
      <span class="subtle">fg: ${esc(c.fg)} · bg: ${esc(c.bg)} · ${esc(c.fontSize)}</span>
    </div>`;
  }

  let spacingBlock = '';
  if (f.evidence.spacing) {
    const sp = f.evidence.spacing;
    spacingBlock = `<div class="spacing-row">
      <span class="spacing-badge">${esc(sp.distancePx)}px</span>
      <span class="subtle">${sp.otherSelector ? `gap to ${esc(sp.otherSelector)}` : 'touch target size'}</span>
    </div>`;
  }

  let affordanceBlock = '';
  if (f.evidence.affordance) {
    const aff = f.evidence.affordance;
    const details: string[] = [];
    if (!aff.hadPointer) details.push('cursor: default');
    if (!aff.hadHoverChange) details.push('no :hover delta');
    if (!aff.hadFocusChange) details.push('no :focus delta');
    if (aff.hadActiveChange !== undefined && !aff.hadActiveChange) details.push('no :active delta');

    const transitions = [
      ...(aff.hoverChanges?.slice(0, 2).map((c) => `hover: ${c}`) ?? []),
      ...(aff.activeChanges?.slice(0, 2).map((c) => `active: ${c}`) ?? []),
      ...(aff.focusChanges?.slice(0, 2).map((c) => `focus: ${c}`) ?? []),
    ];

    const transitionText = transitions.length ? transitions.join(' · ') : 'no visual style transition on interaction';

    affordanceBlock = `<div class="affordance-row">
      <span class="affordance-badge">${esc(details.join(' · ') || 'missing feedback')}</span>
      <span class="subtle">${esc(transitionText)}</span>
    </div>`;
  }

  return `<li class="finding ${cls}">
    <div class="finding-head">${sev}<span class="ftype">${esc(f.type)}</span>${triage}</div>
    <div class="ftitle">${esc(f.title)}</div>
    <div class="fmeta">${sel} ${shot}</div>
    ${contrastBlock}
    ${spacingBlock}
    ${affordanceBlock}
    ${console}
  </li>`;
}

// Used only to avoid repeating the page's own screenshot link inside its findings.
let currentPageShot: string | undefined;

/**
 * Coverage note for a page. A capped sweep must never read as full coverage: a control
 * that was never probed is an untested control, not a clean one.
 */
function controlSummary(page: PageReport): string {
  if (page.probedControls === undefined) return `${page.controlCount} controls`;
  const base = `${page.controlCount} controls · ${page.probedControls} probed`;
  return page.skippedControls ? `${base} · ${page.skippedControls} skipped (cap)` : base;
}

function pageSection(page: PageReport, findings: Finding[]): string {
  currentPageShot = page.screenshot;
  const mine = findings.filter((f) => f.route === page.route);
  const defects = mine.filter((f) => f.bucket === 'defect').length;
  const taste = mine.filter((f) => f.bucket === 'taste').length;
  const statusCls = page.status && page.status >= 400 ? 'bad' : page.status ? 'ok' : 'unknown';
  const img = page.screenshot ? `<img loading="lazy" src="${esc(page.screenshot)}" alt="${esc(page.route)}">` : '<div class="noimg">no screenshot</div>';
  const findingList = mine.length ? `<ul class="findings">${mine.map(findingRow).join('')}</ul>` : '<p class="clean">No findings.</p>';
  const consoleErrs = page.consoleErrors.length
    ? `<details><summary>${page.consoleErrors.length} console error(s)</summary><pre class="console">${esc(page.consoleErrors.join('\n'))}</pre></details>`
    : '';
  const failed = page.failedRequests.length
    ? `<details><summary>${page.failedRequests.length} failed request(s)</summary><pre class="console">${esc(page.failedRequests.map((r) => `${r.status ?? ''} ${r.url} ${r.failure ?? ''}`).join('\n'))}</pre></details>`
    : '';

  let paletteBar = '';
  if (page.palette && (page.palette.backgrounds.length || page.palette.accents.length)) {
    const dots = [
      ...page.palette.backgrounds.map((c) => `<span class="color-dot" style="background:${esc(c)}" title="bg: ${esc(c)}"></span>`),
      page.palette.accents.length ? '<span class="palette-sep"></span>' : '',
      ...page.palette.accents.map((c) => `<span class="color-dot" style="background:${esc(c)}" title="accent: ${esc(c)}"></span>`),
    ].join('');
    paletteBar = `<div class="palette-bar"><span class="palette-title">Palette</span>${dots}</div>`;
  }

  return `<section class="page">
    <div class="page-shot">${img}</div>
    <div class="page-body">
      <h2>${esc(page.route)} <span class="status ${statusCls}">${esc(page.status ?? 'ERR')}</span></h2>
      <div class="counts"><span class="pill defect">${defects} defect</span><span class="pill taste">${taste} taste</span><span class="pill muted">${esc(controlSummary(page))}</span></div>
      ${paletteBar}
      ${consoleErrs}${failed}
      ${findingList}
    </div>
  </section>`;
}

// A finding whose route was never crawled owns no page section. Rendering it here
// keeps the body consistent with the header totals instead of dropping it silently.
function uncrawledSection(route: string, findings: Finding[]): string {
  currentPageShot = undefined;
  const defects = findings.filter((f) => f.bucket === 'defect').length;
  const taste = findings.filter((f) => f.bucket === 'taste').length;
  return `<section class="page">
    <div class="page-shot"><div class="noimg">not crawled</div></div>
    <div class="page-body">
      <h2>${esc(route)} <span class="status unknown">uncrawled</span></h2>
      <div class="counts"><span class="pill defect">${defects} defect</span><span class="pill taste">${taste} taste</span><span class="pill muted">${findings.length} findings</span></div>
      <ul class="findings">${findings.map(findingRow).join('')}</ul>
    </div>
  </section>`;
}

export function buildGalleryHtml(result: CrawlResult): string {
  const s = summarize(result.findings);
  const pages = result.pages.map((p) => pageSection(p, result.findings)).join('\n');
  const crawledRoutes = new Set(result.pages.map((p) => p.route));
  const uncrawled = [...new Set(result.findings.map((f) => f.route))]
    .filter((route) => !crawledRoutes.has(route))
    .map((route) => uncrawledSection(route, result.findings.filter((f) => f.route === route)))
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ui-crawl — ${esc(result.baseUrl)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #0b0d10; color: #e6e8eb; }
  header { position: sticky; top: 0; background: #11151a; border-bottom: 1px solid #222; padding: 14px 20px; z-index: 5; }
  header h1 { margin: 0 0 6px; font-size: 16px; }
  header .sub { color: #8b949e; font-size: 12px; }
  .totals { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.defect { background: #3d1418; color: #ff9a9a; }
  .pill.taste { background: #3a2e0e; color: #f2cf6b; }
  .pill.muted { background: #1c2128; color: #8b949e; }
  main { padding: 16px 20px; display: grid; gap: 16px; }
  .page { display: grid; grid-template-columns: 320px 1fr; gap: 16px; background: #11151a; border: 1px solid #222; border-radius: 10px; overflow: hidden; }
  .page-shot { background: #06080a; }
  .page-shot img { width: 100%; display: block; }
  .noimg { padding: 40px; text-align: center; color: #6b727c; }
  .page-body { padding: 14px 16px; min-width: 0; }
  .page-body h2 { margin: 0 0 8px; font-size: 14px; word-break: break-all; }
  .status { font-size: 11px; padding: 1px 7px; border-radius: 5px; vertical-align: middle; }
  .status.ok { background: #14301c; color: #7ee2a8; }
  .status.bad { background: #3d1418; color: #ff9a9a; }
  .status.unknown { background: #2a2f36; color: #9aa4af; }
  .counts { display: flex; gap: 6px; margin-bottom: 10px; }
  ul.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .finding { border-left: 3px solid #444; padding: 8px 10px; border-radius: 6px; background: #0d1117; }
  .finding.defect { border-left-color: #f85149; }
  .finding.taste { border-left-color: #d29922; }
  .finding-head { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; }
  .ftype { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: .04em; }
  .ftitle { font-weight: 600; }
  .fmeta { font-size: 12px; color: #8b949e; margin-top: 3px; }
  .fmeta code { background: #161b22; padding: 1px 5px; border-radius: 4px; }
  .sev { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .sev-high { background: #3d1418; color: #ff9a9a; }
  .sev-medium { background: #3a2e0e; color: #f2cf6b; }
  .sev-low { background: #1c2128; color: #9aa4af; }
  .triage { font-size: 11px; color: #58a6ff; margin-left: auto; }
  .console { background: #06080a; color: #ff9a9a; padding: 8px; border-radius: 5px; overflow: auto; font-size: 11px; max-height: 160px; }
  .contrast-row, .spacing-row, .affordance-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
  .swatch { display: inline-block; padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 11px; border: 1px solid rgba(255,255,255,0.15); }
  .ratio-badge { background: #3d1418; color: #ff9a9a; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 11px; }
  .spacing-badge, .affordance-badge { background: #3a2e0e; color: #f2cf6b; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 11px; }
  .subtle { color: #8b949e; font-size: 11px; }
  .palette-bar { display: flex; align-items: center; gap: 5px; margin: 8px 0 12px; padding: 4px 8px; background: #0d1117; border-radius: 6px; }
  .palette-title { font-size: 11px; color: #8b949e; margin-right: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .palette-sep { width: 1px; height: 12px; background: #30363d; margin: 0 4px; }
  .color-dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); display: inline-block; }
  @media (max-width: 720px) { .page { grid-template-columns: 1fr; } }
</style></head>
<body>
<header>
  <h1>ui-crawl report</h1>
  <div class="sub">${esc(result.baseUrl)} · ${result.pages.length} pages · ${esc(result.startedAt)}</div>
  <div class="totals">
    <span class="pill defect">${s.defects} defects</span>
    <span class="pill taste">${s.taste} taste questions</span>
    <span class="pill muted">${result.pages.length} pages crawled</span>
  </div>
</header>
<main>${pages}${uncrawled}</main>
</body></html>`;
}
