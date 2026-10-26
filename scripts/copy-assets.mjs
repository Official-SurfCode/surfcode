import { chmod, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist', 'data');
await mkdir(out, { recursive: true });
await copyFile(resolve(root, 'src', 'data', 'models.json'), resolve(out, 'models.json'));
if (process.platform !== 'win32') {
  await chmod(resolve(root, 'dist', 'cli.js'), 0o755);
}
console.log('copied model catalog');
