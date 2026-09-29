/**
 * Shared sink for failures outside `runDetector`.
 *
 * `runDetector` covers the crawl's named detectors, but plenty of plumbing — modal
 * detection, control enumeration, badge marking, form auto-fill — can also throw, and a
 * silent catch there read as "no modal open" / "no controls" / "nothing to fill", which is
 * exactly the false-clean this instrument forbids. Callers report into this sink; the crawl
 * installs a handler that appends to `detectorFailures` and writes stderr. Reporting must
 * never throw, so the handler is wrapped.
 */
export type DetectorErrorHandler = (route: string, detector: string, message: string) => void;

let handler: DetectorErrorHandler | null = null;

export function setDetectorErrorHandler(h: DetectorErrorHandler | null): void {
  handler = h;
}

export function reportDetectorFailure(route: string, detector: string, message: string): void {
  try {
    handler?.(route, detector, message);
  } catch {
    /* reporting must never throw into the caller */
  }
}