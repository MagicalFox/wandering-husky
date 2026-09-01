#!/usr/bin/env node
// Migrate wanderinghusky.com (WordPress.com) content to Markdown + local images.
// - Originals live ONLY in ~/Documents/Adobe (single source of truth).
// - Images missing locally are downloaded from the live site INTO the matching
//   Adobe subfolder (Alaska shots -> Alaska/; others -> new aptly-named folder).
// - Web-optimized .webp derivatives are generated into public/images/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import TurndownService from 'turndown';

const API = 'https://public-api.wordpress.com/wp/v2/sites/wanderinghuskycom.wordpress.com';
const ADOBE = path.join(os.homedir(), 'Documents', 'Adobe');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_IMG = path.join(ROOT, 'public', 'images');
const OUT_POSTS = path.join(ROOT, 'src', 'content', 'posts');
const OUT_PAGES = path.join(ROOT, 'src', 'content', 'pages');
const IMG_EXT = /\.(jpe?g|png)$/i;
const DERIV_WIDTH = 2000;
const DERIV_QUALITY = 80;

const manifest = [];
const adobeIndex = new Map(); // normalized basename -> [absolute paths]
const derivMap = new Map(); // source abs path -> /images/<file>.webp
const usedDerivNames = new Map(); // deriv filename -> source abs path (collision check)
const downloadLog = []; // images saved into Adobe
const missLog = [];

// ---------- helpers ----------
function normalizeName(filename) {
  return filename
    .toLowerCase()
    .replace(/^_+/, '')
    .replace(/-(?:scaled|e\d+|\d+x\d+)(?=\.[a-z]+$)/, '');
}

function indexAdobe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['dynamiclinkmediaserver', 'amecommand', 'Photoshop Cloud Associates'].includes(entry.name)) continue;
      indexAdobe(full);
    } else if (IMG_EXT.test(entry.name)) {
      const key = normalizeName(entry.name);
      if (!adobeIndex.has(key)) adobeIndex.set(key, []);
      adobeIndex.get(key).push(full);
    }
  }
}

// try exact, then progressively strip trailing -N duplicate suffixes
function findLocal(siteBasename) {
  let key = normalizeName(siteBasename);
  for (let i = 0; i < 4; i++) {
    if (adobeIndex.has(key)) return { key, paths: adobeIndex.get(key) };
    if (!/-\d+\.[a-z]+$/.test(key)) break;
    key = key.replace(/-\d+(\.[a-z]+)$/, '$1');
  }
  return null;
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#8216': '‘', '#8217': '’', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', '#8230': '…', '#038': '&', '#039': "'" };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (named[e] !== undefined) return named[e];
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}

function yamlEscape(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// pick best local file when several share a name: prefer folder sharing a token with the slug
function pickBest(pathsTo, slug) {
  if (pathsTo.length === 1) return pathsTo[0];
  const tokens = slug.split('-').filter(t => t.length > 3);
  for (const p of pathsTo) {
    const dir = path.basename(path.dirname(p)).toLowerCase();
    if (tokens.some(t => dir.includes(t))) return p;
  }
  return pathsTo[0];
}

function targetFolder(slug, title) {
  if (/alaska/.test(slug)) return path.join(ADOBE, 'Alaska');
  if (/bear-story/.test(slug)) return path.join(ADOBE, 'bear story');
  // new aptly-named folder based on the page/post title
  const clean = decodeEntities(title).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return path.join(ADOBE, clean || 'wandering-husky-misc');
}

async function downloadInto(url, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = decodeURIComponent(url.split('/').pop().split('?')[0]);
  const dest = path.join(destDir, base);
  if (!fs.existsSync(dest)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  const key = normalizeName(base);
  if (!adobeIndex.has(key)) adobeIndex.set(key, []);
  if (!adobeIndex.get(key).includes(dest)) adobeIndex.get(key).push(dest);
  return dest;
}

async function makeDerivative(srcAbs) {
  if (derivMap.has(srcAbs)) return derivMap.get(srcAbs);
  const normBase = normalizeName(path.basename(srcAbs)).replace(/\.[a-z]+$/, '');
  let name = `${normBase}.webp`;
  let i = 2;
  while (usedDerivNames.has(name) && usedDerivNames.get(name) !== srcAbs) name = `${normBase}-${i++}.webp`;
  usedDerivNames.set(name, srcAbs);
  const out = path.join(OUT_IMG, name);
  if (!fs.existsSync(out)) {
    await sharp(srcAbs)
      .rotate() // honor EXIF orientation
      .resize({ width: DERIV_WIDTH, withoutEnlargement: true })
      .webp({ quality: DERIV_QUALITY })
      .toFile(out);
  }
  const url = `/images/${name}`;
  derivMap.set(srcAbs, url);
  return url;
}

function extractImageUrls(html) {
  const urls = new Map(); // normalized basename -> best original URL
  const add = (u) => {
    if (!u || !/^https?:\/\//.test(u)) return;
    const clean = decodeEntities(u).replace(/[?#].*$/, '');
    if (!IMG_EXT.test(clean)) return;
    if (!/uploads\//.test(clean)) return;
    const key = normalizeName(decodeURIComponent(clean.split('/').pop()));
    if (!urls.has(key)) urls.set(key, clean);
  };
  for (const m of html.matchAll(/data-orig-file="([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/g)) add(m[1]);
  return urls;
}

// ---------- main ----------
console.log('Indexing ~/Documents/Adobe ...');
indexAdobe(ADOBE);
console.log(`  ${[...adobeIndex.values()].reduce((n, a) => n + a.length, 0)} image files indexed`);

async function fetchAll(restBase) {
  let page = 1, all = [];
  for (;;) {
    const res = await fetch(`${API}/${restBase}?per_page=100&page=${page}`);
    if (!res.ok) break;
    const items = await res.json();
    all = all.concat(items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

const posts = await fetchAll('posts');
const pages = await fetchAll('pages');
const portfolio = await fetchAll('jetpack-portfolio');
console.log(`Fetched: ${posts.length} posts, ${pages.length} pages, ${portfolio.length} portfolio items`);

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.addRule('images', {
  filter: 'img',
  replacement: (content, node) => {
    const src = node.getAttribute('data-local-src') || node.getAttribute('src') || '';
    const alt = node.getAttribute('alt') || '';
    return src ? `\n\n![${alt}](${src})\n\n` : '';
  },
});
turndown.remove(['script', 'style', 'form']);

async function processItem(item, type) {
  const slug = decodeURIComponent(item.slug);
  const title = decodeEntities(item.title.rendered).trim();
  const date = item.date.slice(0, 10);
  let html = item.content.rendered;

  const imageUrls = extractImageUrls(html);
  const record = { type, slug, title, date, images: [] };

  // resolve every image: local Adobe original (download into Adobe if missing) -> webp derivative
  const replacements = new Map(); // original URL (no query) -> derivative web path
  for (const [key, url] of imageUrls) {
    const base = decodeURIComponent(url.split('/').pop());
    let local = findLocal(base);
    let status = 'local';
    if (!local) {
      try {
        const dest = await downloadInto(url, targetFolder(slug, title));
        downloadLog.push({ slug, url, savedTo: dest });
        local = { key: normalizeName(base), paths: [dest] };
        status = 'downloaded-to-adobe';
      } catch (e) {
        missLog.push({ slug, url, error: String(e) });
        record.images.push({ url, status: 'MISSING', error: String(e) });
        continue;
      }
    }
    const srcAbs = pickBest(local.paths, slug);
    try {
      const web = await makeDerivative(srcAbs);
      replacements.set(url, web);
      record.images.push({ url, adobe: srcAbs, web, status });
    } catch (e) {
      missLog.push({ slug, url, error: `sharp: ${e}` });
      record.images.push({ url, adobe: srcAbs, status: 'DERIV-FAILED', error: String(e) });
    }
  }

  // rewrite <img> tags to the local derivative before Markdown conversion
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    const attr = (name) => { const m = tag.match(new RegExp(name + '="([^"]*)"')); return m ? decodeEntities(m[1]) : ''; };
    const orig = (attr('data-orig-file') || attr('src')).replace(/[?#].*$/, '');
    const web = replacements.get(orig) || replacements.get(attr('src').replace(/[?#].*$/, ''));
    if (!web) return '';
    const alt = attr('alt').replace(/"/g, '&quot;');
    return `<img data-local-src="${web}" src="${web}" alt="${alt}">`;
  });
  // unwrap links that point directly at images so they don't wrap the <img>
  html = html.replace(/<a\b[^>]*href="[^"]*\.(?:jpe?g|png)[^"]*"[^>]*>(\s*)<img/gi, '$1<img');

  let md = turndown.turndown(html);
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  const hero = record.images.find(i => i.web)?.web || '';
  const frontmatter = [
    '---',
    `title: ${yamlEscape(title || slug)}`,
    `date: ${yamlEscape(date)}`,
    `slug: ${yamlEscape(slug)}`,
    `type: ${type}`,
    hero ? `hero: ${yamlEscape(hero)}` : null,
    '---',
  ].filter(Boolean).join('\n');

  const outDir = type === 'post' ? OUT_POSTS : OUT_PAGES;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${slug}.md`);
  fs.writeFileSync(file, `${frontmatter}\n\n${md}\n`);
  record.file = path.relative(ROOT, file);
  manifest.push(record);
  console.log(`  [${type}] ${slug}  (${record.images.length} images)`);
}

for (const item of pages) await processItem(item, 'page');
for (const item of posts) await processItem(item, 'post');
for (const item of portfolio) await processItem(item, 'portfolio');

fs.writeFileSync(path.join(ROOT, 'migration-manifest.json'), JSON.stringify({ items: manifest, downloadsIntoAdobe: downloadLog, missing: missLog }, null, 2));
console.log(`\nDone. ${manifest.length} items, ${derivMap.size} unique derivatives.`);
console.log(`Downloaded into Adobe: ${downloadLog.length}; missing/failed: ${missLog.length}`);
if (downloadLog.length) console.table(downloadLog.map(d => ({ slug: d.slug, savedTo: d.savedTo.replace(ADOBE, '~/Adobe') })));
if (missLog.length) console.log(JSON.stringify(missLog, null, 2));
