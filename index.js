import express from 'express';
import crypto from 'crypto';
import { google } from 'googleapis';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const SHOPIFY_WEBHOOK_HMAC_SECRET = process.env.SHOPIFY_WEBHOOK_HMAC_SECRET || '';

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); }
}));

let sheetsClient;
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'purebble-shopify-inventory-runner', googleConfigured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) });
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

app.get('/', (_req, res) => res.json({ ok: true, name: 'PUREBBLE Shopify Inventory Runner' }));

app.listen(PORT, '0.0.0.0', () => console.log(`PUREBBLE runner listening on ${PORT}`));
