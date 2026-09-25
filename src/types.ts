/**
 * Shared, dependency-free types for the UI-crawl harness.
 *
 * The core distinction the whole harness exists to make:
 *  - `defect`  — objectively broken; positive evidence of brokenness exists.
 *  - `taste`   — ambiguous; a human decides. Silence is ALWAYS taste, never a defect.
 */

export type Bucket = 'defect' | 'taste';
export type Severity = 'high' | 'medium' | 'low';

export type FindingType =
  | 'page-load-error' // navigation failed or HTTP >= 400
  | 'console-error' // a page logged console.error on load
  | 'broken-asset' // 404 or failed network resource (image, script, stylesheet, font)
  | 'dead-button' // a control with a destination did nothing (broken handler/link)
  | 'button-threw' // clicking a control threw (console error on click)
  | 'broken-link' // an <a href>/form action resolved but produced no effect
  | 'maybe-contextual-button' // a bare button did nothing — may need prior input (taste)
  | 'redundant-control' // two controls on a page lead to the same destination (taste)
  | 'low-contrast' // text fails WCAG AA contrast ratio (< 4.5:1 body, < 3:1 large)
  | 'missing-affordance' // interactive element has no visual change on hover/focus and no pointer cursor (taste)
  | 'tight-target' // adjacent interactive touch targets are crowded (< 4px gap or < 24px)
  | 'robots-blocked' // robots.txt disallowed the route, so it was never fetched (never a defect)
  | 'bot-challenge' // edge/WAF interstitial (e.g. Cloudflare) — crawl never reached the app
  | 'zoom-clip' // an element overflows the viewport at a zoom level
  | 'zoom-overlap' // structural elements collide at a zoom level
  | 'stale-selector' // a control could not be re-located after re-navigation
  | 'missing-accessible-name' // a visible interactive control has no accessible name
  | 'keyboard-inaccessible' // a visible interactive control cannot receive focus
  | 'missing-image-alt' // a visible informative image has no alt text
  | 'invalid-aria-reference' // an ARIA relationship points at a missing element
  | 'invalid-aria-state' // a stateful ARIA attribute has an invalid value
  | 'dialog-missing-label' // a visible dialog has no accessible name
  | 'layout-overlap' // in-flow sibling elements collide without negative offsets
  | 'text-overlap' // leaf text elements render directly on top of each other
  | 'text-line-collision' // wrapped multi-line text lines or descenders/ascenders collide
  | 'clipped-text' // text clipped by overflow:hidden without ellipsis or line-clamp
  | 'viewport-overflow' // page or element horizontally overflows the viewport
  | 'pointer-intercepted' // control click intercepted by overlay/occluding element
  | 'small-touch-target' // clickable element smaller than WCAG 24x24px minimum
  | 'dark-mode-contrast' // text fails contrast in dark mode
  | 'container-overflow' // child element bleeds past bottom of its container
  | 'sibling-overlap' // consecutive sibling sections overlap vertically
  | 'text-border-collision' // leaf text descenders/ink collide with container border or divider rule (defect)
  | 'vertical-rhythm-drift' // irregular vertical spacing jumps between sibling sections (taste)
  | 'viewport-scale-imbalance' // hero heading consumes >35% of above-the-fold viewport height (taste)
  | 'unanchored-divider-bleed' // horizontal divider line width exceeds page content grid boundaries (taste)
  | 'adjacent-wordmark-echo'; // site wordmark text immediately repeated in adjacent hero subhead (taste)

export interface SourceLocation {
  file?: string;
  line?: number;
  column?: number;
  component?: string;
  hierarchy?: string[];
}

/** Bounding box of a structural element, viewport-relative, in CSS px. */
export interface Box {
  selector: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything observed in the window after a single click. Pure input to `classifyChange`. */
export interface Signals {
  navigated: boolean;
  urlChanged: boolean;
  domMutated: boolean;
  domMutationCount: number;
  networkRequests: number;
  newConsoleMessages: number;
  consoleErrors: number;
  dialogOpened: boolean;
  popupOpened: boolean;
  clickThrew: boolean;
}

export type ChangeVerdict = 'ACTED' | 'NOOP' | 'INCONCLUSIVE';

/** A single interactive element, with a stable-enough descriptor to re-locate after reload. */
export interface Control {
  /**
   * DOM-order index within the page's interactive-element selector. The re-location
   * key for selector-sourced controls. `-1` when the control came from observe and
   * is re-found only via `locator`.
   */
  index: number;
  tag: string;
  role?: string;
  accessibleName: string;
  disabled: boolean;
  /** Rendered (non-zero box, not display:none). Hidden controls are inventoried but not probed. */
  visible: boolean;
  /** Resolved absolute href, if an anchor. */
  navTarget?: string;
  /** Form action, if a submit. */
  formAction?: string;
  /** Name matches delete/remove/sign-out/pay/charge — probed defensively, never committed. */
  destructive: boolean;
  /** How the control entered the inventory. Absent = classic CSS selector enumeration. */
  source?: 'selector' | 'observe';
  /** Explicit re-location strategy when `index` cannot address the element. */
  locator?: { css: string };
  /** Structural HTML landmark container where the control resides. */
  landmark?: 'header' | 'nav' | 'main' | 'footer' | 'aside' | 'section' | 'dialog' | 'other';
}

export interface Evidence {
  screenshot?: string; // path relative to outDir
  viewport?: { width: number; height: number; label?: string };
  selector?: string;
  accessibleName?: string;
  consoleText?: string[];
  url?: string;
  boxes?: Box[];
  signals?: Signals;
  zoom?: number;
  contrast?: {
    ratio: number;
    fg: string;
    bg: string;
    fontSize: string;
    fontWeight: string;
    textSample?: string;
    /**
     * Offsets of `textSample` in the page's normalized visible text (the same text the
     * page-level `textDigest` hashes), so a re-crawl can verify the quote still sits
     * where the finding says it does instead of taking the sample on trust.
     */
    textStart?: number;
    textEnd?: number;
  };
  spacing?: {
    distancePx: number;
    otherSelector?: string;
    box?: Box;
    otherBox?: Box;
  };
  affordance?: {
    checkedStyles: string[];
    hadPointer: boolean;
    hadHoverChange: boolean;
    hadFocusChange: boolean;
    hadActiveChange?: boolean;
    hoverChanges?: string[];
    activeChanges?: string[];
    focusChanges?: string[];
  };
  accessibility?: {
    role?: string;
    accessibleName?: string;
    tabIndex?: number;
    focusable?: boolean;
    alt?: string;
    attribute?: string;
    value?: string;
    target?: string;
  };
  layout?: {
    otherSelector?: string;
    overlapFrac?: number;
    box?: Box;
    otherBox?: Box;
    overflowPx?: number;
  };
  typography?: {
    ratio?: number;
    fontSize?: string;
    lineHeight?: string;
    directOverlap?: boolean;
  };
  clipping?: {
    scrollWidth: number;
    clientWidth: number;
    textSample?: string;
  };
  remediation?: string;
  source?: SourceLocation;
  cropBase64?: string;
  theme?: 'light' | 'dark';
  hitTest?: {
    interceptedBy?: string;
    bounds?: Box;
    targetSize?: { width: number; height: number };
  };
  rhythm?: {
    minGapPx: number;
    maxGapPx: number;
    medianGapPx: number;
    ratio: number;
  };
  scale?: {
    headingHeightPx: number;
    viewportHeightPx: number;
    occupancyRatio: number;
    lineCount: number;
  };
  divider?: {
    lineWidthPx: number;
    contentWidthPx: number;
    bleedPx: number;
  };
  wordmark?: {
    brandText: string;
    echoText: string;
    distancePx: number;
  };
}

/** A detected issue before bucketing. The detectors emit these; `triageRaw` maps them to `Finding`. */
export interface RawFinding {
  route: string;
  kind: FindingType;
  evidence: Evidence;
  /** Near-threshold zoom collision or a no-destination button — eligible for model refinement. */
  ambiguous?: boolean;
  control?: Pick<Control, 'accessibleName' | 'tag' | 'navTarget' | 'formAction'>;
}

export interface Finding {
  id?: string;
  fingerprint?: string;
  route: string;
  type: FindingType;
  bucket: Bucket;
  severity: Severity;
  title: string;
  evidence: Evidence;
  source?: SourceLocation;
  /** Actionable remediation hint (CSS rule, property fix, or markup advice). */
  remediation?: string;
  /** Present only when an injected model refined this finding (v2). */
  triage?: { by: 'text' | 'vision'; verdict: string; mode: 'model' | 'skipped' };
}

export interface ColorPalette {
  backgrounds: string[];
  text: string[];
  accents: string[];
}

/** Same-origin API/XHR/fetch call observed while loading (or sweeping) a page. */
export interface ApiCall {
  method: string;
  /** Path+query when same-origin; absolute URL when cross-origin. */
  url: string;
  status?: number;
  resourceType: string;
  contentType?: string;
}

export interface PageReport {
  route: string;
  template: string;
  /** Viewport used for this page render. One PageReport is emitted per configured viewport. */
  viewport?: { width: number; height: number; label?: string };
  status: number | null;
  loadError?: string;
  /** Main document looked like a bot-challenge interstitial; audits were skipped. */
  challenged?: boolean;
  screenshot?: string;
  zoomShots?: { zoom: number; screenshot: string }[];
  consoleErrors: string[];
  failedRequests: { url: string; status?: number; failure?: string }[];
  /** XHR/fetch inventory for scrapers (capped). Absent when inventory is skipped. */
  apiCalls?: ApiCall[];
  /** API calls beyond the inventory cap (PageReport.apiCalls length stays at cap). */
  apiCallsOverflow?: number;
  controlCount: number;
  /** Interactive controls actually click-probed. Absent when the sweep was skipped. */
  probedControls?: number;
  /** Controls left unprobed because `maxProbesPerPage` was reached. Reported, never silent. */
  skippedControls?: number;
  /**
   * FNV-1a hash of this page's normalized visible text, and its length. Finding text is
   * quoted against that same text via `textStart`/`textEnd`, so the pair is what makes a
   * quote re-checkable on a later crawl rather than merely plausible.
   */
  textDigest?: number;
  textLength?: number;
  palette?: ColorPalette;
}

export interface DiffResult {
  runA: string;
  runB: string;
  fixed: Finding[];
  regressions: Finding[];
  persistent: Finding[];
}

export interface CrawlResult {
  runId?: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: PageReport[];
  findings: Finding[];
  diff?: DiffResult;
  /** Site guidance (robots/sitemap/llms) when fetched — a map for review agents. */
  guidance?: GuidanceSummary;
  /** Rolled-up unique API paths across pages (scraping surface). */
  apiIndex?: { method: string; url: string; pages: string[]; statuses: number[] }[];
  reportPath?: string;
}

/** Compact guidance for findings.json / gallery (raw files live under guidance/). */
export interface GuidanceSummary {
  fetchedAt: string;
  robots?: { status: number; allow: string[]; disallow: string[] };
  sitemap?: { urlCount: number; samplePaths: string[] };
  llms?: { path: string; headings: string[]; excerpt: string };
}
