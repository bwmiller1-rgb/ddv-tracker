// Builds items.json (gatherable items + where they're found) from the Dreamlight Valley Wiki.
// Run by hand when the game adds items: node scripts/update-items.mjs   (Node 18+, no packages needed)
// Quick check first: node scripts/update-items.mjs --check   (page info only; exit code 10 = wiki pages changed)
// Item data © Dreamlight Valley Wiki contributors, CC BY-NC-SA.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const API = 'https://dreamlightvalleywiki.com/api.php';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const HUBS = ['Ingredients', 'Gems', 'Foraging', 'Fishing', 'Gardening', 'Cooking'];
const KEEP_TYPES = ['Ingredient', 'Foraging', 'Gem', 'Meal'];   // meals carry their recipe instead of a location
const CHECK_ONLY = process.argv.includes('--check');   // only report which pages changed; download no page content
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which realm (DLC) each biome/region belongs to. Add new places here when an expansion comes out.
const REALMS = {
  Main: ['Dreamlight Valley', 'Dreamlight Valley biomes', 'Plaza', 'Peaceful Meadow', 'Dazzle Beach', 'Forest of Valor',
    'Glade of Trust', 'Sunlit Plateau', 'Frosted Heights', 'Forgotten Lands', 'Dream Castle', 'The Lion King Realm',
    'Frozen Realm', 'Moana Realm', 'Moana (Universe)', 'WALL-E (Universe)', 'Toy Story', "Beast's Greenhouse",
    'Vitalys Mine', "Foraging near Scrooge's Store", 'Near houses'],
  Eternity: ['Eternity Isle', "Ancient's Landing", 'The Docks', 'The Courtyard', 'The Overlook', 'The Ruins',
    'Glittering Dunes', 'The Plains', 'The Wastes', 'The Oasis', 'The Borderlands',
    'Wild Tangle', 'The Grasslands', 'The Grove', 'The Promenade', 'The Lagoon'],
  Storybook: ['Storybook Vale', 'Mythopia', 'The Elysian Fields', 'The Fiery Plains', "The Statue's Shadow", 'Mount Olympus',
    'Everafter', 'The Wild Woods', 'Teapot Falls', 'The Fallen Fortress', 'The Beanstalk Marshes', 'The Bind', 'The Library of Lore'],
  Honeyglow: ['Honeyglow Woods', 'Braveheart Grove', 'Drowsybloom Acre', 'Gloommeadow', 'Nectar Apiary'],
  Wishblossom: ['Wishblossom Mountains', 'Pixie Acres', 'Glamour Gulch', 'Wishing Alps'],
  Sea: ['Keepsake Sea', 'The Keepsake Sea', 'Shipwreck Shores', 'Candy Cove', 'Kingdom of Oublié'],
};
const COLLECTION_REALM = { 'Dreamlight Valley': 'Main', 'Eternity Isle': 'Eternity', 'Storybook Vale': 'Storybook',
  'Honeyglow Woods': 'Honeyglow', 'Wishblossom Mountains': 'Wishblossom',
  'Keepsake Sea': 'Sea', 'The Keepsake Sea': 'Sea' };
// Unfinished wiki pages for a new expansion are tagged {{placeholder|update=Version History/Expansion_N}}
const EXPANSION_REALM = { 4: 'Sea' };
const expansionRealm = text => EXPANSION_REALM[(text.match(/placeholder\|update=Version[ _]History\/Expansion[ _](\d+)/i) || [])[1]] || '';
const realmOf = place => Object.keys(REALMS).find(r => REALMS[r].includes(place.replace(/\s*\(max \d+\)$/i, '')));
// [["Main", ["Plaza", "Forgotten Lands"]], ["Eternity", [...]], ["", [notes that aren't places]]]
function groupByRealm(places) {
  const groups = new Map();
  for (const p of places) {
    const r = realmOf(p) || '';
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  const order = [...Object.keys(REALMS), ''];
  return [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

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
    .replace(/\[\[:?Category:[^\]]*\]\]/gi, '')
    .replace(/\{\{[^{}]*iconOnly[^{}]*\}\}/gi, '');  // icon-only templates add nothing
  // {{name|X|...}}, {{inlineIcon|X|...}} -> X ; other templates -> first arg
  for (let k = 0; k < 4; k++)
    t = t.replace(/\{\{\s*([^{}|]+)\|([^{}|]*)(\|[^{}]*)?\}\}/g, (_, n, a) => a.trim())
         .replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
       .replace(/'''?/g, '');
  return [...new Set(t.split(/\n|,/).map(x => x.replace(/\s+/g, ' ').replace(/^[\s•*:-]+|[\s(]+$/g, '').trim())
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

// Revision cache: each page's last revision id and the item parsed from it, so later runs only download
// pages that were edited. Bump PARSER_VERSION when the parsing below changes, to re-read every page once.
const PARSER_VERSION = 2;
const cacheFile = new URL('./wiki-cache.json', import.meta.url);
let cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
if (cache.version !== PARSER_VERSION) cache = { version: PARSER_VERSION, pages: {} };

// Cheap check: page info only (last revision id, no page content), 50 pages per request
const revs = {};   // resolved page title -> last revision id
const list = [...titles];
for (let i = 0; i < list.length; i += 50) {
  const d = await api({ action: 'query', titles: list.slice(i, i + 50).join('|'), prop: 'info', redirects: '1' });
  for (const p of Object.values(d.query.pages || {})) if (p.lastrevid) revs[p.title] = p.lastrevid;
  await sleep(1500);
}
const changed = Object.keys(revs).filter(t => cache.pages[t]?.rev !== revs[t]);
const isNew = t => !cache.pages[t];
// Edits to pages that aren't items (e.g. "Critters") don't need an update on their own, but unfinished
// draft pages (no type yet, or tagged as a placeholder) can turn into items, so those still count
const itemChanges = changed.filter(t => isNew(t) || cache.pages[t].item || cache.pages[t].draft !== false);
console.log(`Item pages new or edited since last update: ${itemChanges.length}`);
if (Object.keys(cache.pages).length) itemChanges.slice(0, 50).forEach(t => console.log(`  ${isNew(t) ? 'new' : 'edited'}: ${t}`));
if (CHECK_ONLY) process.exit(itemChanges.length ? 10 : 0);

// Download and parse only the pages that changed
function parseItem(title, text) {
  const f = infobox(text.replace(/<!--[\s\S]*?-->/g, ''));   // drop commented-out (not yet filled in) fields
  if (!f || !f.type) return null;
  const type = clean(f.type)[0] || '';
  if (!KEEP_TYPES.includes(type)) return null;
  const where = clean(f.found || f.biomes || f.biome || f.location || '');
  const from = clean(f.from || '');
  const realm = COLLECTION_REALM[clean(f.collection || '')[0]] || expansionRealm(text);
  if (type === 'Meal') {
    // {{IngredientList | Apple, Wheat, Butter | addCategories }} -> ["Apple", "Wheat", "Butter"]
    // "*" lines list which items count for a category ingredient like Fruit; keep just the category
    const ingredients = (f.ingredients || '').split('\n').filter(l => !l.trim().startsWith('*')).join('\n');
    return { name: title, type, kind: clean(f.category || '')[0] || '', realm, areas: [], from: [],
      recipe: clean(ingredients), stars: parseInt(f.stars, 10) || 0 };
  }
  const how = from.filter(x => !where.includes(x));
  return {
    name: title,
    type,
    kind: clean(f.ingtype || f.category || f.collectioncategory || '')[0] || '',
    realm,
    // where it's found, grouped by realm; items with no location (shop-only) use their sources instead
    areas: where.length ? groupByRealm(where) : how.length ? [[realm, how]]
      : expansionRealm(text) ? [[realm, ['Location not on the wiki yet']]] : [],
    from: how,
  };
}
for (let i = 0; i < changed.length; i += 40) {
  const d = await api({ action: 'query', titles: changed.slice(i, i + 40).join('|'), prop: 'revisions',
    rvprop: 'content|ids', rvslots: 'main', redirects: '1' });
  for (const p of Object.values(d.query.pages || {})) {
    const rev = p.revisions?.[0];
    const text = rev?.slots?.main?.['*'];
    if (!text) continue;
    const item = parseItem(p.title, text);
    const f = infobox(text.replace(/<!--[\s\S]*?-->/g, ''));
    const draft = !item && (/\{\{\s*placeholder/i.test(text) || (!!f && !clean(f.type || '')[0]));
    cache.pages[p.title] = item ? { rev: rev.revid, item } : { rev: rev.revid, item: null, draft };
  }
  process.stdout.write('.');
  await sleep(1500);
}
// Items from every page still linked from the hub pages
const items = Object.keys(revs).map(t => cache.pages[t]?.item).filter(Boolean)
  // known realm but no location yet (common for brand-new expansion items)
  .map(it => it.areas.length || !it.realm || it.type === 'Meal' ? it : { ...it, areas: [[it.realm, ['Location not on the wiki yet']]] });
items.sort((a, b) => a.name.localeCompare(b.name));
if (items.length < 100) throw new Error(`Only ${items.length} items found — wiki layout may have changed; not overwriting items.json`);

const out = { source: 'Dreamlight Valley Wiki (dreamlightvalleywiki.com), CC BY-NC-SA', count: items.length, items };
const file = new URL('../items.json', import.meta.url);
const before = existsSync(file) ? JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).items) : '';
for (const t of Object.keys(cache.pages)) if (!(t in revs)) delete cache.pages[t];
writeFileSync(cacheFile, JSON.stringify(cache) + '\n');
if (before === JSON.stringify(items)) console.log('\nNo changes.');
else { writeFileSync(file, JSON.stringify(out, null, 1) + '\n'); console.log(`\nWrote ${items.length} items.`); }
