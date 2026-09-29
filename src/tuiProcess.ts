import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';

export interface TuiProcessOptions {
  command: string | string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  pty?: boolean;
}

export function validateTerminalSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 4 || cols > 1000 || rows > 1000) {
    throw new Error('Terminal size must be integer columns 10–1000 and rows 4–1000');
  }
}

// stdin contains only application bytes. FD 3 is a framed control pipe, so resize
// messages cannot be split, coalesced, or confused with pasted application text.
const PTY_PYTHON_BRIDGE = String.raw`
import sys, os, pty, select, struct, termios, fcntl, signal, json, time
rows, cols = int(sys.argv[1]), int(sys.argv[2])
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
pid = os.fork()
if pid == 0:
    os.close(master)
    os.close(3)
    os.login_tty(slave)
    os.execvp(sys.argv[3], sys.argv[3:])
os.close(slave)
for fd in (master, 0, 3):
    os.set_blocking(fd, False)
controls = b''
input_pending = b''
stdin_open = True
control_open = True
master_open = True
exit_status = None
stopping = None

def signal_group(sig):
    try: os.killpg(pid, sig)
    except OSError: pass

def stop(*args):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        signal_group(signal.SIGTERM)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while exit_status is None:
        if stopping is not None and time.monotonic() - stopping > 0.3:
            signal_group(signal.SIGKILL)
        reads = ([master] if master_open else []) + ([0] if stdin_open else []) + ([3] if control_open else [])
        ready, writable, _ = select.select(reads, [master] if master_open and input_pending else [], [], 0.03)
        if 3 in ready:
            part = os.read(3, 65536)
            if not part:
                control_open = False
                stop()
            else:
                controls += part
                while b'\n' in controls:
                    line, controls = controls.split(b'\n', 1)
                    try:
                        message = json.loads(line)
                        if message['type'] == 'resize':
                            r, c = message['rows'], message['cols']
                            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
                            signal_group(signal.SIGWINCH)
                        elif message['type'] == 'stop': stop()
                    except Exception: pass
        if 0 in ready:
            part = os.read(0, 65536)
            if part: input_pending += part
            else:
                stdin_open = False
                stop()
        if master in writable:
            try:
                count = os.write(master, input_pending)
                input_pending = input_pending[count:]
            except BlockingIOError: pass
            except OSError: input_pending = b''
        if master in ready:
            try:
                data = os.read(master, 65536)
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else: master_open = False
            except BlockingIOError: pass
            except OSError: master_open = False
        result = os.waitpid(pid, os.WNOHANG)
        if result != (0, 0): exit_status = result[1]
    if master_open:
        try:
            while True:
                data = os.read(master, 65536)
                if not data: break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
        except OSError: pass
finally:
    signal_group(signal.SIGTERM)
    signal_group(signal.SIGKILL)
    try: os.close(master)
    except OSError: pass
if exit_status is None:
    try: _, exit_status = os.waitpid(pid, 0)
    except OSError: exit_status = 0
code = os.waitstatus_to_exitcode(exit_status) if hasattr(os, 'waitstatus_to_exitcode') else (exit_status >> 8)
sys.exit(code if code >= 0 else 128 - code)
`;

export class TuiProcess extends EventEmitter {
  private child: ChildProcess;
  private usePty: boolean;
  private _exited = false;
  private _exitCode: number | null = null;
  private _stderrText = '';
  private receivedBytes = 0;
  private lastDataTime = Date.now();
  private closed: Promise<void>;

  constructor(options: TuiProcessOptions) {
    super();
    const cols = options.cols ?? 80, rows = options.rows ?? 24;
    validateTerminalSize(cols, rows);
    this.usePty = options.pty !== false;
    const env = { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), ...options.env };
    const command = Array.isArray(options.command)
      ? [...options.command, ...(options.args ?? [])]
      : options.args?.length ? [options.command, ...options.args] : ['/bin/sh', '-c', options.command];
    if (!command.length || !command[0]) throw new Error('A terminal command is required');
    this.child = this.usePty
      ? spawn('python3', ['-u', '-c', PTY_PYTHON_BRIDGE, String(rows), String(cols), ...command], {
          cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        })
      : spawn(command[0], command.slice(1), { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const emitText = (kind: string, text: string) => {
      if (!text) return;
      if (kind === 'error-data') this._stderrText += text;
      this.emit(kind, text);
    };
    const receive = (kind: string, decoder: StringDecoder, bytes: Buffer) => {
      this.receivedBytes += bytes.length;
      this.lastDataTime = Date.now();
      this.emit('raw-data', bytes);
      emitText(kind, decoder.write(bytes));
    };
    this.child.stdout?.on('data', bytes => receive('data', stdoutDecoder, bytes));
    this.child.stderr?.on('data', bytes => receive('error-data', stderrDecoder, bytes));
    this.child.stdout?.on('end', () => emitText('data', stdoutDecoder.end()));
    this.child.stderr?.on('end', () => emitText('error-data', stderrDecoder.end()));
    this.closed = new Promise(resolve => {
      this.child.on('close', (code, signal) => {
        this._exited = true;
        this._exitCode = code ?? (signal ? 128 : 1);
        this.emit('exit', this._exitCode, signal);
        resolve();
      });
    });
    this.child.on('error', error => this.emit('error', error));
  }

  get exited(): boolean { return this._exited; }
  get exitCode(): number | null { return this._exitCode; }
  get stderrText(): string { return this._stderrText; }

  write(data: string | Buffer): void {
    if (this._exited || !this.child.stdin?.writable) return;
    this.child.stdin.write(data);
  }

  private control(message: object): void {
    const pipe = this.child.stdio[3] as Writable | null;
    if (!this._exited && pipe?.writable) pipe.write(JSON.stringify(message) + '\n');
  }

  resize(cols: number, rows: number): void {
    validateTerminalSize(cols, rows);
    if (!this.usePty) throw new Error('Resize requires a PTY');
    this.control({ type: 'resize', cols, rows });
  }

  async waitForOutput(timeoutMs = 600, minWaitMs = 60): Promise<void> {
    const start = Date.now(), initialBytes = this.receivedBytes;
    await new Promise(resolve => setTimeout(resolve, minWaitMs));
    while (Date.now() - start < timeoutMs) {
      if (this._exited) break;
      if (this.receivedBytes > initialBytes && Date.now() - this.lastDataTime >= 80) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._exited) return;
    if (this.usePty && signal === 'SIGTERM') this.control({ type: 'stop' });
    else if (this.usePty) this.child.kill(signal);
    else if (this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch { /* already gone */ }
    }
  }

  async close(): Promise<void> {
    this.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.closed, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.kill('SIGKILL'); resolve(); }, 1500);
    })]);
    if (timer) clearTimeout(timer);
  }
}
