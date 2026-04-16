import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const sourceDir = join(rootDir, 'node_modules', 'syntaur', 'dashboard', 'dist');
const targetDir = join(
  rootDir,
  'node_modules',
  'syntaur',
  'dist',
  'dashboard',
  'dist',
);

if (!existsSync(sourceDir)) {
  console.warn(
    `[sync:syntaur-dashboard] Skipping: source directory not found at ${sourceDir}`,
  );
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true, force: true });

console.log(
  '[sync:syntaur-dashboard] Mirrored syntaur dashboard assets into dist/dashboard/dist',
);
