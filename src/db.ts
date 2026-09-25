import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = require('node:sqlite');
import type { CrawlResult, Finding, DiffResult, Severity, Bucket, FindingType } from './types.js';

export interface RunRecord {
  id: string;
  started_at: string;
  finished_at: string;
  base_url: string;
  routes: string[];
  verdict: string;
  defects_count: number;
  taste_count: number;
  pages_count: number;
  summary: Record<string, unknown>;
}

export function computeFingerprint(f: {
  route: string;
  type: string;
  selector?: string;
  evidence?: { layout?: { otherSelector?: string } };
}): string {
  const parts = [f.route, f.type, f.selector ?? ''];
  if (f.evidence?.layout?.otherSelector) {
    parts.push(f.evidence.layout.otherSelector);
  }
  return parts.join('::');
}

export function openDatabase(dbPath = '.ui-crawl.db'): DatabaseSync {
  const db = new DatabaseSyncClass(dbPath) as DatabaseSync;
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      base_url TEXT NOT NULL,
      routes_json TEXT NOT NULL,
      verdict TEXT NOT NULL,
      defects_count INTEGER NOT NULL,
      taste_count INTEGER NOT NULL,
      pages_count INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      route TEXT NOT NULL,
      type TEXT NOT NULL,
      bucket TEXT NOT NULL,
      severity TEXT NOT NULL,
      selector TEXT,
      title TEXT NOT NULL,
      remediation TEXT,
      fingerprint TEXT NOT NULL,
      source_file TEXT,
      source_line INTEGER,
      source_component TEXT,
      evidence_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings(run_id);
    CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(fingerprint);
  `);
  return db;
}

export function saveRun(db: DatabaseSync, result: CrawlResult, customRunId?: string): string {
  const runId = customRunId ?? `run_${Date.now()}_${randomUUID().slice(0, 6)}`;
  result.runId = runId;

  const defects = result.findings.filter((f) => f.bucket === 'defect').length;
  const taste = result.findings.filter((f) => f.bucket === 'taste').length;
  const verdict = defects > 0 ? 'has_defects' : taste > 0 ? 'has_taste_questions' : 'clean';

  const insertRun = db.prepare(`
    INSERT INTO runs (
      id, started_at, finished_at, base_url, routes_json, verdict,
      defects_count, taste_count, pages_count, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRun.run(
    runId,
    result.startedAt,
    result.finishedAt,
    result.baseUrl,
    JSON.stringify(result.pages.map((p) => p.route)),
    verdict,
    defects,
    taste,
    result.pages.length,
    JSON.stringify({ defects, taste, pages: result.pages.length }),
  );

  const insertFinding = db.prepare(`
    INSERT INTO findings (
      id, run_id, route, type, bucket, severity, selector,
      title, remediation, fingerprint, source_file, source_line,
      source_component, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const f of result.findings) {
    const findingId = f.id ?? `find_${randomUUID().slice(0, 8)}`;
    f.id = findingId;
    const fingerprint = f.fingerprint ?? computeFingerprint({
      route: f.route,
      type: f.type,
      selector: f.evidence.selector,
      evidence: f.evidence,
    });
    f.fingerprint = fingerprint;

    insertFinding.run(
      findingId,
      runId,
      f.route,
      f.type,
      f.bucket,
      f.severity,
      f.evidence.selector ?? null,
      f.title,
      f.remediation ?? null,
      fingerprint,
      f.source?.file ?? null,
      f.source?.line ?? null,
      f.source?.component ?? null,
      JSON.stringify(f.evidence),
    );
  }

  return runId;
}

interface RawDbFinding {
  id: string;
  run_id: string;
  route: string;
  type: string;
  bucket: string;
  severity: string;
  selector: string | null;
  title: string;
  remediation: string | null;
  fingerprint: string;
  source_file: string | null;
  source_line: number | null;
  source_component: string | null;
  evidence_json: string;
}

function mapRowToFinding(row: RawDbFinding): Finding {
  let evidence = {};
  try {
    evidence = JSON.parse(row.evidence_json);
  } catch {
    /* fallback empty */
  }

  const finding: Finding = {
    id: row.id,
    fingerprint: row.fingerprint,
    route: row.route,
    type: row.type as FindingType,
    bucket: row.bucket as Bucket,
    severity: row.severity as Severity,
    title: row.title,
    evidence,
    remediation: row.remediation ?? undefined,
  };

  if (row.source_file || row.source_component) {
    finding.source = {
      file: row.source_file ?? undefined,
      line: row.source_line ?? undefined,
      component: row.source_component ?? undefined,
    };
  }

  return finding;
}

export function getDiff(db: DatabaseSync, currentRunId: string, baselineRunId?: string): DiffResult | null {
  let prevId = baselineRunId;
  if (!prevId) {
    const prevStmt = db.prepare('SELECT id FROM runs WHERE id != ? ORDER BY started_at DESC LIMIT 1');
    const prevRow = prevStmt.get(currentRunId) as { id: string } | undefined;
    if (!prevRow) return null;
    prevId = prevRow.id;
  }

  // Fixed findings: in baseline, not in current
  const fixedStmt = db.prepare(`
    SELECT * FROM findings
    WHERE run_id = ?
      AND fingerprint NOT IN (SELECT fingerprint FROM findings WHERE run_id = ?)
  `);
  const fixedRows = fixedStmt.all(prevId, currentRunId) as unknown as RawDbFinding[];
  const fixed = fixedRows.map(mapRowToFinding);

  // Regressions (new findings): in current, not in baseline
  const regStmt = db.prepare(`
    SELECT * FROM findings
    WHERE run_id = ?
      AND fingerprint NOT IN (SELECT fingerprint FROM findings WHERE run_id = ?)
  `);
  const regRows = regStmt.all(currentRunId, prevId) as unknown as RawDbFinding[];
  const regressions = regRows.map(mapRowToFinding);

  // Persistent findings: in current and in baseline
  const perStmt = db.prepare(`
    SELECT * FROM findings
    WHERE run_id = ?
      AND fingerprint IN (SELECT fingerprint FROM findings WHERE run_id = ?)
  `);
  const perRows = perStmt.all(currentRunId, prevId) as unknown as RawDbFinding[];
  const persistent = perRows.map(mapRowToFinding);

  return {
    runA: prevId,
    runB: currentRunId,
    fixed,
    regressions,
    persistent,
  };
}

export function getRunHistory(db: DatabaseSync, limit = 10): RunRecord[] {
  const stmt = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?');
  const rows = stmt.all(limit) as unknown as Array<{
    id: string;
    started_at: string;
    finished_at: string;
    base_url: string;
    routes_json: string;
    verdict: string;
    defects_count: number;
    taste_count: number;
    pages_count: number;
    summary_json: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    started_at: r.started_at,
    finished_at: r.finished_at,
    base_url: r.base_url,
    routes: JSON.parse(r.routes_json || '[]'),
    verdict: r.verdict,
    defects_count: r.defects_count,
    taste_count: r.taste_count,
    pages_count: r.pages_count,
    summary: JSON.parse(r.summary_json || '{}'),
  }));
}

export function getFindingById(db: DatabaseSync, findingId: string): Finding | null {
  const stmt = db.prepare('SELECT * FROM findings WHERE id = ?');
  const row = stmt.get(findingId) as unknown as RawDbFinding | undefined;
  return row ? mapRowToFinding(row) : null;
}
