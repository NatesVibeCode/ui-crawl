# ÆLTUM native-terminal checklist

Run this after the deterministic PTY campaign, in the terminal emulator and on the
host where ÆLTUM will be used. Record the emulator/version, operating system, font,
theme, terminal dimensions, exact key/input sequence, and native screenshots. PTY cell
screenshots, ANSI logs, `ACTED`, and OSC 52 output bytes do not prove terminal receipt.

## Copy and selection

- Copy a complete answer and read the host clipboard in a scratch editor. Compare its
  bytes with the retained assistant response, including Unicode and line breaks.
- Select and copy a range from a long answer; compare it with the exact source range.
- Copy after scrolling, then after resizing. Confirm the selected source text remains
  the same and the terminal does not copy prompt chrome or status text.
- Check a terminal that supports OSC 52 and one that blocks it. Record whether the UI
  reports a copy only after the terminal accepts the request.
- Verify copy/export preserve the original source text when visible reasoning or tool
  detail is collapsed.

## Theme and rendering

- Run the same transcript in dark, light, and system terminal themes.
- Read body text, reasoning, tool arguments/output, warnings, failure receipts, selected
  menu rows, dim labels, and the composer at normal and narrow widths.
- Check glyphs used by ÆLTUM, wide characters, combining marks, code blocks, and wrapped
  JSON arguments with the configured terminal font.
- Capture a native image for each theme and note any terminal palette overrides.

## Keyboard and terminal protocols

- Confirm `Escape` interrupts a live run and `Ctrl+C` exits the app; neither should be
  confused with the other.
- Test `Ctrl+Up/Down`, `Ctrl+PgUp/PgDown`, menu arrows, `Tab`, `Shift+Tab`, and `Escape`
  inside each menu/panel, including when the composer contains an unsent draft.
- Paste text beginning with `/`, multi-line text, and Unicode through bracketed paste.
  Confirm it remains a draft until the user submits it.
- Resize with an open menu and while a long answer is visible. Confirm the selected row,
  draft, transcript position, and composer padding survive the resize.
- Check mouse wheel and text selection with mouse capture enabled and disabled.

## Evidence record

For each failure, save the exact input, the visible before/after state, native screenshot,
and any clipboard text read from the host. Keep operation receipts and source transcript
records alongside it so copied/exported bytes have an exact comparison target.
