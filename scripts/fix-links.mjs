#!/usr/bin/env node
// One-time fixup: rewrite absolute wanderinghusky.com / *.wordpress.com links in
// migrated Markdown to local routes (posts -> /blog/<slug>/, pages -> /<slug>/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = { posts: path.join(ROOT, 'src', 'content', 'posts'), pages: path.join(ROOT, 'src', 'content', 'pages') };

const routeOf = new Map(); // wp slug -> local route
for (const [kind, dir] of Object.entries(DIRS)) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const slug = f.replace(/\.md$/, '');
    routeOf.set(slug, kind === 'posts' ? `/blog/${slug}/` : `/${slug}/`);
  }
}

let touched = 0;
for (const dir of Object.values(DIRS)) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const file = path.join(dir, f);
    let md = fs.readFileSync(file, 'utf8');
    const before = md;
    md = md.replace(/https?:\/\/(?:www\.)?(?:wanderinghusky\.com|wanderinghuskycom\.wordpress\.com)(\/[^\s)"']*)?/g, (m, p = '/') => {
      const clean = decodeURIComponent(p).replace(/\/+$/, '');
      const last = clean.split('/').pop();
      if (routeOf.has(last)) return routeOf.get(last);
      return clean === '' ? '/' : clean; // unknown path: keep as root-relative
    });
    if (md !== before) {
      fs.writeFileSync(file, md);
      touched++;
    }
  }
}
console.log(`Rewrote links in ${touched} files`);
