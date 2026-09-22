import { spawn } from 'node:child_process';

const SHOP = String(process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
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

async function startRunner() {
  const accessToken = await getAccessToken();
  child = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    env: { ...process.env, SHOPIFY_ADMIN_ACCESS_TOKEN: accessToken }
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
