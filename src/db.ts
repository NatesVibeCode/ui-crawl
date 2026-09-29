import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = require('node:sqlite');
import type { CrawlResult, Finding, DiffResult, Severity, Bucket, FindingType, PageReport, DetectorFailure } from './types.js';

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

/**
 * Stable identity for a finding, so a diff can tell "fixed" from "moved".
 *
 * Selectors like `button:nth(3) "Save"` are POSITIONAL — an index into whatever the page
 * happened to contain, from one of three pools the detectors do not agree on. Insert one
 * button above a control and every finding below it renumbers: the old fingerprint scheme
 * hashed the position, so a single insertion read as mass "fixed" plus mass "regressions".
 * That lied to the closed loop about what a repair accomplished.
 *
 * The rule is grammar-driven, not a per-kind list that can drift: a selector containing
 * the `:nth(n)` position form fingerprints on CONTENT instead — the accessible name, the
 * destination URL, the ARIA attribute and target — falling back to the selector only when
 * the finding names nothing at all (an unnamed image, say). Two identical twins
 * ("Buy now" twice) share one fingerprint; that is correct, because they share one root
 * cause, and grouping surfaces the multiplicity.
 *
 * One consequence is a single re-baseline: fingerprints minted before this scheme do not
 * match the new ones, so the first diff after upgrading reports churn once, then settles.
 */
const POSITIONAL_SELECTOR = /:nth\(\d+\)/;

/**
 * Loopback origins get an ephemeral port per run (the static server binds `:0`), so an
 * absolute URL is never a stable identity there. Drop the port on loopback; everywhere
 * else the URL is kept exact, because two different real hosts with the same path are
 * genuinely different destinations.
 */
function identityUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const loopback =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\./.test(host);
    if (loopback) return `${u.protocol}//${host}${u.pathname}${u.search}`;
    return raw;
  } catch {
    return raw;
  }
}

export function computeFingerprint(f: {
  route: string;
  type: string;
  selector?: string;
  evidence?: {
    accessibleName?: string;
    url?: string;
    layout?: { otherSelector?: string };
    accessibility?: { attribute?: string; target?: string };
  };
}): string {
  const selector = f.selector ?? '';
  if (POSITIONAL_SELECTOR.test(selector)) {
    const name = (f.evidence?.accessibleName ?? '').trim();
    const url = f.evidence?.url ? identityUrl(f.evidence.url) : '';
    const attribute = f.evidence?.accessibility?.attribute ?? '';
    const target = f.evidence?.accessibility?.target ?? '';
    const identity = [name, url, attribute, target].filter(Boolean).join('|');
    if (identity) return [f.route, f.type, identity].join('::');
  }
  const parts = [f.route, f.type, selector];
  if (f.evidence?.layout?.otherSelector) {
    parts.push(f.evidence.layout.otherSelector);
  }
  return parts.join('::');
}

export function openDatabase(dbPath = '.ui-crawl.db'): DatabaseSync {
  const db = new DatabaseSyncClass(dbPath) as DatabaseSync;
  db.exec('PRAGMA foreign_keys = ON;');
  // Two CLI runs against one database file serialize here instead of one of them
  // failing with SQLITE_BUSY and silently losing its history.
  db.exec('PRAGMA busy_timeout = 5000;');
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

  // Migrations for databases created by an older version. `CREATE TABLE IF NOT EXISTS`
  // will not add a column to a table that already exists, so a stored database from
  // before a column existed needs an explicit ALTER. The table is named explicitly per
  // entry — inferring it from the column name is exactly the kind of cleverness that
  // silently checks the wrong table and then throws "duplicate column".
  const MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
    { table: 'runs', column: 'pages_json', ddl: 'ALTER TABLE runs ADD COLUMN pages_json TEXT' },
    { table: 'runs', column: 'out_dir', ddl: 'ALTER TABLE runs ADD COLUMN out_dir TEXT' },
    { table: 'findings', column: 'help_url', ddl: 'ALTER TABLE findings ADD COLUMN help_url TEXT' },
    { table: 'findings', column: 'tags_json', ddl: 'ALTER TABLE findings ADD COLUMN tags_json TEXT' },
  ];
  for (const { table, column, ddl } of MIGRATIONS) {
    const present = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((r) => r.name === column);
    if (present) continue;
    // Belt and braces: if another process migrated between the check and here, the
    // duplicate-column error is the correct outcome to swallow, not a crash.
    try {
      db.exec(ddl);
    } catch (err) {
      if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  return db;
}

/**
 * Persist a run. `outDir` is stored because every artifact path in a finding is
 * relative to it, and a later reader (the fix plan) has to resolve them without
 * re-crawling — the report path is only known after the sink writes, so it is passed in
 * rather than read off the result.
 */
export function saveRun(
  db: DatabaseSync,
  result: CrawlResult,
  customRunId?: string,
  outDir?: string,
): string {
  const runId = customRunId ?? `run_${Date.now()}_${randomUUID().slice(0, 6)}`;
  result.runId = runId;

  const defects = result.findings.filter((f) => f.bucket === 'defect').length;
  const taste = result.findings.filter((f) => f.bucket === 'taste').length;
  const verdict = defects > 0 ? 'has_defects' : taste > 0 ? 'has_taste_questions' : 'clean';

  const insertRun = db.prepare(`
    INSERT INTO runs (
      id, started_at, finished_at, base_url, routes_json, verdict,
      defects_count, taste_count, pages_count, summary_json, pages_json, out_dir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    JSON.stringify({
      defects,
      taste,
      pages: result.pages.length,
      truncated: result.truncated ?? 0,
      detectorFailures: result.detectorFailures ?? [],
    }),
    // Only the artifact references a plan needs, not the whole page report.
    JSON.stringify(
      result.pages.map((p) => ({
        route: p.route,
        screenshot: p.screenshot ?? null,
        ...(p.screenshotMarked ? { screenshotMarked: p.screenshotMarked } : {}),
        ...(p.screenshotFull ? { screenshotFull: p.screenshotFull } : {}),
        ...(p.darkScreenshot ? { darkScreenshot: p.darkScreenshot } : {}),
      })),
    ),
    outDir ?? result.reportPath ?? null,
  );

  const insertFinding = db.prepare(`
    INSERT INTO findings (
      id, run_id, route, type, bucket, severity, selector,
      title, remediation, fingerprint, source_file, source_line,
      source_component, evidence_json, help_url, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      f.helpUrl ?? null,
      JSON.stringify(f.tags ?? []),
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
  help_url: string | null;
  tags_json: string | null;
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

  // Columns added after the fact (see the migration in openDatabase). An older database
  // has no such column, which the row simply will not carry.
  if (row.help_url) finding.helpUrl = row.help_url;
  if (row.tags_json) {
    try {
      const tags = JSON.parse(row.tags_json) as string[];
      if (Array.isArray(tags) && tags.length) finding.tags = tags;
    } catch {
      /* ignore malformed tags */
    }
  }

  return finding;
}

/**
 * Whether a run id names a real run. A typo'd `--diff` id used to diff against the void:
 * every subquery came back empty and the caller read "everything fixed, nothing persists".
 */
export function hasRun(db: DatabaseSync, runId: string): boolean {
  return !!(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId) as { '1': number } | undefined);
}

export function getDiff(db: DatabaseSync, currentRunId: string, baselineRunId?: string): DiffResult | null {
  if (!hasRun(db, currentRunId)) return null;

  let prevId = baselineRunId;
  if (!prevId) {
    const prevStmt = db.prepare('SELECT id FROM runs WHERE id != ? ORDER BY started_at DESC LIMIT 1');
    const prevRow = prevStmt.get(currentRunId) as { id: string } | undefined;
    if (!prevRow) return null;
    prevId = prevRow.id;
  } else if (!hasRun(db, prevId)) {
    return null;
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

/**
 * Distinct routes that carried at least one defect in a run — the re-audit set for
 * `--rerun-defects`. Lives here rather than in the CLI so the SQL stays in one layer.
 */
export function getDefectRoutes(db: DatabaseSync, runId: string): string[] {
  const stmt = db.prepare("SELECT DISTINCT route FROM findings WHERE run_id = ? AND bucket = 'defect'");
  const rows = stmt.all(runId) as unknown as Array<{ route: string }>;
  return rows.map((r) => r.route);
}

/**
 * Rehydrate a stored run: its findings, plus the page artifact references a plan needs.
 *
 * This is what lets a follow-up read a plan, diff, or verdict WITHOUT re-crawling —
 * the expensive part (a browser, a page per route) is already paid for and stored. Only
 * the artifact paths and the evidence are needed afterwards.
 */
export function getRunResult(
  db: DatabaseSync,
  runId: string,
): { findings: Finding[]; pages: PageReport[]; verdict: string; baseUrl: string; outDir: string; detectorFailures?: DetectorFailure[] } | null {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
    | { base_url: string; verdict: string; routes_json: string; pages_json: string | null; out_dir: string | null; summary_json?: string }
    | undefined;
  if (!run) return null;

  const findingRows = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId) as unknown as RawDbFinding[];
  const routes = (JSON.parse(run.routes_json || '[]') as string[]) ?? [];

  let detectorFailures: DetectorFailure[] = [];
  if (run.summary_json) {
    try {
      const summary = JSON.parse(run.summary_json) as { detectorFailures?: DetectorFailure[] };
      if (Array.isArray(summary.detectorFailures)) {
        detectorFailures = summary.detectorFailures;
      }
    } catch {
      detectorFailures = [];
    }
  }

  let pages: PageReport[] = [];
  if (run.pages_json) {
    try {
      const parsed = JSON.parse(run.pages_json) as Array<Record<string, string | null>>;
      pages = parsed.map((p) => ({
        route: p.route as string,
        template: p.route as string,
        status: null,
        screenshot: (p.screenshot as string) ?? undefined,
        ...(p.screenshotMarked ? { screenshotMarked: p.screenshotMarked as string } : {}),
        ...(p.screenshotFull ? { screenshotFull: p.screenshotFull as string } : {}),
        ...(p.darkScreenshot ? { darkScreenshot: p.darkScreenshot as string } : {}),
        consoleErrors: [],
        failedRequests: [],
        controlCount: 0,
      }));
    } catch {
      pages = [];
    }
  }
  if (!pages.length) {
    // A run stored before artifact persistence still has its routes; keep the shape honest.
    pages = routes.map((route) => ({
      route,
      template: route,
      status: null,
      consoleErrors: [],
      failedRequests: [],
      controlCount: 0,
    }));
  }

  return {
    findings: findingRows.map(mapRowToFinding),
    pages,
    verdict: run.verdict,
    baseUrl: run.base_url,
    outDir: run.out_dir ?? './ui-crawl-out',
    detectorFailures,
  };
}

export function getFindingById(db: DatabaseSync, findingId: string): Finding | null {
  const stmt = db.prepare('SELECT * FROM findings WHERE id = ?');
  const row = stmt.get(findingId) as unknown as RawDbFinding | undefined;
  return row ? mapRowToFinding(row) : null;
}
