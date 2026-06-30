require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app         = express();
const PORT        = parseInt(process.env.PORT || '4000');
const CONFIG_FILE = path.join(__dirname, 'sim-config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Runtime config ────────────────────────────────────────────────────────────

let _cfg = null;

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { _cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); return; } catch (e) {}
  }
  _cfg = {
    kdsUrl:  (process.env.KDS_URL || 'http://localhost:3001').replace(/\/$/, ''),
    format:  process.env.POS_FORMAT || 'manual',
    storeId: process.env.STORE_ID || 'store_001',
    secrets: {
      'ls-central': process.env.LS_CENTRAL_SECRET        || '',
      square:       process.env.SQUARE_WEBHOOK_SECRET     || '',
      generic:      process.env.GENERIC_WEBHOOK_SECRET    || '',
    },
  };
}

function cfg() {
  if (!_cfg) loadConfig();
  return _cfg;
}

function saveConfig(updates) {
  const current = cfg();
  if (updates.secrets) {
    updates.secrets = { ...current.secrets, ...updates.secrets };
  }
  _cfg = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cfg, null, 2));
}

// ── KDS request helper ────────────────────────────────────────────────────────

async function kdsRequest(method, endpoint, body = null, extraHeaders = {}) {
  const url  = cfg().kdsUrl + endpoint;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(8000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return { status: res.status, ok: res.ok, body: JSON.parse(text) }; }
  catch { return { status: res.status, ok: res.ok, body: text }; }
}

// ── Auth headers per format ───────────────────────────────────────────────────

function authHeaders(format, bodyStr) {
  const secrets = cfg().secrets || {};
  if (format === 'ls-central') {
    return { 'x-ls-secret': secrets['ls-central'] || '' };
  }
  if (format === 'square') {
    const secret = secrets.square || '';
    const sig    = crypto.createHmac('sha256', secret).update(bodyStr).digest('base64');
    return { 'x-square-hmacsha256-signature': sig };
  }
  if (format === 'generic') {
    return { 'x-webhook-secret': secrets.generic || '' };
  }
  return {};
}

// ── Payload builders ──────────────────────────────────────────────────────────

function intakePath(format) {
  const map = { 'ls-central': '/intake/ls-central', square: '/intake/square', generic: '/intake/webhook' };
  return map[format] || '/intake/manual';
}

function buildPayload(format, order, eventType) {
  const storeId = cfg().storeId || 'store_001';

  if (format === 'ls-central') {
    if (eventType === 'cancel') {
      return { Voided: true, KOTNo: order.posOrderId, VoidReason: order.reason || null };
    }
    return {
      KOTNo:      order.posOrderId,
      IsModified: eventType === 'update' ? true : undefined,
      StoreNo:    storeId,
      TableNo:    order.table,
      OrderType:  order.orderType === 'Delivery' ? 'DELIVERY' : order.orderType === 'Takeaway' ? 'TAKEAWAY' : 'DINEIN',
      WaiterName: order.server,
      Covers:     order.guestCount,
      KOTLines: (order.items || []).map(i => ({
        No:          i.name,
        Description: i.name,
        Quantity:    i.qty,
      })),
    };
  }

  if (format === 'square') {
    if (eventType === 'cancel') {
      return { type: 'order.canceled', data: { object: { order: { id: order.posOrderId } } } };
    }
    return {
      type: eventType === 'update' ? 'order.updated' : 'order.created',
      data: {
        object: {
          order: {
            id:           order.posOrderId,
            location_id:  storeId,
            ticket_name:  order.table,
            fulfillments: [{ type: order.orderType === 'Delivery' ? 'DELIVERY' : order.orderType === 'Takeaway' ? 'PICKUP' : 'DINE_IN' }],
            line_items:   (order.items || []).map(i => ({
              catalog_object_id: i.name, name: i.name, quantity: String(i.qty), modifiers: [],
            })),
            created_at: new Date().toISOString(),
          },
        },
      },
    };
  }

  if (format === 'generic') {
    if (eventType === 'cancel') {
      return { order_id: order.posOrderId, event_type: 'cancel', reason: order.reason || null };
    }
    const STATIONS = ['pantry', 'saute', 'fry', 'bar'];
    return {
      order_id:    order.posOrderId,
      store_id:    storeId,
      event_type:  eventType,
      table:       order.table,
      order_type:  order.orderType === 'Dine In' ? 'dine_in' : order.orderType.toLowerCase().replace(' ', '_'),
      server_name: order.server,
      guest_count: order.guestCount,
      items: (order.items || []).map(i => ({
        item_id:   i.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        name:      i.name,
        quantity:  i.qty,
        modifiers: [],
        station:   STATIONS[i.sid - 1] || 'general',
      })),
      created_at: new Date().toISOString(),
    };
  }

  if (eventType === 'cancel') return null;

  return {
    pos_order_id: order.posOrderId,
    table_ref:    order.table,
    order_type:   order.orderType,
    server_name:  order.server,
    guest_count:  order.guestCount,
    items: (order.items || []).map(i => ({
      name: i.name, quantity: i.qty, station_id: i.sid,
    })),
  };
}

// ── Settings routes ───────────────────────────────────────────────────────────

app.get('/sim/settings', (_req, res) => {
  const c = cfg();
  res.json({
    kdsUrl:  c.kdsUrl,
    format:  c.format,
    storeId: c.storeId,
    secrets: {
      'ls-central': c.secrets?.['ls-central'] ? '****' : '',
      square:       c.secrets?.square         ? '****' : '',
      generic:      c.secrets?.generic        ? '****' : '',
    },
  });
});

app.post('/sim/settings', (req, res) => {
  const { kdsUrl, format, storeId, secrets } = req.body;
  const updates = {};
  if (kdsUrl  !== undefined) updates.kdsUrl  = kdsUrl.replace(/\/$/, '');
  if (format  !== undefined) updates.format  = format;
  if (storeId !== undefined) updates.storeId = storeId;
  if (secrets) {
    const filtered = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (v && v !== '****') filtered[k] = v;
    }
    if (Object.keys(filtered).length) updates.secrets = filtered;
  }
  saveConfig(updates);
  res.json({ saved: true });
});

// ── Info routes ───────────────────────────────────────────────────────────────

app.get('/sim/config', (_req, res) => {
  const c = cfg();
  res.json({ kdsUrl: c.kdsUrl, format: c.format, port: PORT });
});

app.get('/sim/health', async (_req, res) => {
  const c = cfg();
  try {
    const r = await kdsRequest('GET', '/intake/status');
    res.json({ connected: r.ok, kdsUrl: c.kdsUrl, format: c.format, kds: r.body });
  } catch (err) {
    res.json({ connected: false, kdsUrl: c.kdsUrl, format: c.format, error: err.message });
  }
});

app.get('/sim/test-auth', async (_req, res) => {
  const c      = cfg();
  const format = c.format;

  // Manual format has no auth — connectivity check only
  if (format === 'manual') {
    try {
      const r = await kdsRequest('GET', '/intake/status');
      return res.json({ connected: r.ok, authed: true, status: r.status, message: 'Manual — no auth required' });
    } catch (err) {
      return res.json({ connected: false, authed: false, status: null, message: err.message });
    }
  }

  // POST /intake/ping with an empty {} body — KDS validates auth headers without creating any orders.
  // Square HMAC is computed over '{}' (the JSON of the empty body both sides agree on).
  const pingBody    = {};
  const pingBodyStr = '{}';
  const headers     = authHeaders(format, pingBodyStr);

  try {
    const r      = await kdsRequest('POST', '/intake/ping', pingBody, headers);
    const authed = r.status !== 401;
    res.json({ connected: true, authed, status: r.status, message: authed ? 'Auth accepted by KDS' : 'Secret rejected — KDS returned 401' });
  } catch (err) {
    res.json({ connected: false, authed: false, status: null, message: err.message });
  }
});

app.get('/sim/orders', async (req, res) => {
  try {
    const r = await kdsRequest('GET', '/orders/expo/all');
    if (!r.ok) return res.json({ orders: [] });
    const raw = Array.isArray(r.body) ? r.body : [];
    const orders = raw.map(o => ({
      posOrderId : String(o.pos_order_id),
      table      : o.table_name  || o.table || '',
      orderType  : o.order_type  || o.orderType || '',
      server     : o.server_name || o.server || '',
      items      : (o.items || []).filter(i => i.status !== 'served' && i.status !== 'voided')
                                  .map(i => ({ name: i.name, qty: i.quantity || 1, sid: i.station_id || 1 })),
    })).filter(o => o.items.length > 0);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ orders: [], error: err.message });
  }
});

app.get('/sim/items/:posOrderId', async (req, res) => {
  try {
    const r = await kdsRequest('GET', '/orders/expo/all');
    if (!r.ok) return res.json({ items: [] });
    const orders = Array.isArray(r.body) ? r.body : [];
    const order  = orders.find(o => String(o.pos_order_id) === String(req.params.posOrderId));
    if (!order) return res.json({ items: [] });
    const active = (order.items || []).filter(i => i.status !== 'served' && i.status !== 'voided');
    res.json({ items: active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Simulator action routes ───────────────────────────────────────────────────

app.post('/sim/fire', async (req, res) => {
  const { order, format: fmt } = req.body;
  const format  = fmt || cfg().format;
  const payload = buildPayload(format, order, 'new');
  const bodyStr = JSON.stringify(payload);
  try {
    const result = await kdsRequest('POST', intakePath(format), payload, authHeaders(format, bodyStr));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sim/edit', async (req, res) => {
  const { order, format: fmt } = req.body;
  const format  = fmt || cfg().format;
  const payload = buildPayload(format, order, 'update');
  const bodyStr = JSON.stringify(payload);
  try {
    const result = await kdsRequest('POST', intakePath(format), payload, authHeaders(format, bodyStr));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sim/void-order', async (req, res) => {
  const { posOrderId, reason, format: fmt } = req.body;
  const format  = fmt || cfg().format;
  const payload = buildPayload(format, { posOrderId, reason }, 'cancel');
  try {
    let result;
    if (payload) {
      const bodyStr = JSON.stringify(payload);
      result = await kdsRequest('POST', intakePath(format), payload, authHeaders(format, bodyStr));
    } else {
      result = await kdsRequest('POST', '/void/order', { pos_order_id: posOrderId, reason });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sim/void-item', async (req, res) => {
  const { orderItemId, reason } = req.body;
  try {
    const result = await kdsRequest('POST', '/void/item', { order_item_id: parseInt(orderItemId, 10), reason });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

loadConfig();
app.listen(PORT, () => {
  const c = cfg();
  console.log(`\n  KDS POS Simulator`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  KDS    →  ${c.kdsUrl}`);
  console.log(`  Format →  ${c.format}\n`);
});
