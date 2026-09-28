import type { CrawlResult, DetectorFailure, Finding, FindingType, Severity, Bucket, SourceLocation, DiffResult } from './types.js';

export interface Summary {
  defects: number;
  taste: number;
  byType: Record<string, number>;
  /** Findings dropped by the per-page cap. Zero means the report is complete. */
  truncated: number;
}

export function summarize(findings: Finding[]): Summary {
  const s: Summary = { defects: 0, taste: 0, byType: {}, truncated: 0 };
  for (const f of findings) {
    if (f.bucket === 'defect') s.defects++;
    else s.taste++;
    s.byType[f.type] = (s.byType[f.type] ?? 0) + 1;
  }
  return s;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Bound the findings kept per route, keeping what matters and saying what was dropped.
 *
 * Without a cap one pathological page (500 same-style contrast hits, a generated table
 * with a thousand clipped cells) means hundreds of serial screenshots and a multi-MB
 * payload with no warning. The cap keeps defects over taste and high severity over low,
 * stably — detection order breaks ties, so repeated runs agree. The dropped count is
 * returned, never swallowed: the summary reports `truncated`, and zero means complete.
 */
export function capFindings(
  findings: Finding[],
  cap: number,
): { findings: Finding[]; truncated: number } {
  if (!Number.isFinite(cap) || cap <= 0) return { findings, truncated: 0 };
  const byRoute = new Map<string, number[]>();
  findings.forEach((f, i) => {
    const list = byRoute.get(f.route) ?? [];
    list.push(i);
    byRoute.set(f.route, list);
  });

  const keep = new Set<number>();
  let truncated = 0;
  for (const indices of byRoute.values()) {
    const ranked = [...indices].sort((a, b) => {
      const fa = findings[a];
      const fb = findings[b];
      if (fa.bucket !== fb.bucket) return fa.bucket === 'defect' ? -1 : 1;
      if (fa.severity !== fb.severity) return SEVERITY_ORDER[fa.severity] - SEVERITY_ORDER[fb.severity];
      return a - b;
    });
    for (const i of ranked.slice(0, cap)) keep.add(i);
    truncated += Math.max(0, ranked.length - cap);
  }
  return { findings: findings.filter((_, i) => keep.has(i)), truncated };
}

export interface AgentAction {
  id?: string;
  fingerprint?: string;
  route: string;
  type: FindingType;
  bucket: Bucket;
  severity: Severity;
  selector?: string;
  title: string;
  remediation?: string;
  source?: SourceLocation;
  /** Filtering vocabulary, from the rule table. */
  tags?: string[];
  /** Stable reference grounding the rule, when one exists. */
  helpUrl?: string;
  /**
   * Snapshot index of the finding's element — the `[n]` in a snapshot listing and the
   * badge `n` in a marked screenshot. Present when the element is a snapshot control.
   */
  snapshotIndex?: number;
  cropBase64?: string;
  /**
   * PNG file holding the same pixels as `cropBase64`, relative to the report directory.
   * Prefer this when you have filesystem access; the inline blob is for when you do not.
   */
  crop?: string;
  evidence?: {
    layout?: Record<string, unknown>;
    typography?: Record<string, unknown>;
    contrast?: Record<string, unknown>;
    clipping?: Record<string, unknown>;
    accessibility?: Record<string, unknown>;
    spacing?: Record<string, unknown>;
    hitTest?: Record<string, unknown>;
    theme?: 'light' | 'dark';
  };
}

export interface AgentGroup {
  /** Stable key: `src:<file>:<line>` when the site is known, else type + remediation. */
  key: string;
  /** How many actions share this root cause. */
  count: number;
  /** Worst bucket in the group — one defect makes the group a defect. */
  bucket: Bucket;
  /** Worst severity in the group. */
  severity: Severity;
  /** Distinct finding types in the group (one site can host several). */
  types: FindingType[];
  title: string;
  remediation?: string;
  source?: SourceLocation;
  fingerprints: Array<string | undefined>;
}

/**
 * Collapse actions that share a root cause so an agent fixes the site, not the symptoms.
 * Fifty low-contrast hits from one CSS variable are one edit; the group says so, with
 * the count to prove it. Grouping never drops anything — `actions` still carries every
 * finding, and fingerprints let a caller expand any group back to members.
 */
export function buildGroups(actions: AgentAction[]): AgentGroup[] {
  const order = new Map<string, AgentGroup & { rank: [number, number] }>();
  for (const a of actions) {
    const key = a.source?.file
      ? `src:${a.source.file}:${a.source.line ?? 0}`
      : `finding:${a.type}::${a.remediation ?? a.title}`;
    const bucketRank = a.bucket === 'defect' ? 0 : 1;
    const rank: [number, number] = [bucketRank, SEVERITY_ORDER[a.severity]];
    const existing = order.get(key);
    if (!existing) {
      order.set(key, {
        key,
        count: 1,
        bucket: a.bucket,
        severity: a.severity,
        types: [a.type],
        title: a.title,
        ...(a.remediation ? { remediation: a.remediation } : {}),
        ...(a.source ? { source: a.source } : {}),
        fingerprints: [a.fingerprint],
        rank,
      });
      continue;
    }
    existing.count++;
    if (!existing.types.includes(a.type)) existing.types.push(a.type);
    existing.fingerprints.push(a.fingerprint);
    if (rank[0] < existing.rank[0] || (rank[0] === existing.rank[0] && rank[1] < existing.rank[1])) {
      existing.rank = rank;
      existing.bucket = a.bucket;
      existing.severity = a.severity;
    }
  }
  return [...order.values()]
    .sort((x, y) => x.rank[0] - y.rank[0] || x.rank[1] - y.rank[1])
    .map(({ rank: _rank, ...g }) => g);
}

/** Defects before taste, high severity before low, detection order within ties. */
function sortActions(actions: AgentAction[]): AgentAction[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      if (x.a.bucket !== y.a.bucket) return x.a.bucket === 'defect' ? -1 : 1;
      if (x.a.severity !== y.a.severity) return SEVERITY_ORDER[x.a.severity] - SEVERITY_ORDER[y.a.severity];
      return x.i - y.i;
    })
    .map(({ a }) => a);
}

export interface PlanStep {
  /** Position in the work order, 1-based. */
  step: number;
  /** `src:<file>:<line>` when the site is known, else the type+remediation key. */
  key: string;
  /** How many findings this single edit is expected to clear. */
  count: number;
  /** One-line instruction the agent can act on. */
  do: string;
  /** Where to make the edit, when the framework could be identified. */
  file?: string;
  line?: number;
  /** The concrete edit, when the detector could name one. */
  remediation?: string;
  types: FindingType[];
  /** Where the defect is visible: a route, and the page render to look at. */
  route: string;
  screenshot?: string;
  /** One representative crop, if the run captured any. */
  crop?: string;
  cropBase64?: string;
  /** Snapshot index of a representative control, for a marked render. */
  snapshotIndex?: number;
  /** Ground truth to check the remediation against. */
  helpUrl?: string;
  tags?: string[];
}

export interface FixPlan {
  /** What "done" means, stated so the agent can decide when to stop without guessing. */
  done: boolean;
  /** Human-readable exit criteria — the loop's stopping condition. */
  exitCriteria: string;
  summary: {
    defects: number;
    taste: number;
    /** Root causes remaining. This is the number that must reach zero, not `defects`. */
    remainingGroups: number;
    pagesCrawled: number;
    truncated: number;
  };
  /** Ordered worst-first. Defects before taste, high severity first. */
  steps: PlanStep[];
  /** Findings that appeared since the baseline run, if a diff was computed. */
  regressions?: Array<{ type: string; route: string; title: string }>;
  /** How many findings the last edit cycle confirmed repaired. */
  fixed?: number;
  /** Taste questions, kept out of `steps` — they never block, and they are decisions, not edits. */
  tasteQuestions: Array<{ type: string; route: string; title: string }>;
}

/**
 * Turn a run into an ordered work order.
 *
 * The whole point is to hand the caller the part that is mechanical — group, order,
 * locate, prioritise, state the stopping condition — so it spends its budget on the parts
 * that need a mind: looking at the pixels and making the edit. One step per root cause,
 * not per symptom; `count` says how many findings the single edit clears, so fifty
 * contrast hits from one CSS variable read as one step that ends fifty findings.
 *
 * `done` is true only when no DEFECT group remains, so an agent never has to re-derive
 * the exit condition (or mistake "taste questions remain" for "still broken").
 */
export function buildFixPlan(result: CrawlResult, diff?: DiffResult): FixPlan {
  const payload = buildAgentPayload(result);
  const actionByFingerprint = new Map(
    payload.actions.filter((a) => a.fingerprint).map((a) => [a.fingerprint!, a]),
  );
  const pageByRoute = new Map(payload.pages.map((p) => [p.route, p]));

  const defectGroups = payload.groups.filter((g) => g.bucket === 'defect');
  const steps: PlanStep[] = defectGroups.map((group, i) => {
    const representative = group.fingerprints
      .map((fp) => (fp ? actionByFingerprint.get(fp) : undefined))
      .find(Boolean);
    const route = representative?.route ?? '';
    const page = pageByRoute.get(route);
    return {
      step: i + 1,
      key: group.key,
      count: group.count,
      do: group.remediation
        ? `Fix on ${group.source ? `${group.source.file}:${group.source.line ?? '?'}` : group.key}: ${group.remediation}`
        : `Investigate and fix ${group.types.join(' + ')} at ${group.key}`,
      ...(group.source?.file ? { file: group.source.file } : {}),
      ...(group.source?.line !== undefined ? { line: group.source.line } : {}),
      ...(group.remediation ? { remediation: group.remediation } : {}),
      types: group.types,
      route,
      ...(page?.screenshot ? { screenshot: page.screenshot } : {}),
      ...(representative?.crop ? { crop: representative.crop } : {}),
      ...(representative?.cropBase64 ? { cropBase64: representative.cropBase64 } : {}),
      ...(representative?.snapshotIndex !== undefined
        ? { snapshotIndex: representative.snapshotIndex }
        : {}),
      ...(representative?.helpUrl ? { helpUrl: representative.helpUrl } : {}),
      ...(representative?.tags ? { tags: representative.tags } : {}),
    };
  });

  const remainingGroups = steps.length;
  return {
    done: remainingGroups === 0,
    exitCriteria:
      remainingGroups === 0
        ? 'No defect groups remain — this run is done. Taste questions (if any) are decisions for a human or the caller, not defects.'
        : `${remainingGroups} defect root cause${remainingGroups === 1 ? '' : 's'} remaining. Re-run the audit after each edit; the loop is complete when done is true.`,
    summary: {
      defects: payload.summary.defects,
      taste: payload.summary.taste,
      remainingGroups,
      pagesCrawled: payload.summary.pagesCrawled,
      truncated: payload.summary.truncated,
    },
    steps,
    ...(diff
      ? {
          regressions: diff.regressions.map((f) => ({
            type: f.type,
            route: f.route,
            title: f.title,
          })),
          fixed: diff.fixed.length,
        }
      : {}),
    tasteQuestions: payload.groups
      .filter((g) => g.bucket === 'taste')
      .map((g) => ({ type: g.types.join(' + '), route: g.fingerprints.map((fp) => (fp ? actionByFingerprint.get(fp)?.route : undefined)).find(Boolean) ?? '', title: g.title })),
  };
}

export interface AgentPage {
  route: string;
  /** Viewport-sized render — the size a vision model can actually read. Null when none was captured. */
  screenshot: string | null;
  /** Whole-document render, present only when the document exceeds the viewport. */
  screenshotFull?: string;
  /** Dark-mode render, present only when the run used `themeSweep`. */
  darkScreenshot?: string;
  /** Numbered set-of-marks render, present only with `captureCrops`. Badge n = control [n]. */
  screenshotMarked?: string;
  /** Per-zoom renders, e.g. `[{ zoom: 1.5, screenshot: 'screenshots/index@150.png' }]`. */
  zoomShots: { zoom: number; screenshot: string }[];
  /** HTTP status of the main document, or null when the navigation never completed. */
  status: number | null;
  /** How many interactive controls were inventoried on this page. */
  controlCount: number;
  /** Controls actually click-probed; absent when the interaction sweep was skipped. */
  probedControls?: number;
  /** Controls left unprobed because the per-page probe cap was hit. */
  skippedControls?: number;
}

export interface AgentPayload {
  runId?: string;
  verdict: 'clean' | 'has_defects' | 'has_taste_questions';
  summary: {
    defects: number;
    taste: number;
    pagesCrawled: number;
    byType: Record<string, number>;
    /** Findings dropped by the per-page cap. Zero means the report is complete. */
    truncated: number;
    /**
     * Detectors that threw and reported nothing. Non-empty means this run's coverage is
     * incomplete, so an empty `defects` count here is NOT evidence the page is clean.
     */
    detectorFailures: DetectorFailure[];
  };
  actions: AgentAction[];
  routes: string[];
  /**
   * Root-cause groups: actions that share a fix site, so an agent fixes the site instead
   * of triaging every symptom. `actions` still carries every finding; `groups` is the
   * work plan. Ordered worst-first, same as `actions`.
   */
  groups: AgentGroup[];
  /**
   * Per-page visual artifacts. A vision-capable agent needs these to look at what the
   * audit looked at — the crawl always captures them, so they are always addressable.
   * Paths are relative to the report directory reported by the run (see `reportPath` in
   * findings.json, or `--out`).
   */
  pages: AgentPage[];
  diff?: DiffResult;
}

export function buildAgentPayload(result: CrawlResult): AgentPayload {
  const sum = summarize(result.findings);
  const verdict = sum.defects > 0 ? 'has_defects' : sum.taste > 0 ? 'has_taste_questions' : 'clean';

  const actions: AgentAction[] = result.findings.map((f) => {
    const act: AgentAction = {
      id: f.id,
      fingerprint: f.fingerprint,
      route: f.route,
      type: f.type,
      bucket: f.bucket,
      severity: f.severity,
      selector: f.evidence.selector,
      title: f.title,
      remediation: f.remediation,
      source: f.source,
      ...(f.tags ? { tags: f.tags } : {}),
      ...(f.helpUrl ? { helpUrl: f.helpUrl } : {}),
      // Absent, not null: "no image was captured" differs from "an empty image".
      ...(f.evidence.snapshotIndex !== undefined ? { snapshotIndex: f.evidence.snapshotIndex } : {}),
      ...(f.evidence.cropBase64 ? { cropBase64: f.evidence.cropBase64 } : {}),
      ...(f.evidence.crop ? { crop: f.evidence.crop } : {}),
    };

    const evidenceSubset: AgentAction['evidence'] = {};
    if (f.evidence.layout && Object.keys(f.evidence.layout).length) evidenceSubset.layout = f.evidence.layout;
    if (f.evidence.typography && Object.keys(f.evidence.typography).length) evidenceSubset.typography = f.evidence.typography;
    if (f.evidence.contrast) evidenceSubset.contrast = f.evidence.contrast;
    if (f.evidence.clipping) evidenceSubset.clipping = f.evidence.clipping;
    if (f.evidence.accessibility) evidenceSubset.accessibility = f.evidence.accessibility;
    if (f.evidence.spacing) evidenceSubset.spacing = f.evidence.spacing;
    if (f.evidence.hitTest) evidenceSubset.hitTest = f.evidence.hitTest;
    if (f.evidence.theme) evidenceSubset.theme = f.evidence.theme;

    if (Object.keys(evidenceSubset).length) {
      act.evidence = evidenceSubset;
    }
    return act;
  });

  const pages: AgentPage[] = result.pages.map((p) => ({
    route: p.route,
    screenshot: p.screenshot ?? null,
    ...(p.screenshotFull ? { screenshotFull: p.screenshotFull } : {}),
    ...(p.darkScreenshot ? { darkScreenshot: p.darkScreenshot } : {}),
    ...(p.screenshotMarked ? { screenshotMarked: p.screenshotMarked } : {}),
    zoomShots: p.zoomShots ?? [],
    status: p.status,
    controlCount: p.controlCount,
    ...(p.probedControls !== undefined ? { probedControls: p.probedControls } : {}),
    ...(p.skippedControls !== undefined ? { skippedControls: p.skippedControls } : {}),
  }));

  const sorted = sortActions(actions);

  return {
    runId: result.runId,
    verdict,
    summary: {
      defects: sum.defects,
      taste: sum.taste,
      pagesCrawled: result.pages.length,
      byType: sum.byType,
      truncated: result.truncated ?? 0,
      detectorFailures: result.detectorFailures ?? [],
    },
    actions: sorted,
    groups: buildGroups(sorted),
    routes: result.pages.map((p) => p.route),
    pages,
    diff: result.diff,
  };
}

export function buildFindingsJson(result: CrawlResult): string {
  const sum = summarize(result.findings);
  sum.truncated = result.truncated ?? 0;
  return JSON.stringify(
    {
      runId: result.runId,
      baseUrl: result.baseUrl,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      // Base directory for every relative `screenshot` path in this report.
      reportPath: result.reportPath,
      summary: sum,
      diff: result.diff,
      guidance: result.guidance,
      apiIndex: result.apiIndex,
      findings: result.findings,
      pages: result.pages,
    },
    null,
    2,
  );
}
