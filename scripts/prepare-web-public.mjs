import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'assets', 'favicon.png');
const destDir = join(root, 'public');
const dest = join(destDir, 'favicon.png');

if (!existsSync(src)) {
  console.error('prepare-web-public: fant ikke', src);
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
