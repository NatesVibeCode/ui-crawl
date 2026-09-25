import { describe, it, expect, vi } from 'vitest';
import { detectOpenModal, auditOpenModal, dismissOpenModal, autoFillFormInputs } from '../src/appState.js';

describe('appState: detectOpenModal', () => {
  it('returns isOpen false when no dialog or modal is in DOM', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({ isOpen: false }),
    } as unknown as import('playwright').Page;

    const res = await detectOpenModal(mockPage);
    expect(res.isOpen).toBe(false);
  });

  it('detects an open dialog with scroll-lock and focus trap', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({
        isOpen: true,
        selector: 'dialog#lead-capture-modal',
        isScrollLocked: true,
        isFocusTrapped: true,
      }),
    } as unknown as import('playwright').Page;

    const res = await detectOpenModal(mockPage);
    expect(res.isOpen).toBe(true);
    expect(res.selector).toBe('dialog#lead-capture-modal');
    expect(res.isScrollLocked).toBe(true);
    expect(res.isFocusTrapped).toBe(true);
  });
});

describe('appState: auditOpenModal', () => {
  it('detects modal dialog viewport overflow on small screens', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({
        x: 100,
        y: 50,
        w: 600,
        h: 900,
        overflowTop: false,
        overflowBottom: true,
        overflowAmountY: 100,
      }),
    } as unknown as import('playwright').Page;

    const findings = await auditOpenModal(mockPage, '/define', {
      selector: 'dialog#lead-modal',
    });

    expect(findings.length).toBeGreaterThan(0);
    const overflowFinding = findings.find((f) => f.kind === 'viewport-overflow');
    expect(overflowFinding).toBeDefined();
    expect(overflowFinding?.evidence.selector).toBe('dialog#lead-modal');
    expect(overflowFinding?.evidence.layout?.overflowPx).toBe(100);
  });
});

describe('appState: autoFillFormInputs', () => {
  it('calls in-page evaluator to populate benign inputs', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(4),
    } as unknown as import('playwright').Page;

    const filledCount = await autoFillFormInputs(mockPage);
    expect(filledCount).toBe(4);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });
});
