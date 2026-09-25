/** Interactive elements we probe. DOM order here must match `page.locator(SELECTOR).nth(i)`. */
export const SELECTOR = 'button, a[href], [role="button"], [onclick], input[type="submit"], input[type="button"]';

/**
 * Broader interactive set for snapshots, observe, and stale-selector relocation —
 * includes controls the probe SELECTOR misses (menus, tabs, custom roles, tabindex widgets).
 */
export const SNAPSHOT_SELECTOR = [
  SELECTOR,
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="treeitem"]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable=""],[contenteditable="true"]',
  'input:not([type="hidden"]), textarea, select',
  'summary',
].join(', ');
