import express from 'express';
import crypto from 'crypto';
import { google } from 'googleapis';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const SHOPIFY_WEBHOOK_HMAC_SECRET = process.env.SHOPIFY_WEBHOOK_HMAC_SECRET || '';
const SHOPIFY_STORE_DOMAIN = String(process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const ENABLE_SHOPIFY_INVENTORY_SYNC = String(process.env.ENABLE_SHOPIFY_INVENTORY_SYNC || '').toLowerCase() === 'true';
const SYNC_INTERVAL_MS = Math.max(60000, Number(process.env.SYNC_INTERVAL_MS || 60000));

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); }
}));

let sheetsClient;
let reconcileRunning = false;

function googleConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY));
}

function shopifyApiConfigured() {
  return Boolean(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_ACCESS_TOKEN);
}

function getSheets() {
  if (sheetsClient) return sheetsClient;
  if (!SPREADSHEET_ID) throw new Error('GOOGLE_SPREADSHEET_ID is not configured');

  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  } else {
    throw new Error('Google service-account credentials are not configured');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyWebhook(req) {
  if (SHOPIFY_WEBHOOK_HMAC_SECRET) {
    const header = req.get('x-shopify-hmac-sha256') || '';
    const digest = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_HMAC_SECRET)
      .update(req.rawBody || Buffer.from(''))
      .digest('base64');
    return timingSafeEqualText(header, digest);
  }
  return Boolean(WEBHOOK_TOKEN) && timingSafeEqualText(req.query.token, WEBHOOK_TOKEN);
}

function verifyAdminRequest(req) {
  return Boolean(WEBHOOK_TOKEN) && timingSafeEqualText(req.query.token, WEBHOOK_TOKEN);
}

async function getValues(range) {
  const r = await getSheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  return r.data.values || [];
}

async function updateValues(data) {
  await getSheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data
    }
  });
}

async function appendValues(range, values) {
  await getSheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

function parseNumber(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const mmddyyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (mmddyyyy) return new Date(Date.UTC(Number(mmddyyyy[3]), Number(mmddyyyy[1]) - 1, Number(mmddyyyy[2])));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mmddyyyy(value) {
  const d = parseDateLike(value);
  if (!d) return '';
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${m}/${day}/${d.getUTCFullYear()}`;
}

function yyyymmdd(value) {
  const d = parseDateLike(value);
  if (!d) return '';
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${m}${day}`;
}

function todayPacificDate() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit', day: '2-digit', year: 'numeric'
  }).format(new Date());
}

function nowPacific() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).format(new Date());
}

async function nextEmptyRow(sheetName, column = 'A', maxRow = 1000) {
  const values = await getValues(`'${sheetName}'!${column}2:${column}${maxRow}`);
  for (let i = 0; i < maxRow - 1; i++) {
    if (!values[i] || !String(values[i][0] ?? '').trim()) return i + 2;
  }
  throw new Error(`${sheetName} has no empty rows before ${maxRow}`);
}

async function getErpSkuForVariant(variantId, fallbackSku) {
  const rows = await getValues("'SHOPIFY SYNC'!B2:F37");
  const variantGid = variantId ? `gid://shopify/ProductVariant/${variantId}` : '';
  for (const row of rows) {
    const erpSku = String(row[0] || '').trim();
    const mappedVariant = String(row[4] || '').trim();
    if (erpSku && variantGid && mappedVariant === variantGid) return erpSku;
  }
  if (fallbackSku) {
    const normalized = String(fallbackSku).trim();
    for (const row of rows) if (String(row[0] || '').trim() === normalized) return normalized;
  }
  return '';
}

async function getProductShelf(sku) {
  const rows = await getValues("'Product Master'!C2:G100");
  for (const row of rows) {
    if (String(row[0] || '').trim() === sku) return parseNumber(row[4]);
  }
  throw new Error(`SKU ${sku} not found in Product Master`);
}

async function getFefoLots(sku) {
  const rows = await getValues("'EXPIRY INVENTORY'!A2:I1000");
  return rows
    .filter(row => String(row[0] || '').trim() === sku && parseNumber(row[8]) > 0)
    .map(row => ({
      sku,
      expiry: mmddyyyy(row[2]),
      shelfRemaining: parseNumber(row[8])
    }))
    .filter(x => x.expiry)
    .sort((a, b) => parseDateLike(a.expiry) - parseDateLike(b.expiry));
}

function allocateFefo(lots, qty) {
  let remaining = qty;
  const allocations = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.shelfRemaining);
    if (take > 0) allocations.push({ ...lot, qty: take });
    remaining -= take;
  }
  if (remaining > 0) throw new Error(`Insufficient FEFO Shelf stock: short ${remaining}`);
  return allocations;
}

async function queueAlreadyHas(baseEventKey) {
  const rows = await getValues("'SHOPIFY FULFILLMENT QUEUE'!I2:I1000");
  return rows.some(r => String(r[0] || '') === baseEventKey);
}

async function appendQueue({ orderRef, orderGid, fulfillmentGid, lineItemGid, sku, qty, createdAt, source }) {
  const row = await nextEmptyRow('SHOPIFY FULFILLMENT QUEUE', 'A', 1000);
  await updateValues([
    { range: `'SHOPIFY FULFILLMENT QUEUE'!A${row}:H${row}`, values: [[new Date().toISOString(), orderRef, orderGid, fulfillmentGid, lineItemGid, sku, qty, createdAt || new Date().toISOString()]] },
    { range: `'SHOPIFY FULFILLMENT QUEUE'!P${row}:P${row}`, values: [[source]] }
  ]);
  return row;
}

function shipmentReviewKey({ shipDate, orderRef, sku, qty, expiry, eventKey }) {
  return `${yyyymmdd(shipDate)}|Shopify|${orderRef}|${sku}|Q${qty}|${yyyymmdd(expiry)}|${eventKey}`;
}

async function appendShipmentSegments({ orderRef, orderGid, fulfillmentGid, lineItemGid, sku, qty, shipDate, source }) {
  const shelfBeforeTotal = await getProductShelf(sku);
  if (shelfBeforeTotal < qty) throw new Error(`Shelf stock ${shelfBeforeTotal} is below fulfillment qty ${qty} for ${sku}`);

  const allocations = allocateFefo(await getFefoLots(sku), qty);
  const firstRow = await nextEmptyRow('Channel Shipments', 'A', 1000);
  let runningShelf = shelfBeforeTotal;
  const baseEventKey = `${fulfillmentGid}|${lineItemGid}`;
  const writes = [];

  allocations.forEach((a, index) => {
    const row = firstRow + index;
    const segmentEventKey = `${baseEventKey}|S${String(index + 1).padStart(2, '0')}`;
    const shelfBefore = runningShelf;
    const shelfAfter = shelfBefore - a.qty;
    runningShelf = shelfAfter;
    const reviewKey = shipmentReviewKey({ shipDate, orderRef, sku, qty: a.qty, expiry: a.expiry, eventKey: segmentEventKey });

    writes.push(
      { range: `'Channel Shipments'!A${row}:D${row}`, values: [[shipDate, 'Shopify', orderRef, sku]] },
      { range: `'Channel Shipments'!F${row}:K${row}`, values: [[a.qty, a.expiry, a.shelfRemaining, a.expiry, shelfBefore, shelfAfter]] },
      { range: `'Channel Shipments'!N${row}:P${row}`, values: [['Shopify Auto', shipDate, 'Yes']] },
      { range: `'Channel Shipments'!R${row}:W${row}`, values: [[reviewKey, orderGid, fulfillmentGid, lineItemGid, segmentEventKey, source]] }
    );
  });

  await updateValues(writes);
  return allocations.length;
}

async function processFulfillment(payload) {
  if (!payload?.id || !payload?.order_id) throw new Error('Webhook missing fulfillment id/order_id');
  const fulfillmentGid = `gid://shopify/Fulfillment/${payload.id}`;
  const orderGid = `gid://shopify/Order/${payload.order_id}`;
  const orderRef = payload.name || `Order ${payload.order_id}`;
  const shipDate = mmddyyyy(payload.created_at || payload.updated_at || todayPacificDate());
  const source = 'Shopify Webhook';
  const results = [];

  for (const item of payload.line_items || []) {
    const lineItemId = item.id;
    const qty = parseNumber(item.quantity);
    if (!lineItemId || qty <= 0) continue;

    const lineItemGid = `gid://shopify/LineItem/${lineItemId}`;
    const baseEventKey = `${fulfillmentGid}|${lineItemGid}`;
    if (await queueAlreadyHas(baseEventKey)) {
      results.push({ baseEventKey, status: 'duplicate_ignored' });
      continue;
    }

    const sku = await getErpSkuForVariant(item.variant_id, item.sku);
    if (!sku) throw new Error(`No ERP SKU mapping for Shopify line item ${lineItemId}`);

    const queueRow = await appendQueue({
      orderRef, orderGid, fulfillmentGid, lineItemGid, sku, qty,
      createdAt: payload.created_at || new Date().toISOString(), source
    });

    try {
      const segments = await appendShipmentSegments({
        orderRef, orderGid, fulfillmentGid, lineItemGid, sku, qty, shipDate, source
      });
      results.push({ baseEventKey, sku, qty, queueRow, segments, status: 'posted' });
    } catch (err) {
      await updateValues([{ range: `'SHOPIFY FULFILLMENT QUEUE'!N${queueRow}:N${queueRow}`, values: [[String(err.message || err)]] }]);
      throw err;
    }
  }
  return results;
}

async function shopifyGraphQL(query, variables = {}) {
  if (!shopifyApiConfigured()) throw new Error('Shopify Admin API credentials are not configured');
  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify Admin API HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (body.errors?.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data;
}

const INVENTORY_READ_QUERY = `
query InventoryItemsAtLocation($ids: [ID!]!, $locationId: ID!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
      sku
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available", "committed", "reserved", "on_hand"]) {
          name
          quantity
        }
      }
    }
  }
}`;

const INVENTORY_SET_MUTATION = `
mutation SetInventoryAvailable($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup {
      reason
      changes { name delta }
    }
    userErrors { field message code }
  }
}`;

function quantityMap(level) {
  const out = { available: 0, committed: 0, reserved: 0, on_hand: 0 };
  for (const q of level?.quantities || []) out[q.name] = Number(q.quantity || 0);
  return out;
}

async function appendSyncLog({ sku, eventKey = '', inventoryItemId, locationId, oldAvailable, targetAvailable, newAvailable, result, reason, reference = '' }) {
  await appendValues("'SHOPIFY SYNC LOG'!A:L", [[
    new Date().toISOString(), 'Sheet → Shopify', sku, eventKey, inventoryItemId, locationId,
    oldAvailable, targetAvailable, newAvailable, result, reason, reference
  ]]);
}

async function setShopifyAvailable({ sku, inventoryItemId, locationId, currentAvailable, targetAvailable }) {
  const input = {
    reason: 'correction',
    name: 'available',
    referenceDocumentUri: `gid://purebble-erp/InventorySync/${Date.now()}-${encodeURIComponent(sku)}`,
    quantities: [{
      inventoryItemId,
      locationId,
      quantity: targetAvailable,
      changeFromQuantity: currentAvailable
    }]
  };
  const data = await shopifyGraphQL(INVENTORY_SET_MUTATION, { input });
  const result = data.inventorySetQuantities;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map(e => `${e.code || 'ERROR'}: ${e.message}`).join('; '));
  }
  return targetAvailable;
}

async function reconcileInventory({ allowWrites = false, source = 'Scheduled Reconcile' } = {}) {
  if (reconcileRunning) return { skipped: true, reason: 'reconcile already running' };
  reconcileRunning = true;
  try {
    if (!googleConfigured()) throw new Error('Google service-account credentials are not configured');
    if (!shopifyApiConfigured()) throw new Error('Shopify Admin API credentials are not configured');

    const rows = await getValues("'SHOPIFY SYNC'!A2:T100");
    const mappings = rows.map((row, index) => ({
      rowNumber: index + 2,
      enabled: String(row[0] || '').trim() === 'Yes',
      sku: String(row[1] || '').trim(),
      physicalShelf: parseNumber(row[3]),
      inventoryItemId: String(row[6] || '').trim(),
      locationId: String(row[8] || '').trim(),
      otherReserved: parseNumber(row[13])
    })).filter(x => x.enabled && x.sku && x.inventoryItemId && x.locationId);

    const groups = new Map();
    for (const m of mappings) {
      if (!groups.has(m.locationId)) groups.set(m.locationId, []);
      groups.get(m.locationId).push(m);
    }

    const summary = { checked: 0, mismatches: 0, writes: 0, errors: [] };
    const sheetWrites = [];

    for (const [locationId, items] of groups.entries()) {
      const data = await shopifyGraphQL(INVENTORY_READ_QUERY, {
        ids: items.map(x => x.inventoryItemId),
        locationId
      });
      const byId = new Map((data.nodes || []).filter(Boolean).map(node => [node.id, node]));

      for (const m of items) {
        summary.checked += 1;
        const node = byId.get(m.inventoryItemId);
        if (!node?.inventoryLevel) {
          const msg = `No active inventory level at mapped location for ${m.sku}`;
          summary.errors.push(msg);
          sheetWrites.push({ range: `'SHOPIFY SYNC'!S${m.rowNumber}:T${m.rowNumber}`, values: [[nowPacific(), msg]] });
          continue;
        }

        const q = quantityMap(node.inventoryLevel);
        const target = Math.max(Math.trunc(m.physicalShelf - q.committed - q.reserved - m.otherReserved), 0);
        const diff = target - q.available;
        if (diff !== 0) summary.mismatches += 1;

        let newAvailable = q.available;
        let note = diff === 0 ? 'IN SYNC — fresh read' : `PENDING PUSH ${q.available} → ${target}`;

        if (diff !== 0 && allowWrites) {
          try {
            newAvailable = await setShopifyAvailable({
              sku: m.sku,
              inventoryItemId: m.inventoryItemId,
              locationId,
              currentAvailable: q.available,
              targetAvailable: target
            });
            summary.writes += 1;
            note = `SYNCED ${q.available} → ${target}`;
            await appendSyncLog({
              sku: m.sku,
              inventoryItemId: m.inventoryItemId,
              locationId,
              oldAvailable: q.available,
              targetAvailable: target,
              newAvailable,
              result: 'SUCCESS',
              reason: source,
              reference: 'Railway auto reconcile'
            });
          } catch (err) {
            const msg = String(err.message || err);
            summary.errors.push(`${m.sku}: ${msg}`);
            note = `BLOCKED: ${msg}`;
            await appendSyncLog({
              sku: m.sku,
              inventoryItemId: m.inventoryItemId,
              locationId,
              oldAvailable: q.available,
              targetAvailable: target,
              newAvailable: q.available,
              result: 'ERROR',
              reason: msg,
              reference: 'Railway auto reconcile'
            });
          }
        }

        sheetWrites.push(
          { range: `'SHOPIFY SYNC'!J${m.rowNumber}:M${m.rowNumber}`, values: [[newAvailable, q.committed, q.reserved, q.on_hand]] },
          { range: `'SHOPIFY SYNC'!S${m.rowNumber}:T${m.rowNumber}`, values: [[nowPacific(), note]] }
        );
      }
    }

    if (sheetWrites.length) await updateValues(sheetWrites);
    return summary;
  } finally {
    reconcileRunning = false;
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'purebble-shopify-inventory-runner',
    googleConfigured: googleConfigured(),
    shopifyApiConfigured: shopifyApiConfigured(),
    inventoryAutoSyncEnabled: ENABLE_SHOPIFY_INVENTORY_SYNC
  });
});

app.post('/webhooks/shopify/fulfillments-create', async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const results = await processFulfillment(req.body);
    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('fulfillment processing failed', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/admin/reconcile', async (req, res) => {
  if (!verifyAdminRequest(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const allowWrites = req.body?.write === true;
    const summary = await reconcileInventory({ allowWrites, source: allowWrites ? 'Manual Production Reconcile' : 'Manual Dry Run' });
    res.status(200).json({ ok: true, allowWrites, summary });
  } catch (err) {
    console.error('inventory reconcile failed', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/', (_req, res) => res.json({ ok: true, name: 'PUREBBLE Shopify Inventory Runner' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PUREBBLE runner listening on ${PORT}`);
  if (ENABLE_SHOPIFY_INVENTORY_SYNC && googleConfigured() && shopifyApiConfigured()) {
    console.log(`Inventory auto reconcile enabled every ${SYNC_INTERVAL_MS} ms`);
    setTimeout(() => reconcileInventory({ allowWrites: true }).catch(err => console.error('initial reconcile failed', err)), 5000);
    setInterval(() => reconcileInventory({ allowWrites: true }).catch(err => console.error('scheduled reconcile failed', err)), SYNC_INTERVAL_MS);
  } else {
    console.log('Inventory auto reconcile disabled until credentials and ENABLE_SHOPIFY_INVENTORY_SYNC=true are configured');
  }
});
