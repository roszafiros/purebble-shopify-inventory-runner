import { spawn } from 'node:child_process';

const SHOP = String(process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const PUBLIC_HOST = String(process.env.RAILWAY_PUBLIC_DOMAIN || 'purebble-webhook-prod-production.up.railway.app').replace(/^https?:\/\//, '').replace(/\/$/, '');
const WEBHOOKS = [
  { topic: 'FULFILLMENTS_CREATE', path: '/webhooks/shopify/fulfillments-create' },
  { topic: 'ORDERS_CREATE', path: '/webhooks/shopify/orders-create' },
  { topic: 'ORDERS_CANCELLED', path: '/webhooks/shopify/orders-cancelled' },
  { topic: 'REFUNDS_CREATE', path: '/webhooks/shopify/refunds-create' }
].map(x => ({ ...x, uri: `https://${PUBLIC_HOST}${x.path}` }));
const REFRESH_MS = 23 * 60 * 60 * 1000;

let child = null;
let stopping = false;

function required(name, value) {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function getAccessToken() {
  required('SHOPIFY_STORE_DOMAIN', SHOP);
  required('SHOPIFY_CLIENT_ID', CLIENT_ID);
  required('SHOPIFY_CLIENT_SECRET', CLIENT_SECRET);

  const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Shopify token request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const expiresIn = Number(body.expires_in || 86400);
  console.log(`Shopify access token acquired; expires in ${expiresIn}s`);
  return body.access_token;
}

async function graphql(accessToken, query, variables = {}) {
  const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (body.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function ensureLifecycleWebhooks(accessToken) {
  const listQuery = `
    query PurebbleWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
      webhookSubscriptions(first: 100, topics: $topics) {
        nodes { id topic uri format }
      }
    }
  `;

  const createMutation = `
    mutation CreatePurebbleWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id topic uri format }
        userErrors { field message }
      }
    }
  `;

  const topics = WEBHOOKS.map(x => x.topic);
  let listed = await graphql(accessToken, listQuery, { topics });
  let nodes = listed?.webhookSubscriptions?.nodes || [];

  for (const target of WEBHOOKS) {
    const exact = nodes.find(x => x.topic === target.topic && x.uri === target.uri);
    if (exact) {
      console.log(`WEBHOOK_VERIFY OK existing id=${exact.id} topic=${exact.topic} uri=${exact.uri}`);
      continue;
    }

    const created = await graphql(accessToken, createMutation, {
      topic: target.topic,
      webhookSubscription: { uri: target.uri, format: 'JSON' }
    });
    const result = created?.webhookSubscriptionCreate;
    if (result?.userErrors?.length) {
      throw new Error(`Webhook create failed for ${target.topic}: ${result.userErrors.map(e => `${e.field || ''}: ${e.message}`).join('; ')}`);
    }
    if (!result?.webhookSubscription?.id) throw new Error(`Webhook create returned no subscription for ${target.topic}`);
    console.log(`WEBHOOK_CREATE OK id=${result.webhookSubscription.id} topic=${result.webhookSubscription.topic} uri=${result.webhookSubscription.uri}`);

    listed = await graphql(accessToken, listQuery, { topics });
    nodes = listed?.webhookSubscriptions?.nodes || [];
    const verified = nodes.find(x => x.id === result.webhookSubscription.id && x.uri === target.uri);
    if (!verified) throw new Error(`Webhook verification failed after create for ${target.topic}`);
    console.log(`WEBHOOK_VERIFY OK created id=${verified.id} topic=${verified.topic} uri=${verified.uri}`);
  }
}

async function startRunner() {
  const accessToken = await getAccessToken();
  await ensureLifecycleWebhooks(accessToken);
  child = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SHOPIFY_ADMIN_ACCESS_TOKEN: accessToken,
      SHOPIFY_WEBHOOK_HMAC_SECRET: CLIENT_SECRET
    }
  });

  child.on('exit', (code, signal) => {
    console.log(`Runner exited code=${code} signal=${signal || ''}`);
    child = null;
    if (!stopping && code !== 0) {
      setTimeout(() => startRunner().catch(fatal), 5000);
    }
  });
}

async function rotateToken() {
  if (stopping) return;
  console.log('Refreshing Shopify access token by restarting runner');
  if (child) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (child) child.kill('SIGKILL');
        resolve();
      }, 10000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  await startRunner();
}

function fatal(err) {
  console.error('Client credentials launcher failed:', err);
  process.exit(1);
}

async function shutdown(signal) {
  stopping = true;
  console.log(`Launcher received ${signal}`);
  if (child) child.kill(signal);
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startRunner().catch(fatal);
setInterval(() => rotateToken().catch(fatal), REFRESH_MS);
