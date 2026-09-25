import type { CrawlResult, Finding, FindingType, Severity, Bucket, SourceLocation, DiffResult } from './types.js';

export interface Summary {
  defects: number;
  taste: number;
  byType: Record<string, number>;
}

export function summarize(findings: Finding[]): Summary {
  const s: Summary = { defects: 0, taste: 0, byType: {} };
  for (const f of findings) {
    if (f.bucket === 'defect') s.defects++;
    else s.taste++;
    s.byType[f.type] = (s.byType[f.type] ?? 0) + 1;
  }
  return s;
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
  cropBase64?: string;
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

export interface AgentPayload {
  runId?: string;
  verdict: 'clean' | 'has_defects' | 'has_taste_questions';
  summary: {
    defects: number;
    taste: number;
    pagesCrawled: number;
    byType: Record<string, number>;
  };
  actions: AgentAction[];
  routes: string[];
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
      cropBase64: f.evidence.cropBase64,
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

  return {
    runId: result.runId,
    verdict,
    summary: {
      defects: sum.defects,
      taste: sum.taste,
      pagesCrawled: result.pages.length,
      byType: sum.byType,
    },
    actions,
    routes: result.pages.map((p) => p.route),
    diff: result.diff,
  };
}

export function buildFindingsJson(result: CrawlResult): string {
  return JSON.stringify(
    {
      runId: result.runId,
      baseUrl: result.baseUrl,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      summary: summarize(result.findings),
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
