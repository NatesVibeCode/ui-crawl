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
  | 'zoom-clip' // an element overflows the viewport at a zoom level
  | 'zoom-overlap' // structural elements collide at a zoom level
  | 'stale-selector'; // a control could not be re-located after re-navigation

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
  /** DOM-order index within the page's interactive-element selector. The re-location key. */
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
}

export interface Evidence {
  screenshot?: string; // path relative to outDir
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
  route: string;
  type: FindingType;
  bucket: Bucket;
  severity: Severity;
  title: string;
  evidence: Evidence;
  /** Present only when an injected model refined this finding (v2). */
  triage?: { by: 'text' | 'vision'; verdict: string; mode: 'model' | 'skipped' };
}

export interface ColorPalette {
  backgrounds: string[];
  text: string[];
  accents: string[];
}

export interface PageReport {
  route: string;
  template: string;
  status: number | null;
  loadError?: string;
  screenshot?: string;
  zoomShots?: { zoom: number; screenshot: string }[];
  consoleErrors: string[];
  failedRequests: { url: string; status?: number; failure?: string }[];
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

export interface CrawlResult {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: PageReport[];
  findings: Finding[];
  reportPath?: string;
}
