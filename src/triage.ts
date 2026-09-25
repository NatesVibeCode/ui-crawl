import type { RawFinding, Finding, Bucket, Severity, FindingType } from './types.js';
import type { VisionPort, TextTriagePort } from './ports.js';

/**
 * Pure-by-default bucketing. The defect/taste boundary is deterministic; injected models
 * only REFINE within a finding and never silently invent a defect. With Noop ports the
 * output is identical to having no models at all (the v1 value floor).
 */

interface BaseRule {
  bucket: Bucket;
  severity: Severity;
  title: (r: RawFinding) => string;
}

const name = (r: RawFinding): string => r.control?.accessibleName?.trim() || r.evidence.accessibleName?.trim() || '(unnamed)';

const RULES: Record<FindingType, BaseRule> = {
  'page-load-error': { bucket: 'defect', severity: 'high', title: (r) => `Page failed to load${r.evidence.url ? ` (${r.evidence.url})` : ''}` },
  'console-error': { bucket: 'defect', severity: 'medium', title: () => 'Console error on page load' },
  'broken-asset': { bucket: 'defect', severity: 'high', title: (r) => `Failed to load asset${r.evidence.url ? ` (${r.evidence.url})` : ''}` },
  'button-threw': { bucket: 'defect', severity: 'high', title: (r) => `Control threw on click: "${name(r)}"` },
  'dead-button': { bucket: 'defect', severity: 'high', title: (r) => `Control has a target but did nothing: "${name(r)}"` },
  'broken-link': { bucket: 'defect', severity: 'high', title: (r) => `Link resolved but produced no effect: "${name(r)}"` },
  'maybe-contextual-button': { bucket: 'taste', severity: 'medium', title: (r) => `Button did nothing — dead, or needs prior input? "${name(r)}"` },
  'redundant-control': { bucket: 'taste', severity: 'low', title: (r) => `Two controls go to the same place: "${name(r)}"` },
  'low-contrast': {
    bucket: 'taste',
    severity: 'medium',
    title: (r) => {
      const c = r.evidence.contrast;
      return c
        ? `Low text contrast ${c.ratio}:1 (expected >= 4.5:1) for "${c.textSample || r.evidence.selector || 'text'}"`
        : `Low text contrast on element`;
    },
  },
  'missing-affordance': { bucket: 'taste', severity: 'medium', title: (r) => `Interactive control lacks hover/focus affordance and pointer cursor: "${name(r)}"` },
  'tight-target': {
    bucket: 'taste',
    severity: 'low',
    title: (r) => {
      const sp = r.evidence.spacing;
      if (sp?.otherSelector) {
        return `Adjacent interactive controls are crowded (${sp.distancePx}px gap): "${r.evidence.selector}" and "${sp.otherSelector}"`;
      }
      return `Touch target may be too small (${sp?.distancePx ?? 0}px): "${r.evidence.selector}"`;
    },
  },
  'zoom-clip': { bucket: 'taste', severity: 'medium', title: (r) => `Content overflows the viewport at ${pct(r.evidence.zoom)} — acceptable, or broken?` },
  'zoom-overlap': { bucket: 'taste', severity: 'medium', title: (r) => `Elements collide at ${pct(r.evidence.zoom)}` },
  'stale-selector': { bucket: 'taste', severity: 'low', title: (r) => `Control could not be re-located: "${name(r)}"` },
  'missing-accessible-name': { bucket: 'defect', severity: 'high', title: (r) => `Interactive control has no accessible name: "${r.evidence.selector ?? '(unnamed)'}"` },
  'keyboard-inaccessible': { bucket: 'defect', severity: 'high', title: (r) => `Interactive control cannot receive keyboard focus: "${r.evidence.selector ?? '(unknown)'}"` },
  'missing-image-alt': { bucket: 'defect', severity: 'medium', title: (r) => `Informative image has no alt text: "${r.evidence.selector ?? 'image'}"` },
  'invalid-aria-reference': { bucket: 'defect', severity: 'high', title: (r) => `ARIA relationship points to a missing element: "${r.evidence.selector ?? '(unknown)'}"` },
  'invalid-aria-state': { bucket: 'defect', severity: 'high', title: (r) => `Invalid ${r.evidence.accessibility?.attribute ?? 'ARIA'} value on "${r.evidence.selector ?? '(unknown)'}"` },
  'dialog-missing-label': { bucket: 'defect', severity: 'high', title: (r) => `Visible dialog has no accessible name: "${r.evidence.selector ?? '(dialog)'}"` },
  // Not a defect: the site asked us not to look, and we complied.
  'robots-blocked': { bucket: 'taste', severity: 'low', title: (r) => `Not crawled — robots.txt disallows ${r.evidence.url ?? 'this route'}` },
  // Edge/WAF hold: the app never rendered. Not our bug and not a silent pass.
  'bot-challenge': { bucket: 'taste', severity: 'medium', title: (r) => `Bot challenge interstitial${r.evidence.url ? ` (${r.evidence.url})` : ''} — crawl did not reach the app` },
  'layout-overlap': {
    bucket: 'defect',
    severity: 'high',
    title: (r) => `In-flow elements collide: "${r.evidence.selector ?? ''}" and "${r.evidence.layout?.otherSelector ?? ''}"`,
  },
  'text-overlap': {
    bucket: 'defect',
    severity: 'high',
    title: (r) => `Text elements collide: "${r.evidence.selector ?? ''}" and "${r.evidence.layout?.otherSelector ?? ''}"`,
  },
  'text-line-collision': {
    bucket: 'defect',
    severity: 'high',
    title: (r) => {
      const t = r.evidence.typography;
      return t?.directOverlap
        ? `Line boxes overlap on multiline text: "${r.evidence.selector ?? ''}"`
        : `Tight line-height (${t?.ratio ?? 'low'}) causes descender clash on "${r.evidence.selector ?? ''}"`;
    },
  },
  'clipped-text': {
    bucket: 'taste',
    severity: 'medium',
    title: (r) => `Text clipped by overflow:hidden without ellipsis: "${r.evidence.clipping?.textSample || r.evidence.selector || 'text'}"`,
  },
  'viewport-overflow': {
    bucket: 'defect',
    severity: 'high',
    title: (r) => `Content horizontally overflows viewport at "${r.evidence.selector ?? 'page'}"`,
  },
  'pointer-intercepted': {
    bucket: 'defect',
    severity: 'high',
    title: (r) =>
      `Control click intercepted by overlay element "${r.evidence.hitTest?.interceptedBy ?? 'unknown'}": "${name(r)}"`,
  },
  'small-touch-target': {
    bucket: 'taste',
    severity: 'medium',
    title: (r) => {
      const sz = r.evidence.hitTest?.targetSize;
      return `Clickable element is smaller than WCAG 24x24px touch target (${sz ? `${sz.width}x${sz.height}px` : 'small'}): "${name(r)}"`;
    },
  },
  'dark-mode-contrast': {
    bucket: 'defect',
    severity: 'high',
    title: (r) => {
      const c = r.evidence.contrast;
      return c
        ? `Dark mode text contrast failure ${c.ratio}:1 (expected >= 4.5:1) for "${c.textSample || r.evidence.selector || 'text'}"`
        : `Dark mode text contrast failure on element`;
    },
  },
  'container-overflow': {
    bucket: 'defect',
    severity: 'high',
    title: (r) =>
      `Child element "${r.evidence.selector ?? 'element'}" overflows container "${r.evidence.layout?.otherSelector ?? 'parent'}"`,
  },
  'sibling-overlap': {
    bucket: 'defect',
    severity: 'high',
    title: (r) =>
      `Vertical sibling blocks overlap: "${r.evidence.selector ?? 'element'}" into "${r.evidence.layout?.otherSelector ?? 'sibling'}"`,
  },
};

function pct(z?: number): string {
  return z ? `${Math.round(z * 100)}% zoom` : 'zoom';
}

const CONTEXTUAL_SYSTEM =
  'You triage a button that did nothing when clicked in an automated crawl. Decide if it is plausibly ' +
  'disabled-pending-input (needs a selection/field first) or genuinely dead. Answer one word: CONTEXTUAL or DEAD.';

const ZOOM_SYSTEM =
  'You audit a screenshot for layout breakage at high browser zoom. Answer one word: BROKEN if elements ' +
  'overlap/clip/are unusable, or OK if the layout merely reflows acceptably.';

function contextualVerdict(reply: string): 'likely-dead' | 'likely-contextual' {
  const normalized = reply.trim().toLowerCase();
  if (
    /\bcontextual\b/.test(normalized) ||
    /\bnot dead\b/.test(normalized) ||
    /\bneeds?\b.*\b(input|selection|state)\b/.test(normalized)
  ) {
    return 'likely-contextual';
  }
  return /\bdead\b/.test(normalized) ? 'likely-dead' : 'likely-contextual';
}

function zoomVerdict(reply: string): 'broken' | 'ok' {
  const normalized = reply.trim().toLowerCase();
  if (/\bnot broken\b/.test(normalized) || /\bok\b/.test(normalized)) return 'ok';
  return /\bbroken\b/.test(normalized) ? 'broken' : 'ok';
}

export async function triageRaw(
  raw: RawFinding,
  ctx: { vision: VisionPort; text: TextTriagePort },
): Promise<Finding> {
  const rule = RULES[raw.kind];
  let bucket = rule.bucket;
  let severity = rule.severity;
  let triage: Finding['triage'];

  // A bare no-op button: optionally ask the text model whether it's contextual. Stays TASTE either way.
  if (raw.kind === 'maybe-contextual-button') {
    const reply = (
      await Promise.resolve(ctx.text.complete({ system: CONTEXTUAL_SYSTEM, prompt: contextualPrompt(raw) }))
    ).trim();
    if (reply) {
      const verdict = contextualVerdict(reply);
      triage = { by: 'text', verdict, mode: 'model' };
      severity = verdict === 'likely-dead' ? 'high' : 'low';
    } else {
      triage = { by: 'text', verdict: 'no-model', mode: 'skipped' };
    }
  }

  // Zoom reflow: whether overflow/overlap is "broken" vs "acceptable scroll" is a judgement.
  // Default to TASTE; an injected vision model may promote clear breakage to a DEFECT.
  // Empty reply (Noop) => stays TASTE — a model never silently invents a defect.
  if (raw.kind === 'zoom-overlap' || raw.kind === 'zoom-clip') {
    bucket = 'taste';
    if (raw.evidence.screenshot) {
      const reply = (
        await Promise.resolve(
          ctx.vision.judge({
            imageRef: raw.evidence.screenshot,
            system: ZOOM_SYSTEM,
            prompt: 'Is the layout broken at this zoom?',
          }),
        )
      ).trim();
      if (reply) {
        const broken = zoomVerdict(reply) === 'broken';
        triage = { by: 'vision', verdict: broken ? 'broken' : 'ok', mode: 'model' };
        if (broken) {
          bucket = 'defect';
          severity = 'high';
        } else {
          severity = 'low';
        }
      } else {
        triage = { by: 'vision', verdict: 'no-model', mode: 'skipped' };
      }
    }
  }

  // Low contrast: severe failures (< 3.0:1) are elevated to DEFECT; moderate (< 4.5:1) remain TASTE.
  if (raw.kind === 'low-contrast') {
    const ratio = raw.evidence.contrast?.ratio ?? 4.0;
    if (ratio < 3.0) {
      bucket = 'defect';
      severity = 'high';
    } else {
      bucket = 'taste';
      severity = 'medium';
    }
  }

  return {
    route: raw.route,
    type: raw.kind,
    bucket,
    severity,
    title: rule.title(raw),
    evidence: raw.evidence,
    source: raw.evidence.source,
    remediation: raw.evidence.remediation,
    triage,
  };
}

function contextualPrompt(raw: RawFinding): string {
  const lines = [
    `Route: ${raw.route}`,
    `Button text: ${raw.control?.accessibleName ?? '(none)'}`,
    `Tag: ${raw.control?.tag ?? '(unknown)'}`,
    'It produced no navigation, DOM change, network request, or error when clicked.',
  ];
  return lines.join('\n');
}
