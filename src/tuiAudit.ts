import * as path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { TuiSession } from './tuiSession.js';
import type { Finding, FindingType, Severity, Bucket, DetectorFailure } from './types.js';
import { summarize, buildGroups, type AgentPayload } from './report.js';

export interface TuiAuditOptions {
  command: string | string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  outDir?: string;
  settleMs?: number;
  probeControls?: boolean;
  captureCrops?: boolean;
}

export async function auditTui(options: TuiAuditOptions): Promise<AgentPayload> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outDir = options.outDir ?? './ui-crawl-out';
  await mkdir(outDir, { recursive: true });

  const route = `tui://${Array.isArray(options.command) ? options.command.join(' ') : options.command}`;
  const findings: Finding[] = [];

  let session: TuiSession;
  try {
    session = await TuiSession.open({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      outDir,
      interactionTimeoutMs: options.settleMs ?? 800,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    findings.push({
      id: `find_${Math.random().toString(36).slice(2, 10)}`,
      fingerprint: `${route}::spawn-error`,
      route,
      type: 'page-load-error',
      bucket: 'defect',
      severity: 'high',
      title: `Failed to spawn TUI command: ${errorMsg}`,
      evidence: {
        selector: 'terminal:process',
        consoleText: [errorMsg],
      },
      remediation: 'Ensure the command binary exists and is executable in the target environment',
    });

    const summary = summarize(findings);
    return {
      runId,
      verdict: 'has_defects',
      summary: {
        defects: summary.defects,
        taste: summary.taste,
        pagesCrawled: 1,
        byType: summary.byType,
        truncated: 0,
        detectorFailures: [],
      },
      actions: findings,
      groups: buildGroups(findings as any),
      routes: [route],
      pages: [
        {
          route,
          screenshot: '',
          zoomShots: [],
          status: 500,
          controlCount: 0,
          probedControls: 0,
          skippedControls: 0,
        },
      ],
    };
  }

  const detectorFailures: DetectorFailure[] = [];
  let controlCount = 0, probedControls = 0;
  let screenshotRel = '';
  try {
    screenshotRel = await session.screenshot(false);
  } catch (error) {
    detectorFailures.push({ route, detector: 'terminal-screenshot', message: String(error) });
    findings.push({ id: `${runId}_screenshot`, fingerprint: `${route}::screenshot-failed`, route, type: 'page-load-error', bucket: 'defect', severity: 'high', title: 'Terminal screenshot could not be captured', evidence: { selector: 'terminal:screen', consoleText: [String(error)] }, remediation: 'Restore the terminal screenshot renderer and repeat the audit' });
  }

  try {
    // 1. Check for process failure or blank output
    const isExitedWithError = session.exited && session.exitCode !== null && session.exitCode !== 0;
    const isBlankScreen = session.rawText.trim().length === 0;

    if (isExitedWithError) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::process-exit::${session.exitCode}`,
        route,
        type: 'page-load-error',
        bucket: 'defect',
        severity: 'high',
        title: `TUI process exited with failure status code ${session.exitCode}`,
        evidence: {
          selector: 'terminal:process',
          consoleText: session.stderrText ? [session.stderrText] : undefined,
        },
        remediation: session.stderrText
          ? `Command exited with status ${session.exitCode}. Stderr: ${session.stderrText.trim().slice(0, 300)}`
          : `Ensure the command exits cleanly with status 0. Process exited with code ${session.exitCode}`,
      });
    } else if (isBlankScreen) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::console-error::blank-screen`,
        route,
        type: 'page-load-error',
        bucket: 'defect',
        severity: 'high',
        title: 'TUI failed to render any output to screen',
        evidence: {
          selector: 'terminal:screen',
          consoleText: session.stderrText ? [session.stderrText] : undefined,
        },
        remediation: session.stderrText
          ? `TUI screen remained completely blank. Stderr: ${session.stderrText.trim().slice(0, 300)}`
          : 'Ensure the command produces interactive terminal output and does not exit immediately with empty output',
      });
    }

    // Check for replacement character (broken encoding / fallback failure)
    if (session.rawText.includes('\uFFFD')) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::broken-encoding::replacement-char`,
        route,
        type: 'page-load-error',
        bucket: 'defect',
        severity: 'high',
        title: 'Screen output contains Unicode replacement character (\uFFFD)',
        evidence: {
          selector: 'terminal:screen',
        },
        remediation: 'Verify UTF-8 encoding or provide safe ASCII/Unicode fallbacks for glyphs',
      });
    }

    // 2. Contrast audit across character cells
    const controls = await session.snapshot();
    controlCount = controls.filter(c => c.kind !== 'focus').length;
    const contrastHits = session.screenBuffer.auditContrast(4.5);
    const seenCombos = new Set<string>();

    for (const hit of contrastHits) {
      const comboKey = `${hit.fg}->${hit.bg}`;
      if (seenCombos.has(comboKey)) continue;
      seenCombos.add(comboKey);

      const bucket: Bucket = hit.ratio < 3.0 ? 'defect' : 'taste';
      const severity: Severity = hit.ratio < 2.0 ? 'high' : hit.ratio < 3.0 ? 'medium' : 'low';
      const suggestedText = hit.suggestedFg
        ? `Set foreground color to ${hit.suggestedFg} to clear 4.5:1 ratio`
        : `Change background color from ${hit.bg} to provide contrast`;

      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::low-contrast::${comboKey}`,
        route,
        type: 'low-contrast',
        bucket,
        severity,
        title: hit.ratio < 3.0
          ? `Low contrast terminal text "${hit.char}" (${hit.ratio}:1)`
          : `Sub-WCAG AA contrast on terminal text "${hit.char}" (${hit.ratio}:1, expected >= 4.5:1)`,
        remediation: suggestedText,
        evidence: {
          selector: `row:${hit.row},col:${hit.col}`,
          contrast: {
            ratio: hit.ratio,
            fg: hit.fg,
            bg: hit.bg,
            fontSize: '14px',
            fontWeight: '400',
            suggestedFg: hit.suggestedFg,
          },
        },
      });
    }

    // 3. Overflow and layout clipping
    const lines = session.lines;
    const cols = options.cols ?? 80;
    for (let r = 0; r < lines.length; r++) {
      const line = lines[r];
      if (line.length >= cols) {
        const lastChars = line.slice(cols - 4);
        if (lastChars.includes('...') || lastChars.includes('…')) {
          findings.push({
            id: `find_${Math.random().toString(36).slice(2, 10)}`,
            fingerprint: `${route}::clipped-text::row-${r}`,
            route,
            type: 'clipped-text',
            bucket: 'taste',
            severity: 'low',
            title: `Text on row ${r} appears clipped at terminal boundary`,
            evidence: {
              selector: `row:${r}`,
            },
            remediation: 'Increase terminal width or wrap text gracefully',
          });
        }
      }
    }

    // 4. Interactive control spacing (Tight targets)
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const c1 = controls[i];
        const c2 = controls[j];
        if (c1.row === c2.row) {
          if (c1.col + c1.width === c2.col || c2.col + c2.width === c1.col) {
            findings.push({
              id: `find_${Math.random().toString(36).slice(2, 10)}`,
              fingerprint: `${route}::tight-target::${c1.index}-${c2.index}`,
              route,
              type: 'tight-target',
              bucket: 'taste',
              severity: 'low',
              title: `Adjacent interactive controls are crowded (0 col gap): "${c1.label}" and "${c2.label}"`,
              evidence: {
                selector: `[${c1.index}]`,
                spacing: {
                  distancePx: 0,
                  otherSelector: `[${c2.index}]`,
                },
              },
              remediation: 'Insert at least 1-2 space columns between adjacent interactive controls',
            });
          }
        }
      }
    }

    // 5. Active focus affordance across interactive controls
    if (controls.length >= 2) {
      const hasFocusedControl = controls.some((c) => c.focused);
      const hasMenuPointer = controls.some(
        (c) => c.kind === 'menu-item' && (c.label.startsWith('>') || c.label.startsWith('*')),
      );
      const hasInvertedControl = controls.some((c) => {
        const row = session.screenBuffer.currentGrid[c.row];
        if (!row) return false;
        for (let col = c.col; col < Math.min(row.length, c.col + c.width); col++) {
          if (row[col]?.inverse) return true;
        }
        return false;
      });

      if (!hasFocusedControl && !hasMenuPointer && !hasInvertedControl) {
        findings.push({
          id: `find_${Math.random().toString(36).slice(2, 10)}`,
          fingerprint: `${route}::missing-affordance::no-focus`,
          route,
          type: 'missing-affordance',
          bucket: 'taste',
          severity: 'medium',
          title: 'Interactive controls present but no active focus indicator or cursor affordance',
          evidence: {
            selector: 'terminal:controls',
          },
          remediation: 'Highlight the currently active/focused item using cursor positioning, ">" pointer, or inverted background color',
        });
      }
    }

    // 6. Viewport scale imbalance (Excessive ASCII art / banner height)
    let bannerRows = 0;
    const bannerCharRegex = /^[─━═─┌┐└┘┏┓┗┛╔╗╚╝\s_|\/\\#*@~=+<>\[\]():;.-]+$/;
    for (let r = 0; r < Math.min(lines.length, Math.floor(session.terminalRows * 0.7)); r++) {
      const line = lines[r].trim();
      if (!line) {
        if (bannerRows > 0) break;
        continue;
      }
      const hasArtChars = /[█▀▄▌▐░▒▓#@*\\\/_|=]{4,}/.test(line);
      const isBannerLine = hasArtChars || (bannerCharRegex.test(line) && line.length > 20);
      if (isBannerLine) {
        bannerRows++;
      } else {
        if (bannerRows >= 3) break;
        bannerRows = 0;
      }
    }

    const occupancyRatio = bannerRows / session.terminalRows;
    if (occupancyRatio > 0.35 && bannerRows >= 4) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::viewport-scale-imbalance::banner`,
        route,
        type: 'viewport-scale-imbalance',
        bucket: 'taste',
        severity: 'medium',
        title: `Header banner consumes ${Math.round(occupancyRatio * 100)}% of terminal viewport height (${bannerRows} rows across ${session.terminalRows})`,
        evidence: {
          selector: 'terminal:banner',
          scale: {
            headingHeightPx: bannerRows,
            viewportHeightPx: session.terminalRows,
            occupancyRatio: Math.round(occupancyRatio * 100) / 100,
            lineCount: bannerRows,
          },
        },
        remediation: `Banner consumes ${Math.round(occupancyRatio * 100)}% of terminal height. Scale down ASCII art or use a single-line heading to conserve terminal screen space`,
      });
    }

    // 6b. Above-the-fold vacancy (Excessive blank leading rows before content)
    let leadingBlankRows = 0;
    for (let r = 0; r < lines.length; r++) {
      if (lines[r].trim().length === 0) {
        leadingBlankRows++;
      } else {
        break;
      }
    }
    const vacancyRatio = leadingBlankRows / session.terminalRows;
    if (leadingBlankRows >= 4 && vacancyRatio >= 0.2) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::above-the-fold-vacancy`,
        route,
        type: 'above-the-fold-vacancy',
        bucket: 'taste',
        severity: 'low',
        title: `Screen begins with ${leadingBlankRows} blank rows (${Math.round(vacancyRatio * 100)}% of terminal height) before initial content`,
        evidence: {
          selector: 'terminal:screen',
          vacancy: {
            headerBottomPx: 0,
            contentTopPx: leadingBlankRows,
            leadGapPx: leadingBlankRows,
            viewportHeightPx: session.terminalRows,
            vacancyRatio: Math.round(vacancyRatio * 100) / 100,
          },
        },
        remediation: `Eliminate leading blank lines (${leadingBlankRows} rows) so terminal application content is visible without scrolling`,
      });
    }

    // 7. Vertical rhythm drift (erratic blank line gaps between sections)
    const blockGaps: number[] = [];
    let inBlock = false;
    let currentGap = 0;
    let textBlocks = 0;

    for (let r = 0; r < lines.length; r++) {
      const isBlank = lines[r].trim().length === 0;
      if (isBlank) {
        if (inBlock) {
          inBlock = false;
          currentGap = 1;
        } else {
          currentGap++;
        }
      } else {
        if (!inBlock) {
          if (textBlocks > 0) {
            blockGaps.push(currentGap);
          }
          textBlocks++;
          inBlock = true;
          currentGap = 0;
        }
      }
    }

    if (blockGaps.length >= 3) {
      const minGap = Math.min(...blockGaps);
      const maxGap = Math.max(...blockGaps);
      const sorted = [...blockGaps].sort((a, b) => a - b);
      const medianGap = sorted[Math.floor(sorted.length / 2)];
      const ratio = minGap === 0 ? maxGap + 1 : maxGap / minGap;

      if (maxGap >= 3 && ratio >= 2.5) {
        findings.push({
          id: `find_${Math.random().toString(36).slice(2, 10)}`,
          fingerprint: `${route}::vertical-rhythm-drift`,
          route,
          type: 'vertical-rhythm-drift',
          bucket: 'taste',
          severity: 'low',
          title: `Vertical rhythm fluctuates erratically (${minGap} rows vs ${maxGap} rows gap disparity) across sections`,
          evidence: {
            selector: 'terminal:layout',
            rhythm: {
              minGapPx: minGap,
              maxGapPx: maxGap,
              medianGapPx: medianGap,
              ratio: Math.round(ratio * 10) / 10,
            },
          },
          remediation: `Standardize blank line spacing between sections using consistent row padding (${medianGap} blank row${medianGap === 1 ? '' : 's'})`,
        });
      }
    }

    // 8. Unanchored divider bleed (divider line width mismatches content width)
    let contentColWidth = 0;
    for (const line of lines) {
      const boxMatch = /^[┌╔\+\|│║](.+)[┐╗\+\|│║]$/.exec(line.trim());
      if (boxMatch) {
        contentColWidth = Math.max(contentColWidth, line.trim().length);
      }
    }

    if (contentColWidth > 15) {
      const dividerRegex = /^([─═\-=_*~]{10,})$/;
      for (let r = 0; r < lines.length; r++) {
        const trimmed = lines[r].trim();
        const m = dividerRegex.exec(trimmed);
        if (m) {
          const divWidth = m[1].length;
          const bleed = Math.abs(divWidth - contentColWidth);
          if (bleed >= 10 && divWidth !== (options.cols ?? 80)) {
            findings.push({
              id: `find_${Math.random().toString(36).slice(2, 10)}`,
              fingerprint: `${route}::unanchored-divider-bleed::row-${r}`,
              route,
              type: 'unanchored-divider-bleed',
              bucket: 'taste',
              severity: 'low',
              title: `Divider line width (${divWidth} cols) does not align with content column (${contentColWidth} cols)`,
              evidence: {
                selector: `row:${r}`,
                divider: {
                  lineWidthPx: divWidth,
                  contentWidthPx: contentColWidth,
                  bleedPx: bleed,
                },
              },
              remediation: `Align divider line width (${divWidth} cols) to match the enclosing content boundary (${contentColWidth} cols)`,
            });
            break;
          }
        }
      }
    }

    // 9. Card / box interior horizontal padding (text-border-collision)
    for (let r = 0; r < lines.length; r++) {
      const line = lines[r];
      const unpaddedLeft = /[│║][A-Za-z0-9]/.test(line);
      const unpaddedRight = /[A-Za-z0-9][│║]/.test(line);
      if (unpaddedLeft || unpaddedRight) {
        findings.push({
          id: `find_${Math.random().toString(36).slice(2, 10)}`,
          fingerprint: `${route}::text-border-collision::row-${r}`,
          route,
          type: 'text-border-collision',
          bucket: 'taste',
          severity: 'low',
          title: `Text in card or box container lacks interior horizontal padding on row ${r}`,
          evidence: {
            selector: `row:${r}`,
          },
          remediation: 'Provide at least 1 column of horizontal space between box border lines and content (e.g. "│ Text │" instead of "│Text│")',
        });
        break;
      }
    }

    // 10. Button interior character padding (tight-target)
    for (const ctrl of controls) {
      if (ctrl.kind === 'button') {
        const rawSlice = session.lines[ctrl.row]?.slice(ctrl.col, ctrl.col + ctrl.width);
        if (rawSlice && /^\[\S+\]$/.test(rawSlice.trim())) {
          findings.push({
            id: `find_${Math.random().toString(36).slice(2, 10)}`,
            fingerprint: `${route}::tight-button-padding::[${ctrl.index}]`,
            route,
            type: 'tight-target',
            bucket: 'taste',
            severity: 'low',
            title: `Button [${ctrl.index}] "${ctrl.label}" lacks interior character padding inside brackets`,
            evidence: {
              selector: `[${ctrl.index}]`,
            },
            remediation: `Add a space inside button delimiters: "[ ${ctrl.label} ]" instead of "[${ctrl.label}]"`,
          });
          break;
        }
      }
    }

    // 11. Accessible diff presentation (missing-affordance)
    let hasGreenLineWithoutSign = false;
    let hasRedLineWithoutSign = false;
    for (let r = 0; r < Math.min(lines.length, session.screenBuffer.currentGrid.length); r++) {
      const row = session.screenBuffer.currentGrid[r];
      if (!row || row.length === 0) continue;
      const trimmed = lines[r].trim();
      if (!trimmed.startsWith('+') && !trimmed.startsWith('-') && !trimmed.startsWith('~') && !trimmed.startsWith('@@')) {
        const greenCount = row.filter((c) => c.fg === '#00cd00' || c.fg === '#00ff00').length;
        const redCount = row.filter((c) => c.fg === '#cd0000' || c.fg === '#ff0000').length;
        if (greenCount >= 6) hasGreenLineWithoutSign = true;
        if (redCount >= 6) hasRedLineWithoutSign = true;
      }
    }
    if (hasGreenLineWithoutSign && hasRedLineWithoutSign) {
      findings.push({
        id: `find_${Math.random().toString(36).slice(2, 10)}`,
        fingerprint: `${route}::diff-missing-gutter-symbol`,
        route,
        type: 'missing-affordance',
        bucket: 'taste',
        severity: 'medium',
        title: 'Diff or comparison view uses red/green coloring without redundant gutter signs (+/-)',
        evidence: {
          selector: 'terminal:diff',
        },
        remediation: 'Prefix diff lines with "+" for additions and "-" for removals to maintain accessibility for colorblind users and monochrome terminals',
      });
    }

    // 12. Thinking stream subordination (missing-affordance)
    for (let r = 0; r < lines.length; r++) {
      if (/(?:^|\s)(?:<thinking>|thinking\.\.\.|\* thinking:)/i.test(lines[r])) {
        const row = session.screenBuffer.currentGrid[r];
        const hasDim = row?.some((c) => c.dim);
        const hasMuted = row?.some((c) => c.fg === '#7f7f7f' || c.fg === '#808080' || c.fg === '#555555');
        if (!hasDim && !hasMuted) {
          findings.push({
            id: `find_${Math.random().toString(36).slice(2, 10)}`,
            fingerprint: `${route}::unmuted-thinking-stream::row-${r}`,
            route,
            type: 'missing-affordance',
            bucket: 'taste',
            severity: 'low',
            title: `Thinking stream on row ${r} lacks dim or muted styling to distinguish reasoning from response`,
            evidence: {
              selector: `row:${r}`,
            },
            remediation: 'Render thinking or chain-of-thought tokens using ANSI dim/faint mode (\\x1b[2m) or muted secondary color to subordinate intermediate reasoning to final output',
          });
          break;
        }
      }
    }

    // 13. Probe interactive controls if requested
    if (options.probeControls === true && controls.length > 0) {
      for (const ctrl of controls.slice(0, 3)) {
        if (ctrl.kind === 'button' || ctrl.kind === 'menu-item' || ctrl.kind === 'checkbox') {
          const current = await session.snapshot();
          const same = current.find(c => c.row === ctrl.row && c.col === ctrl.col && c.kind === ctrl.kind && c.label === ctrl.label);
          if (!same) continue;
          const res = await session.act({ type: 'click', index: same.index });
          if (res.ok) probedControls++;
          if (res.verdict === 'NOOP') {
            findings.push({
              id: `find_${Math.random().toString(36).slice(2, 10)}`,
              fingerprint: `${route}::dead-control::[${ctrl.index}]-${ctrl.label}`,
              route,
              type: 'maybe-contextual-button',
              bucket: 'taste',
              severity: 'low',
              title: `Control [${ctrl.index}] "${ctrl.label}" produced no visible change on activation`,
              evidence: {
                selector: `[${ctrl.index}]`,
              },
              remediation: 'Verify control click/activation handler is wired to update state',
            });
          }
        }
      }
    }
  } finally {
    await session.close();
  }

  const summary = summarize(findings);
  const defects = summary.defects;
  const taste = summary.taste;
  const verdict = defects > 0 ? 'has_defects' : taste > 0 ? 'has_taste_questions' : 'clean';

  return {
    runId,
    verdict,
    summary: {
      defects,
      taste,
      pagesCrawled: 1,
      byType: summary.byType,
      truncated: 0,
      detectorFailures,
    },
    actions: findings,
    groups: buildGroups(findings as any),
    routes: [route],
    pages: [
      {
        route,
        screenshot: screenshotRel,
        zoomShots: [],
        status: findings.some(f => f.type === 'page-load-error') ? 500 : 200,
        controlCount,
        probedControls,
        skippedControls: Math.max(0, controlCount - probedControls),
      },
    ],
  };
}
