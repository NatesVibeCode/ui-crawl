import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

export async function serveStatic(targetPath: string): Promise<StaticServer> {
  const abs = path.resolve(process.cwd(), targetPath);
  const isFile = existsSync(abs) && statSync(abs).isFile();
  const rootDir = isFile ? path.dirname(abs) : abs;
  const defaultFile = isFile ? path.basename(abs) : 'index.html';

  const server = createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url?.split('?')[0] || '/');
    if (reqPath === '/' || reqPath === '') reqPath = '/' + defaultFile;
    const filePath = path.join(rootDir, reqPath);

    // Guard against directory traversal
    if (!filePath.startsWith(rootDir)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      let resolved = filePath;
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, 'index.html');
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const ext = path.extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      createReadStream(resolved).pipe(res);
    } catch {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
