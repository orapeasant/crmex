// Copies the source-of-truth Node payload (nodejs-assets/nodejs-project,
// including its already-`npm install`ed node_modules — deliberately just
// baileys, no native modules, see .npmrc there) into dist/nodejs, which is
// where the actual capacitor-nodejs plugin (nodeDir relative to webDir)
// expects to find it before `npx cap sync android` runs.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const androidRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(androidRoot, 'nodejs-assets', 'nodejs-project');
const dest = path.join(androidRoot, 'dist', 'nodejs');

if (!existsSync(src)) {
  console.error(`[copy-nodejs-payload] source not found: ${src}`);
  process.exit(1);
}
if (!existsSync(path.join(src, 'node_modules'))) {
  console.error(
    `[copy-nodejs-payload] ${src}/node_modules is missing — run "npm install" inside nodejs-assets/nodejs-project first.`,
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-nodejs-payload] copied ${src} -> ${dest}`);
