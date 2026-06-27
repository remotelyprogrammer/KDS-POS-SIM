require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');

const app      = express();
const KDS_URL  = (process.env.KDS_URL  || 'http://localhost:3001').replace(/\/$/, '');
const FORMAT   = process.env.POS_FORMAT || 'manual';
const PORT     = parseInt(process.env.PORT || '4000');
const STORE_ID = process.env.STORE_ID || 'store_001';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function kdsRequest(method, endpoint, body = null, extraHeaders = {}) {
  const url  = KDS_URL + endpoint;
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

function authHeaders(format, bodyStr) {
  if (format === 'ls-central') {
    return { 'x-ls-central-secret': process.env.LS_CENTRAL_SECRET || '' };
  }
  if (format === 'square') {
    const secret = process.env.SQUARE_WEBHOOK_SECRET || '';
    const sig    = crypto.createHmac('sha256', secret).update(bodyStr).digest('base64');
    return { 'x-square-hmacsha256-signature': sig };
  }
  if (format === 'generic') {
    return { 'x-webhook-secret': process.env.GENERIC_WEBHOOK_SECRET || '' };
  }
  return {};
}

function intakePath(format) {
  const map = { 'ls-central': '/intake/ls-central', square: '/intake/square', generic: '/intake/webhook' };
  return map[format] || '/intake/manual';
}

function buildPayload(format, order, eventType) {
  if (format === 'ls-central') {
    if (eventType === 'cancel') {
      return { Type: 'cancel', KOTNo: order.posOrderId, VoidReason: order.reason || null };
    }
    return {
      Type:       eventType === 'update' ? 'update' : 'new',
      KOTNo:      order.posOrderId,
      TableNo:    order.table,
      SalesType:  order.orderType === 'Delivery' ? 'GRABFOOD' : order.orderType === 'Takeaway' ? 'TAKEAWAY' : 'DINE IN',
      StaffName:  order.server,
      GuestCount: order.guestCount,
      Items: (order.items || []).map(i => ({
        ItemCode: i.name, ItemDescription: i.name, Quantity: i.qty,
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
            location_id:  STORE_ID,
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
      store_id:    STORE_ID,
      event_type:  eventType,
      table:       order.table,
      order_type:  order.orderType === 'Dine In' ? 'dine_in' : order.orderType.toLowerCase().replace(' ', '_'),
      server_name: order.server,
      guest_count: order.guestCount,
      items: (order.items || []).map(i => ({
        item_id:  i.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        name:     i.name,
        quantity: i.qty,
        modifiers: [],
        station:  STATIONS[i.sid - 1] || 'general',
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

app.get('/sim/config', (_req, res) => {
  res.json({ kdsUrl: KDS_URL, format: FORMAT, port: PORT });
});

app.get('/sim/health', async (_req, res) => {
  try {
    const r = await kdsRequest('GET', '/intake/status');
    res.json({ connected: r.ok, kdsUrl: KDS_URL, format: FORMAT, kds: r.body });
  } catch (err) {
    res.json({ connected: false, kdsUrl: KDS_URL, format: FORMAT, error: err.message });
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

app.post('/sim/fire', async (req, res) => {
  const { order, format: fmt } = req.body;
  const format  = fmt || FORMAT;
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
  const format  = fmt || FORMAT;
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
  const format  = fmt || FORMAT;
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
    const result = await kdsRequest('POST', '/void/item', { order_item_id: orderItemId, reason });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  KDS POS Simulator`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  KDS  →  ${KDS_URL}`);
  console.log(`  Format  ${FORMAT}\n`);
});
