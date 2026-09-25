/**
 * Pure bot-challenge / edge-interstitial detection (Cloudflare "Just a moment…",
 * similar WAF holds). A challenge means the crawl never reached the app — that is
 * not an application defect and not a silent pass either.
 */

export interface ChallengeInput {
  status: number | null;
  url?: string;
  title?: string;
  /** First ~2k of body text (whitespace-normalized is fine). */
  bodyTextSample?: string;
  /** Lowercased response headers of the main document, if available. */
  headers?: Record<string, string>;
}

const TITLE_BODY_RE =
  /just a moment|checking (?:your )?browser|attention required|enable javascript and cookies|verify you are human|performing security verification|ddos protection/i;

const CF_MARKERS_RE = /cloudflare|cf-browser-verification|cf_chl_|__cf_chl|cdn-cgi\/challenge/i;

/**
 * True when the loaded document looks like an edge bot-challenge rather than the app.
 * Requires a strong body/title signal, or a challenge status + Cloudflare-ish markers.
 */
export function isChallengePage(input: ChallengeInput): boolean {
  const title = (input.title ?? '').trim();
  const body = (input.bodyTextSample ?? '').trim();
  const hay = `${title}\n${body}`.slice(0, 4000);

  // Strong copy alone is enough (Cloudflare interstitial title/body).
  if (TITLE_BODY_RE.test(hay)) return true;

  const status = input.status;
  const challengeStatus = status === 403 || status === 429 || status === 503;
  const headers = input.headers ?? {};
  const cfMitigated = (headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge';
  const server = (headers['server'] ?? '').toLowerCase();
  const hasCfHeader = cfMitigated || server.includes('cloudflare');
  const hasCfBody = CF_MARKERS_RE.test(hay);

  if (cfMitigated) return true;
  if (challengeStatus && (hasCfHeader || hasCfBody)) return true;
  if (hasCfHeader && hasCfBody && body.length < 2000) return true;
  return false;
}

/** Suggested finding severity from HTTP status when a challenge is confirmed. */
export function challengeSeverity(status: number | null): 'high' | 'medium' {
  if (status === 403 || status === 503) return 'high';
  return 'medium';
}
