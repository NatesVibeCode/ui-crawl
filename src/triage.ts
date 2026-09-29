import type { RawFinding, Finding, Bucket, Severity, FindingType } from './types.js';

/**
 * Pure, deterministic bucketing — the whole contract of this module.
 *
 * The defect/taste boundary is decided here and nowhere else, and it is decided the same
 * way on every run. There is deliberately no model in this path: this tool is called BY a
 * model, so a nested one would spend the caller's budget without their choosing and make
 * the output non-reproducible for no gain. A caller that wants to reason about a `taste`
 * finding has the evidence to do it — that is what the bucket is for.
 *
 * The rule that matters: silence is ALWAYS taste, never a defect. `low-contrast` is the one
 * place a threshold inside the finding decides, because a sub-3:1 ratio is legible text
 * failing a published WCAG floor, while 3–4.5:1 is a judgement call.
 */

interface BaseRule {
  bucket: Bucket;
  severity: Severity;
  title: (r: RawFinding) => string;
  /**
   * Stable reference grounding the rule: a WCAG Understanding URL where one exists, so a
   * caller can check the remediation against ground truth instead of taking it on trust.
   * Absent for mechanical findings (navigation, exceptions, assets) and for taste notes
   * with no published criterion — a wrong-ish link is worse than none.
   */
  helpUrl?: string;
  /**
   * Filtering vocabulary: `wcag2aa` / `wcag22aa` (published criteria), `usability`
   * (mechanical but uncited), `best-practice` (taste/esthetic), `reliability`
   * (the tool's own load/network observations), `internal` (not about the page at all:
   * robots, challenges, stale references).
   */
  tags: string[];
}

const name = (r: RawFinding): string => r.control?.accessibleName?.trim() || r.evidence.accessibleName?.trim() || '(unnamed)';

const RULES: Record<FindingType, BaseRule> = {
  'page-load-error': { bucket: 'defect', severity: 'high', tags: ['reliability'], title: (r) => `Page failed to load${r.evidence.url ? ` (${r.evidence.url})` : ''}` },
  'console-error': { bucket: 'defect', severity: 'medium', tags: ['reliability'], title: () => 'Console error on page load' },
  'broken-asset': { bucket: 'defect', severity: 'high', tags: ['reliability'], title: (r) => `Failed to load asset${r.evidence.url ? ` (${r.evidence.url})` : ''}` },
  'button-threw': { bucket: 'defect', severity: 'high', tags: ['reliability'], title: (r) => `Control threw on click: "${name(r)}"` },
  'dead-button': { bucket: 'defect', severity: 'high', tags: ['usability'], title: (r) => `Control has a target but did nothing: "${name(r)}"` },
  'broken-link': { bucket: 'defect', severity: 'high', tags: ['usability'], title: (r) => `Link resolved but produced no effect: "${name(r)}"` },
  'maybe-contextual-button': { bucket: 'taste', severity: 'medium', tags: ['usability'], title: (r) => `Button did nothing — dead, or needs prior input? "${name(r)}"` },
  'redundant-control': { bucket: 'taste', severity: 'low', tags: ['usability', 'best-practice'], title: (r) => `Two controls go to the same place: "${name(r)}"` },
  'low-contrast': {
    bucket: 'taste',
    severity: 'medium',
    tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html',
    title: (r) => {
      const c = r.evidence.contrast;
      return c
        ? `Low text contrast ${c.ratio}:1 (expected >= 4.5:1) for "${c.textSample || r.evidence.selector || 'text'}"`
        : `Low text contrast on element`;
    },
  },
  'missing-affordance': { bucket: 'taste', severity: 'medium', tags: ['usability'], title: (r) => `Interactive control lacks hover/focus affordance and pointer cursor: "${name(r)}"` },
  'tight-target': {
    bucket: 'taste',
    severity: 'low',
    tags: ['wcag22aa'], helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html',
    title: (r) => {
      const sp = r.evidence.spacing;
      if (sp?.otherSelector) {
        return `Adjacent interactive controls are crowded (${sp.distancePx}px gap): "${r.evidence.selector}" and "${sp.otherSelector}"`;
      }
      return `Touch target may be too small (${sp?.distancePx ?? 0}px): "${r.evidence.selector}"`;
    },
  },
  'zoom-clip': { bucket: 'taste', severity: 'medium', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html', title: (r) => `Content overflows the viewport at ${pct(r.evidence.zoom)} — acceptable, or broken?` },
  'zoom-overlap': { bucket: 'taste', severity: 'medium', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html', title: (r) => `Elements collide at ${pct(r.evidence.zoom)}` },
  'stale-selector': { bucket: 'taste', severity: 'low', tags: ['internal'], title: (r) => `Control could not be re-located: "${name(r)}"` },
  'missing-accessible-name': { bucket: 'defect', severity: 'high', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html', title: (r) => `Interactive control has no accessible name: "${r.evidence.selector ?? '(unnamed)'}"` },
  'keyboard-inaccessible': { bucket: 'defect', severity: 'high', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html', title: (r) => `Interactive control cannot receive keyboard focus: "${r.evidence.selector ?? '(unknown)'}"` },
  'missing-image-alt': { bucket: 'defect', severity: 'medium', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html', title: (r) => `Informative image has no alt text: "${r.evidence.selector ?? 'image'}"` },
  'invalid-aria-reference': { bucket: 'defect', severity: 'high', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html', title: (r) => `ARIA relationship points to a missing element: "${r.evidence.selector ?? '(unknown)'}"` },
  'invalid-aria-state': { bucket: 'defect', severity: 'high', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html', title: (r) => `Invalid ${r.evidence.accessibility?.attribute ?? 'ARIA'} value on "${r.evidence.selector ?? '(unknown)'}"` },
  'dialog-missing-label': { bucket: 'defect', severity: 'high', tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html', title: (r) => `Visible dialog has no accessible name: "${r.evidence.selector ?? '(dialog)'}"` },
  // Not a defect: the site asked us not to look, and we complied.
  'robots-blocked': { bucket: 'taste', severity: 'low', tags: ['internal'], title: (r) => `Not crawled — robots.txt disallows ${r.evidence.url ?? 'this route'}` },
  // Edge/WAF hold: the app never rendered. Not our bug and not a silent pass.
  'bot-challenge': { bucket: 'taste', severity: 'medium', tags: ['internal'], title: (r) => `Bot challenge interstitial${r.evidence.url ? ` (${r.evidence.url})` : ''} — crawl did not reach the app` },
  'layout-overlap': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
    title: (r) => `In-flow elements collide: "${r.evidence.selector ?? ''}" and "${r.evidence.layout?.otherSelector ?? ''}"`,
  },
  'text-overlap': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
    title: (r) => `Text elements collide: "${r.evidence.selector ?? ''}" and "${r.evidence.layout?.otherSelector ?? ''}"`,
  },
  'text-line-collision': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
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
    tags: ['usability'],
    title: (r) => `Text clipped by overflow:hidden without ellipsis: "${r.evidence.clipping?.textSample || r.evidence.selector || 'text'}"`,
  },
  'viewport-overflow': {
    bucket: 'defect',
    severity: 'high',
    tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html',
    title: (r) => `Content horizontally overflows viewport at "${r.evidence.selector ?? 'page'}"`,
  },
  'pointer-intercepted': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
    title: (r) =>
      `Control click intercepted by overlay element "${r.evidence.hitTest?.interceptedBy ?? 'unknown'}": "${name(r)}"`,
  },
  'small-touch-target': {
    bucket: 'taste',
    severity: 'medium',
    tags: ['wcag22aa'], helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html',
    title: (r) => {
      const sz = r.evidence.hitTest?.targetSize;
      return `Clickable element is smaller than WCAG 24x24px touch target (${sz ? `${sz.width}x${sz.height}px` : 'small'}): "${name(r)}"`;
    },
  },
  'dark-mode-contrast': {
    bucket: 'defect',
    severity: 'high',
    tags: ['wcag2aa'], helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html',
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
    tags: ['usability'],
    title: (r) =>
      `Child element "${r.evidence.selector ?? 'element'}" overflows container "${r.evidence.layout?.otherSelector ?? 'parent'}"`,
  },
  'sibling-overlap': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
    title: (r) =>
      `Vertical sibling blocks overlap: "${r.evidence.selector ?? 'element'}" into "${r.evidence.layout?.otherSelector ?? 'sibling'}"`,
  },
  'text-border-collision': {
    bucket: 'defect',
    severity: 'high',
    tags: ['usability'],
    title: (r) =>
      `Text ink collides with container border or divider: "${r.evidence.selector ?? 'text'}" into "${r.evidence.layout?.otherSelector ?? 'border'}"`,
  },
  'vertical-rhythm-drift': {
    bucket: 'taste',
    severity: 'low',
    tags: ['best-practice'],
    title: (r) => {
      const rh = r.evidence.rhythm;
      return rh
        ? `Vertical rhythm fluctuates erratically (${rh.minGapPx}px vs ${rh.maxGapPx}px gap disparity) across sections`
        : 'Erratic vertical rhythm between sibling sections';
    },
  },
  'viewport-scale-imbalance': {
    bucket: 'taste',
    severity: 'medium',
    tags: ['best-practice'],
    title: (r) => {
      const sc = r.evidence.scale;
      return sc
        ? `Hero heading consumes ${Math.round(sc.occupancyRatio * 100)}% of viewport height (${sc.headingHeightPx}px tall across ${sc.lineCount} lines): "${r.evidence.selector ?? 'heading'}"`
        : 'Hero heading consumes excessive above-the-fold viewport height';
    },
  },
  'unanchored-divider-bleed': {
    bucket: 'taste',
    severity: 'low',
    tags: ['best-practice'],
    title: (r) => {
      const d = r.evidence.divider;
      return d
        ? `Divider line width (${d.lineWidthPx}px) bleeds past content column (${d.contentWidthPx}px) by ${d.bleedPx}px: "${r.evidence.selector ?? 'divider'}"`
        : 'Divider line width unanchored from content grid';
    },
  },
  'adjacent-wordmark-echo': {
    bucket: 'taste',
    severity: 'low',
    tags: ['best-practice'],
    title: (r) => {
      const w = r.evidence.wordmark;
      return w
        ? `Header wordmark "${w.brandText}" repeated verbatim in adjacent hero subhead: "${w.echoText}"`
        : 'Header wordmark repeated in adjacent hero subhead';
    },
  },
  'above-the-fold-vacancy': {
    bucket: 'taste',
    severity: 'medium',
    tags: ['best-practice', 'usability'],
    title: (r) => {
      const v = r.evidence.vacancy;
      return v
        ? `Excessive above-the-fold void (${v.leadGapPx}px gap, ${Math.round(v.vacancyRatio * 100)}% of viewport height) pushes primary content down: "${r.evidence.selector ?? 'heading'}"`
        : 'Excessive above-the-fold vacancy before primary content';
    },
  },
};

function pct(z?: number): string {
  return z ? `${Math.round(z * 100)}% zoom` : 'zoom';
}

export function triageRaw(raw: RawFinding): Finding {
  const rule = RULES[raw.kind];
  let bucket: Bucket = rule.bucket;
  let severity: Severity = rule.severity;

  // Low contrast: a ratio under 3.0 is legible text failing a published WCAG floor, so it
  // is a defect. Between 3.0 and the 4.5 required for body text it is a judgement about
  // whether the text is "large", which a human — or the calling model — should make.
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
    tags: rule.tags,
    ...(rule.helpUrl ? { helpUrl: rule.helpUrl } : {}),
  };
}
