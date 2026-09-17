#!/usr/bin/env tsx
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

type Flags = Record<string, string | boolean>;

function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      out[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ui-motion-capture: provide --${name} <value>`);
  }
  return value;
}

function fromInvocationCwd(value: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? `signal ${signal ?? 'unknown'}`}`));
    });
  });
}

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      const duration = Number.parseFloat(output.trim());
      if (code !== 0 || !Number.isFinite(duration)) {
        reject(new Error(`ffprobe could not read duration for ${file}`));
      } else {
        resolvePromise(duration);
      }
    });
  });
}

async function updateManifest(manifestPath: string, url: string, videoFile: string, frames: string[]): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    items?: Array<Record<string, unknown>>;
  };
  const item = manifest.items?.find((candidate) => candidate.pageUrl === url || candidate.sourceUrl === url);
  if (!item) throw new Error(`No manifest item matched ${url}`);
  delete item.videoFallbackReason;
  item.videoFile = videoFile;
  item.motionFrames = frames;
  item.captureType = 'live website with Playwright video capture';
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const url = required(flags, 'url');
  const outDir = fromInvocationCwd(required(flags, 'out'));
  const slug = required(flags, 'slug');
  const width = Number(flags.width ?? 1280);
  const height = Number(flags.height ?? 720);
  const beatMs = Number(flags['beat-ms'] ?? 2000);
  const dismissCookies = Boolean(flags['dismiss-cookies']);
  const headed = Boolean(flags.headed);
  const rawDir = join(outDir, '.raw-video');
  const framesDir = join(outDir, 'motion-frames');
  await mkdir(rawDir, { recursive: true });
  await mkdir(framesDir, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: rawDir, size: { width, height } },
  });
  const page = await context.newPage();
  const video = page.video();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (dismissCookies) {
      for (const label of [/^deny$/i, /^decline$/i, /^reject$/i, /^essential only$/i]) {
        const roleConsent = page.getByRole('button', { name: label });
        const textConsent = page.getByText(label);
        const consent =
          await roleConsent.count() > 0 && await roleConsent.first().isVisible()
            ? roleConsent.first()
            : textConsent.first();
        if (await consent.count() > 0 && await consent.isVisible()) {
          await consent.click({ timeout: 2_000, force: true });
          await page.waitForTimeout(500);
          break;
        }
      }
    }
    await page.waitForTimeout(2_000);

    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    const maxScroll = Math.max(0, pageHeight - height);
    const positions = [0, Math.round(maxScroll * 0.33), Math.round(maxScroll * 0.66), maxScroll];
    for (const [index, y] of positions.entries()) {
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: 'instant' }), y);
      await page.mouse.move(Math.round(width * (0.35 + index * 0.1)), Math.round(height * 0.42));
      await page.waitForTimeout(beatMs);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(beatMs);
  } finally {
    await context.close();
    await browser.close();
  }

  if (!video) throw new Error('Playwright did not expose a recording handle');
  const rawVideo = await video.path();
  const mp4 = join(outDir, `${slug}.mp4`);
  await run('ffmpeg', ['-y', '-i', rawVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);

  const duration = await probeDuration(mp4);
  const frames: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const frameName = `${slug}-${String(i + 1).padStart(2, '0')}.png`;
    const framePath = join(framesDir, frameName);
    const timestamp = Math.min(Math.max(0, duration - 0.1), duration * ((i + 1) / 5));
    await run('ffmpeg', ['-y', '-ss', timestamp.toFixed(3), '-i', mp4, '-frames:v', '1', framePath]);
    frames.push(relative(outDir, framePath));
  }

  if (typeof flags.manifest === 'string') {
    const manifestPath = fromInvocationCwd(flags.manifest);
    await updateManifest(manifestPath, url, relative(resolve(manifestPath, '..'), mp4), frames.map((frame) => join('motion-frames', frame.split('/').pop() ?? '')));
  }

  if (!flags.keepRaw) await rm(rawVideo, { force: true });
  console.log(JSON.stringify({ url, videoFile: relative(outDir, mp4), motionFrames: frames, durationSeconds: Number(duration.toFixed(2)) }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
