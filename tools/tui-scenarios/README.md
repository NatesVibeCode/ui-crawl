# ÆLTUM TUI scenarios

These manifests drive the actual `aoa` terminal app in a PTY. The runner creates a
temporary workspace and deployment, writes an ABAC policy limited to `file_read` and
`file_write`, pins that policy through `aoa settings pin`, and starts the SDK fixture
provider on `127.0.0.1`. The projected tools still execute through OE against that
temporary workspace. The fixture provider has no outbound HTTP client and refuses
unlisted Chat Completions requests.

Run from the ui-crawl checkout after building `dist/`:

```sh
npm run build
node tools/tui-scenario-runner.mjs --self-test
node '/Users/nate/Private Repos/harness-sdk/tools/tui-scenarios/self-test.mjs'
```

Build the SDK CLI into a disposable directory after the primary integration has
finished wiring the lanes:

```sh
mkdir -p /tmp/aeltum-lane5
cd '/Users/nate/Private Repos/harness-sdk'
go build -o /tmp/aeltum-lane5/aoa ./cmd/aoa
```

Run the full interaction campaign the fork/resume campaign, and the two narrow failure cases:

```sh
cd '/Users/nate/Public Repos/ui-crawl'
node tools/tui-scenario-runner.mjs \
  --binary /tmp/aeltum-lane5/aoa \
  --sdk '/Users/nate/Private Repos/harness-sdk' \
  --scenario tools/tui-scenarios/aeltum-smoke.json \
  --out '/Users/nate/Documents/Codex/2026-09-29-aeltum-tui-reference-study/build-lanes/lane-5-evidence/campaign'
node tools/tui-scenario-runner.mjs \
  --binary /tmp/aeltum-lane5/aoa \
  --sdk '/Users/nate/Private Repos/harness-sdk' \
  --scenario tools/tui-scenarios/aeltum-cancel.json \
  --out '/Users/nate/Documents/Codex/2026-09-29-aeltum-tui-reference-study/build-lanes/lane-5-evidence/campaign'
node tools/tui-scenario-runner.mjs \
  --binary /tmp/aeltum-lane5/aoa \
  --sdk '/Users/nate/Private Repos/harness-sdk' \
  --scenario tools/tui-scenarios/aeltum-provider-failure.json \
  --out '/Users/nate/Documents/Codex/2026-09-29-aeltum-tui-reference-study/build-lanes/lane-5-evidence/campaign'
```

The runner never invokes a shell for the app. It clears proxy and provider-key
environment variables, supplies an explicit loopback `-base-url` and blank
`-api-key-env`, and clears clipboard utility executables to files in each evidence
directory. This protects the operator's real clipboard. The `clipboardAssert` result
records either redirected utility text or an emitted OSC 52 payload and always marks
`nativeClipboardVerified: false`.

Each run leaves `evidence.json`, exact input steps, timestamped visible-text frames,
screen-state JSON, PNGs, terminal bytes, fixture request/response receipts, the pinned
temporary policy, workspace files, session ledger, and OE receipt files under the
requested output directory. A missing assertion, failed screenshot, nonzero process
exit, or fixture mismatch makes the campaign exit nonzero; results are not adjusted to
pass around missing UI features. The report includes the tested binary hash, repository
heads and worktree summaries, and fixture/scenario hashes.

The broad manifest expects current UI hooks for slash menus, model/effort/settings/tools,
reasoning and detail controls, busy draft handling, cancel settlement, retained history,
copy/export/search/session/resume/fork. Work may therefore fail until the primary has
integrated the corresponding SDK lanes. Keep those failures as evidence; update only the
input sequence when an integrated control has a different declared key flow, never its
acceptance condition.

The provider scripts cover fragmented reasoning, assistant text, tool names and partial
JSON arguments, delayed finalization, a real read and write through OE, continuation with
tool output, multiple turns, a safe missing-file failure, a held stream, disconnect on
cancellation, an HTTP 503, model catalog discovery, and unplanned-request refusal. These
fixtures establish deterministic UI transitions and local OE behavior; they do not prove
real provider streaming.

Use the native checklist for clipboard receipt, text selection, theme colors, font
rendering, and shortcuts whose behavior depends on the terminal emulator. PTY cell
screenshots and OSC 52 bytes are not native-terminal proof.

The additional `aeltum-conversations.json` campaign creates an admitted child,
uses its inherited context without historical tool roles/calls, creates a second
generation, and resumes the exact parent. Run it with the same flags and output
directory above. The matching SDK fixture is `conversation-cycle.json`.

`sessionAssert` checks artifacts strictly beneath the retained session directory;
export assertions belong there, not beneath workspace permissions. Clipboard
assertions wait for asynchronous delivery with a bounded timeout and compare
exact source bytes. The runner explicitly uses `xterm-256color`/truecolor with
`NO_COLOR` unset for cell/color evidence, without changing the application's
normal respect for an operator's terminal preferences.
