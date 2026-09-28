import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A named artifact to persist (`findings.json`, `payload.json`, `guidance/robots.txt`, ...). */
export interface ReportArtifact {
  name: string;
  content: string | Uint8Array;
}

/**
 * Where a crawl's report artifacts go. Default is the filesystem. An injected sink can
 * forward elsewhere — filing defects into a tracker, say — without the core knowing.
 */
export interface ReportSink {
  write(args: { outDir: string; artifacts: ReportArtifact[] }): Promise<string>;
}

export class FilesystemSink implements ReportSink {
  async write({ outDir, artifacts }: { outDir: string; artifacts: ReportArtifact[] }): Promise<string> {
    await mkdir(outDir, { recursive: true });
    for (const a of artifacts) {
      const full = path.join(outDir, a.name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, a.content);
    }
    return outDir;
  }
}
