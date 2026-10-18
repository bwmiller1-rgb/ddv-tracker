// Builds items.json (gatherable items + where they're found) from the Dreamlight Valley Wiki.
// Run with: node scripts/update-items.mjs   (Node 18+, no packages needed)
// Item data © Dreamlight Valley Wiki contributors, CC BY-NC-SA.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const API = 'https://dreamlightvalleywiki.com/api.php';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const HUBS = ['Ingredients', 'Gems', 'Foraging', 'Fishing', 'Gardening'];
const KEEP_TYPES = ['Ingredient', 'Foraging', 'Gem'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(params, tries = 4) {
  const url = API + '?' + new URLSearchParams({ format: 'json', ...params });
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const text = await res.text();
      if (text.startsWith('{')) return JSON.parse(text);
    }
    await sleep(5000 * (i + 1));
  }
  throw new Error('Wiki request failed: ' + url);
}

// Turn wiki markup like "{{name|Plaza}}<br>[[Forgotten Lands]]" into ["Plaza", "Forgotten Lands"]
function clean(s) {
  if (!s) return [];
  let t = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\{\{--\}\}/g, ' ')
    .replace(/\{\{!\}\}/g, '|')
    .replace(/\[\[File:[^\]]*\]\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*iconOnly[^{}]*\}\}/gi, '');  // icon-only templates add nothing
  // {{name|X|...}}, {{inlineIcon|X|...}} -> X ; other templates -> first arg
  for (let k = 0; k < 4; k++)
    t = t.replace(/\{\{\s*([^{}|]+)\|([^{}|]*)(\|[^{}]*)?\}\}/g, (_, n, a) => a.trim())
         .replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
       .replace(/'''?/g, '');
  return [...new Set(t.split(/\n|,/).map(x => x.replace(/\s+/g, ' ').replace(/^[\s•*-]+|[\s(]+$/g, '').trim())
    .map(x => x.replace(/\s*\(\d+\)$/, '')).map(x => x.charAt(0).toUpperCase() + x.slice(1))
    .filter(x => x && !/^(none|n\/a|-|or|\d+)$/i.test(x)))];
}

function infobox(wikitext) {
  const start = wikitext.search(/\{\{\s*infobox/i);
  if (start < 0) return null;
  // find the matching closing braces
  let depth = 0, i = start;
  for (; i < wikitext.length; i++) {
    if (wikitext.startsWith('{{', i)) { depth++; i++; }
    else if (wikitext.startsWith('}}', i)) { depth--; i++; if (!depth) break; }
  }
  const body = wikitext.slice(start + 2, i - 1);
  const fields = {};
  let key = null, buf = '', d = 0;
  const flush = () => { if (key) fields[key.trim().toLowerCase()] = buf.trim(); };
  for (let j = 0; j < body.length; j++) {
    const c2 = body.slice(j, j + 2);
    if (c2 === '{{' || c2 === '[[') { d++; buf += c2; j++; continue; }
    if (c2 === '}}' || c2 === ']]') { d--; buf += c2; j++; continue; }
    if (body[j] === '|' && d === 0) {
      flush(); const rest = body.slice(j + 1); const eq = rest.indexOf('=');
      const nl = rest.search(/[|\n]/);
      if (eq >= 0 && (nl < 0 || eq < nl || rest.slice(0, eq).indexOf('|') < 0)) { key = rest.slice(0, eq); buf = ''; j += eq + 1; }
      else { key = null; buf = ''; }
      continue;
    }
    buf += body[j];
  }
  flush();
  return fields;
}

const titles = new Set();
for (const hub of HUBS) {
  const d = await api({ action: 'parse', page: hub, prop: 'links', redirects: '1' });
  d.parse.links.filter(l => l.ns === 0 && l.exists !== undefined).forEach(l => titles.add(l['*']));
  await sleep(1500);
}
console.log('Candidate pages:', titles.size);

const items = [];
const list = [...titles];
for (let i = 0; i < list.length; i += 40) {
  const d = await api({ action: 'query', titles: list.slice(i, i + 40).join('|'), prop: 'revisions',
    rvprop: 'content', rvslots: 'main', redirects: '1' });
  for (const p of Object.values(d.query.pages || {})) {
    const text = p.revisions?.[0]?.slots?.main?.['*'];
    if (!text) continue;
    const f = infobox(text);
    if (!f || !f.type) continue;
    const type = clean(f.type)[0] || '';
    if (!KEEP_TYPES.includes(type)) continue;
    const where = clean(f.found || f.biomes || f.biome || f.location || '');
    const from = clean(f.from || '');
    items.push({
      name: p.title,
      type,
      kind: clean(f.ingtype || f.category || f.collectioncategory || '')[0] || '',
      realm: clean(f.collection || '')[0] || '',
      where,
      from: from.filter(x => !where.includes(x)),
    });
  }
  process.stdout.write('.');
  await sleep(1500);
}
items.sort((a, b) => a.name.localeCompare(b.name));
if (items.length < 100) throw new Error(`Only ${items.length} items found — wiki layout may have changed; not overwriting items.json`);

const out = { source: 'Dreamlight Valley Wiki (dreamlightvalleywiki.com), CC BY-NC-SA', count: items.length, items };
const file = new URL('../items.json', import.meta.url);
const before = existsSync(file) ? JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).items) : '';
if (before === JSON.stringify(items)) console.log('\nNo changes.');
else { writeFileSync(file, JSON.stringify(out, null, 1) + '\n'); console.log(`\nWrote ${items.length} items.`); }
