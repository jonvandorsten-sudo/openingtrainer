// Builds the app and publishes it to the gh-pages branch, which GitHub Pages serves.
// Usage: npm run deploy:pages
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const OUT = join(ROOT, 'dist', 'chess-opening-trainer', 'browser');
const run = (command, cwd = ROOT) => execSync(command, { cwd, stdio: 'inherit' });

const remote = execSync('git remote get-url origin', { cwd: ROOT }).toString().trim();
const source = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();

run('npm run build:pages');
writeFileSync(join(OUT, '.nojekyll'), '');
rmSync(join(OUT, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', OUT);
run('git add -A', OUT);
run(`git -c user.name="${execSync('git config user.name', { cwd: ROOT }).toString().trim()}" -c user.email="${execSync('git config user.email', { cwd: ROOT }).toString().trim()}" commit -q -m "Build of ${source}"`, OUT);
run(`git push -q --force ${remote} gh-pages`, OUT);
rmSync(join(OUT, '.git'), { recursive: true, force: true });
console.log('Published', source, 'to gh-pages');
