import { google } from 'googleapis';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';
const SHOP = String(process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

function req(name, value) {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

async function token() {
  req('SHOPIFY_STORE_DOMAIN', SHOP);
  req('SHOPIFY_CLIENT_ID', CLIENT_ID);
  req('SHOPIFY_CLIENT_SECRET', CLIENT_SECRET);
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) throw new Error(`Shopify token request failed (${r.status}): ${JSON.stringify(b)}`);
  return b.access_token;
}

function sheets() {
  req('GOOGLE_SPREADSHEET_ID', SPREADSHEET_ID);
  const raw = req('GOOGLE_SERVICE_ACCOUNT_JSON', process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return google.sheets({ version: 'v4', auth });
}

async function gql(accessToken, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables })
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}: ${JSON.stringify(b)}`);
  if (b.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(b.errors)}`);
  return b.data;
}

const Q = `query InventoryItemsAtLocation($ids: [ID!]!, $locationId: ID!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
      sku
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available", "committed", "reserved", "on_hand"]) { name quantity }
      }
    }
  }
}`;

function qmap(level) {
  const out = { available: 0, committed: 0, reserved: 0, on_hand: 0 };
  for (const q of level?.quantities || []) out[q.name] = Number(q.quantity || 0);
  return out;
}

async function main() {
  console.log('DRY_RUN_START read-only; no Shopify or Sheet writes');
  const accessToken = await token();
  console.log('DRY_RUN_AUTH Shopify token OK');
  const s = sheets();
  const r = await s.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'SHOPIFY SYNC'!A2:T100", valueRenderOption: 'FORMATTED_VALUE' });
  const rows = r.data.values || [];
  console.log(`DRY_RUN_AUTH Google Sheets OK; rows=${rows.length}`);

  const mappings = rows.map((row, index) => ({
    rowNumber: index + 2,
    enabled: String(row[0] || '').trim() === 'Yes',
    sku: String(row[1] || '').trim(),
    physicalShelf: num(row[3]),
    inventoryItemId: String(row[6] || '').trim(),
    locationId: String(row[8] || '').trim(),
    otherReserved: num(row[13])
  })).filter(x => x.enabled && x.sku && x.inventoryItemId && x.locationId);

  const groups = new Map();
  for (const m of mappings) {
    if (!groups.has(m.locationId)) groups.set(m.locationId, []);
    groups.get(m.locationId).push(m);
  }

  const detail = [];
  for (const [locationId, items] of groups) {
    const data = await gql(accessToken, Q, { ids: items.map(x => x.inventoryItemId), locationId });
    const byId = new Map((data.nodes || []).filter(Boolean).map(n => [n.id, n]));
    for (const m of items) {
      const node = byId.get(m.inventoryItemId);
      if (!node?.inventoryLevel) {
        detail.push({ sku: m.sku, error: 'NO_ACTIVE_INVENTORY_LEVEL' });
        continue;
      }
      const q = qmap(node.inventoryLevel);
      const target = Math.max(Math.trunc(m.physicalShelf - q.committed - q.reserved - m.otherReserved), 0);
      detail.push({ sku: m.sku, shelf: m.physicalShelf, available: q.available, committed: q.committed, reserved: q.reserved, otherReserved: m.otherReserved, target, diff: target - q.available });
    }
  }

  const errors = detail.filter(x => x.error);
  const mismatches = detail.filter(x => !x.error && x.diff !== 0);
  console.log(`DRY_RUN_RESULT checked=${detail.length} mappings=${mappings.length} mismatches=${mismatches.length} errors=${errors.length}`);
  for (const x of mismatches) console.log(`DRY_RUN_MISMATCH ${x.sku} available=${x.available} target=${x.target} diff=${x.diff}`);
  for (const x of errors) console.log(`DRY_RUN_ERROR ${x.sku} ${x.error}`);
  if (detail.length !== 36) console.log(`DRY_RUN_WARNING expected_36_checked_actual=${detail.length}`);
  console.log('DRY_RUN_DONE');
}

main().catch(err => {
  console.error('DRY_RUN_FATAL', err?.stack || err);
  process.exit(1);
});
