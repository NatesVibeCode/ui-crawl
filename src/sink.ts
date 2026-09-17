import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A named text/binary artifact to persist (gallery.html, findings.json, ...). */
export interface ReportArtifact {
  name: string;
  content: string | Uint8Array;
}

/**
 * Where a crawl's report artifacts go. Default is the filesystem. An injected sink could
 * forward elsewhere (e.g. a post-crawl reader that files defects) WITHOUT the core knowing.
 */
export interface ReportSink {
  write(args: { outDir: string; artifacts: ReportArtifact[] }): Promise<string>;
}

export class FilesystemSink implements ReportSink {
  async write({ outDir, artifacts }: { outDir: string; artifacts: ReportArtifact[] }): Promise<string> {
    await mkdir(outDir, { recursive: true });
    let primary = outDir;
    for (const a of artifacts) {
      const full = path.join(outDir, a.name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, a.content);
      if (a.name === 'gallery.html') primary = full;
    }
    return primary;
  }
}
