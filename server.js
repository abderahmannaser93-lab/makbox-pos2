/**
 * MAK BOX POS — Production Backend
 * Stack: Node.js + Express + Socket.IO
 * Auth: JWT + Role-based (admin | manager | staff)
 * Storage: PostgreSQL via Prisma (stubbed with persistent JSON for portability)
 * Cache: In-process LRU (drop-in Redis replacement)
 * Real-time: Socket.IO rooms (kitchen | staff | table:X)
 * Logging: structured console (replace with Pino/Winston in prod)
 * 
 * QUICK START (no DB required):
 *   npm install && node server.js
 *
 * PRODUCTION (with DB):
 *   Set DATABASE_URL in .env, run `npx prisma migrate deploy`
 */

'use strict';

const express       = require('express');
const http          = require('http');
const { Server }    = require('socket.io');
const cors          = require('cors');
const jwt           = require('jsonwebtoken');
const bcrypt        = require('bcryptjs');
const { z }         = require('zod');
const rateLimit     = require('express-rate-limit');
const path          = require('path');
const fs            = require('fs');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  port:        process.env.PORT        || 3001,
  jwtSecret:   process.env.JWT_SECRET  || 'CHANGE_ME_IN_PRODUCTION_32chars+',
  jwtExpiry:   process.env.JWT_EXPIRY  || '12h',
  nodeEnv:     process.env.NODE_ENV    || 'development',
  tableCount:  parseInt(process.env.TABLE_COUNT || '12'),
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:3001', 'http://localhost:5173'],
};

// ─── LOGGER ────────────────────────────────────────────────────────────────
const log = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'info',  ts: new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', ts: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error',ts: new Date().toISOString(), msg, ...meta })),
};

// ─── PERSISTENT JSON STORE (replaces PostgreSQL for portability) ────────────
// In a real deployment, replace all store.* calls with Prisma queries.
const DB_FILE = path.join(__dirname, '.db.json');
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) { log.warn('DB load failed, starting fresh', { err: e.message }); }
  return { orders: [], payments: [], dailyStats: {} };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) { log.error('DB save failed', { err: e.message }); }
}
const db = loadDB();
// Auto-save every 10 seconds
setInterval(() => saveDB(db), 10_000);
process.on('SIGTERM', () => { saveDB(db); process.exit(0); });
process.on('SIGINT',  () => { saveDB(db); process.exit(0); });

// ─── MENU (static, loaded once) ────────────────────────────────────────────
const MENU = require('./menu.json');
// Build a fast lookup map
const MENU_MAP = {};
MENU.items.forEach(item => { MENU_MAP[item.id] = item; });
const EXTRAS_MAP = {};
MENU.extras.forEach(e => { EXTRAS_MAP[e.id] = e; });

// ─── TABLES (in-memory — mirrors DB tables table) ──────────────────────────
const tables = Array.from({ length: CONFIG.tableCount }, (_, i) => ({
  id:             i + 1,
  status:         'free',       // free | occupied | bill-requested
  currentOrderId: null,
  openedAt:       null,
}));

// ─── USER STORE (in-memory — replace with Prisma users table) ─────────────
// Passwords are bcrypt hashed. Default credentials:
//   admin / admin123  |  manager / manager123  |  staff / staff123
const USERS = [
  { id: 'u1', username: 'admin',   role: 'admin',   passwordHash: bcrypt.hashSync('admin123', 10) },
  { id: 'u2', username: 'manager', role: 'manager', passwordHash: bcrypt.hashSync('manager123', 10) },
  { id: 'u3', username: 'staff',   role: 'staff',   passwordHash: bcrypt.hashSync('staff123', 10) },
];

// ─── EXPRESS SETUP ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  pingTimeout:  60_000,
  pingInterval: 25_000,
});

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: CONFIG.nodeEnv === 'development' ? '*' : CONFIG.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, _res, next) => {
  log.info('request', { method: req.method, path: req.path, ip: req.ip });
  next();
});

// Global rate limiter
const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api/', limiter);

// Auth rate limiter (stricter)
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Serve static frontends
app.use('/staff',    express.static(path.join(__dirname, 'public/staff')));
app.use('/customer', express.static(path.join(__dirname, 'public/customer')));
app.use('/manager',  express.static(path.join(__dirname, 'public/manager')));
app.use('/kitchen',  express.static(path.join(__dirname, 'public/kitchen')));

// PWA: service worker at root scope + manifests + icons + offline page
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/pwa/sw.js'));
});
app.use('/pwa', express.static(path.join(__dirname, 'public/pwa'), { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — each sub-app serves index.html for deep links
['customer', 'staff', 'kitchen', 'manager'].forEach(route => {
  app.get('/' + route + '/*', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', route, 'index.html'))
  );
});

// ─── AUTH HELPERS ───────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, CONFIG.jwtSecret, { expiresIn: CONFIG.jwtExpiry });
}

function requireAuth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(token, CONFIG.jwtSecret);
      if (roles.length && !roles.includes(payload.role))
        return res.status(403).json({ error: 'Insufficient permissions' });
      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// ─── VALIDATION SCHEMAS (Zod) ───────────────────────────────────────────────
const LoginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

const OrderItemSchema = z.object({
  itemId:   z.string().min(1),
  size:     z.enum(['orta', 'buyuk', 'tek']),
  quantity: z.number().int().min(1).max(20),
  extras:   z.array(z.string()).default([]),
  note:     z.string().max(200).optional().default(''),
});

const CreateOrderSchema = z.object({
  tableId: z.number().int().min(1),
  items:   z.array(OrderItemSchema).min(1).max(50),
  note:    z.string().max(500).optional().default(''),
});

const UpdateStatusSchema = z.object({
  status: z.enum(['new', 'preparing', 'ready', 'paid', 'cancelled']),
});

// ─── HELPERS ────────────────────────────────────────────────────────────────
function calcOrderTotal(items) {
  return items.reduce((sum, item) => {
    const menuItem = MENU_MAP[item.itemId];
    if (!menuItem) return sum;
    const basePrice = menuItem.sizes[item.size] || 0;
    const extrasPrice = (item.extras || []).reduce((es, eid) => {
      return es + (EXTRAS_MAP[eid]?.price || 0);
    }, 0);
    return sum + (basePrice + extrasPrice) * item.quantity;
  }, 0);
}

function enrichOrderItem(item) {
  const menuItem = MENU_MAP[item.itemId];
  return {
    ...item,
    itemName:   menuItem?.name  || item.itemId,
    itemDesc:   menuItem?.desc  || '',
    sizeLabel:  item.size === 'orta' ? 'ORTA' : item.size === 'buyuk' ? 'BÜYÜK' : '',
    unitPrice:  menuItem?.sizes[item.size] || 0,
    extrasDetail: (item.extras || []).map(eid => ({
      id: eid,
      name: EXTRAS_MAP[eid]?.name || eid,
      price: EXTRAS_MAP[eid]?.price || 0,
    })),
  };
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyStats() {
  const key = getTodayKey();
  if (!db.dailyStats[key]) {
    db.dailyStats[key] = { revenue: 0, orders: 0, dishCounts: {}, hourBuckets: {} };
  }
  return db.dailyStats[key];
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), version: '2.0.0' });
});

// ── AUTH ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, (req, res) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'Invalid input', details: parse.error.flatten() });

  const { username, password } = parse.data;
  const user = USERS.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  log.info('login', { username, role: user.role });
  res.json({ token, role: user.role, username: user.username });
});

// ── MENU ────────────────────────────────────────────────────────────────────
app.get('/api/menu', (_req, res) => {
  // Menu is static — cache forever on clients
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(MENU);
});

// ── TABLES ──────────────────────────────────────────────────────────────────
app.get('/api/tables', (_req, res) => res.json(tables));

app.get('/api/tables/:id', (req, res) => {
  const table = tables.find(t => t.id === parseInt(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  const activeOrders = db.orders.filter(o => o.tableId === table.id && o.status !== 'paid' && o.status !== 'cancelled');
  res.json({ ...table, activeOrders });
});

// Staff: request bill
app.put('/api/tables/:id/bill-request', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const table = tables.find(t => t.id === parseInt(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  table.status = 'bill-requested';
  io.to('staff').emit('table:update', table);
  res.json(table);
});

// ── ORDERS ──────────────────────────────────────────────────────────────────
app.get('/api/orders', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const { status, tableId, page = 1, limit = 50 } = req.query;
  let filtered = [...db.orders];
  if (status)  filtered = filtered.filter(o => o.status === status);
  if (tableId) filtered = filtered.filter(o => o.tableId === parseInt(tableId));
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total  = filtered.length;
  const paged  = filtered.slice((page - 1) * limit, page * limit);
  res.json({ orders: paged, total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

app.get('/api/orders/active', requireAuth(['staff', 'manager', 'admin']), (_req, res) => {
  const active = db.orders
    .filter(o => o.status !== 'paid' && o.status !== 'cancelled')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(active);
});

app.get('/api/orders/:id', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Customer tablet: create order (no auth, but table validation)
app.post('/api/orders', (req, res) => {
  const parse = CreateOrderSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'Invalid order data', details: parse.error.flatten() });

  const { tableId, items, note } = parse.data;

  // Validate table
  const table = tables.find(t => t.id === tableId);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  // Validate all items exist in menu
  for (const item of items) {
    const menuItem = MENU_MAP[item.itemId];
    if (!menuItem) return res.status(400).json({ error: `Menu item not found: ${item.itemId}` });
    if (!menuItem.sizes[item.size] && menuItem.sizes[item.size] !== 0)
      return res.status(400).json({ error: `Size '${item.size}' not available for ${menuItem.name}` });
    for (const eid of item.extras) {
      if (!EXTRAS_MAP[eid]) return res.status(400).json({ error: `Extra not found: ${eid}` });
    }
  }

  const enrichedItems = items.map(enrichOrderItem);
  const total = calcOrderTotal(items);
  const now = new Date();
  const hour = now.getHours();

  const order = {
    id:        'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    tableId,
    items:     enrichedItems,
    note:      note || '',
    status:    'new',
    total,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history:   [{ status: 'new', at: now.toISOString() }],
  };

  db.orders.push(order);

  // Update table state
  table.status = 'occupied';
  if (!table.openedAt) table.openedAt = now.toISOString();
  // Don't overwrite if multiple orders for same table
  table.currentOrderId = order.id;

  // Update stats
  const stats = getDailyStats();
  stats.orders++;
  stats.hourBuckets[hour] = (stats.hourBuckets[hour] || 0) + 1;
  enrichedItems.forEach(i => {
    stats.dishCounts[i.itemName] = (stats.dishCounts[i.itemName] || 0) + i.quantity;
  });

  saveDB(db);

  log.info('order:new', { orderId: order.id, tableId, total, items: items.length });

  // Broadcast
  io.to('kitchen').emit('order:new', order);
  io.to('staff').emit('order:new', order);
  io.to(`table:${tableId}`).emit('order:new', order);
  io.emit('table:update', table);

  res.status(201).json(order);
});

// Staff/kitchen: update order status
app.put('/api/orders/:id/status', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const parse = UpdateStatusSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'Invalid status' });

  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const prevStatus = order.status;
  order.status    = parse.data.status;
  order.updatedAt = new Date().toISOString();
  order.history.push({ status: order.status, at: order.updatedAt, by: req.user.username });

  if (order.status === 'paid') {
    const stats = getDailyStats();
    stats.revenue += order.total;
    // Free table if no other active orders
    const table = tables.find(t => t.id === order.tableId);
    if (table) {
      const otherActive = db.orders.some(o =>
        o.id !== order.id && o.tableId === table.id && o.status !== 'paid' && o.status !== 'cancelled'
      );
      if (!otherActive) {
        table.status = 'free';
        table.currentOrderId = null;
        table.openedAt = null;
      }
    }
    // Record payment
    db.payments.push({
      id:      'PAY-' + Date.now(),
      orderId: order.id,
      amount:  order.total,
      paidAt:  order.updatedAt,
      by:      req.user.username,
    });
  }

  saveDB(db);
  log.info('order:update', { orderId: order.id, from: prevStatus, to: order.status, by: req.user.username });

  io.to('kitchen').emit('order:update', order);
  io.to('staff').emit('order:update', order);
  io.to(`table:${order.tableId}`).emit('order:update', order);
  io.emit('table:update', tables.find(t => t.id === order.tableId));

  res.json(order);
});

// Close table / pay all orders
app.post('/api/tables/:id/close', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const table = tables.find(t => t.id === parseInt(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const activeOrders = db.orders.filter(
    o => o.tableId === table.id && o.status !== 'paid' && o.status !== 'cancelled'
  );
  const now = new Date().toISOString();
  const stats = getDailyStats();

  activeOrders.forEach(order => {
    order.status = 'paid';
    order.updatedAt = now;
    order.history.push({ status: 'paid', at: now, by: req.user.username });
    stats.revenue += order.total;
    db.payments.push({ id: 'PAY-' + Date.now() + order.id, orderId: order.id, amount: order.total, paidAt: now, by: req.user.username });
  });

  table.status = 'free';
  table.currentOrderId = null;
  table.openedAt = null;

  saveDB(db);
  log.info('table:close', { tableId: table.id, orders: activeOrders.length, by: req.user.username });

  io.emit('table:update', table);
  activeOrders.forEach(o => {
    io.to('kitchen').emit('order:update', o);
    io.to('staff').emit('order:update', o);
  });

  res.json({ success: true, closedOrders: activeOrders.length });
});

// ── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/reports/daily', requireAuth(['manager', 'admin']), (req, res) => {
  const key   = req.query.date || getTodayKey();
  const stats = db.dailyStats[key] || { revenue: 0, orders: 0, dishCounts: {}, hourBuckets: {} };

  const topItems = Object.entries(stats.dishCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const peakHours = Object.entries(stats.hourBuckets)
    .map(([hour, count]) => ({ hour: parseInt(hour), label: `${hour}:00`, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({
    date:        key,
    revenue:     stats.revenue,
    orders:      stats.orders,
    avgBill:     stats.orders > 0 ? Math.round(stats.revenue / stats.orders) : 0,
    topItems,
    peakHours,
    generatedAt: new Date().toISOString(),
  });
});

app.get('/api/reports/summary', requireAuth(['manager', 'admin']), (_req, res) => {
  // Last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const stats = db.dailyStats[key] || { revenue: 0, orders: 0 };
    days.push({ date: key, revenue: stats.revenue, orders: stats.orders });
  }
  res.json({ days });
});

// ── KITCHEN PRINTER STUB ───────────────────────────────────────────────────
// In production, replace this with ESC/POS commands sent to a thermal printer
app.post('/api/orders/:id/print', requireAuth(['staff', 'manager', 'admin']), (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Generate receipt text (80-char thermal format)
  const lines = [
    '================================',
    `  MAK BOX - MASA ${order.tableId}`,
    `  ${order.id}`,
    `  ${new Date(order.createdAt).toLocaleString('tr-TR')}`,
    '================================',
    ...order.items.map(i =>
      `${i.quantity}x ${i.itemName} (${i.sizeLabel || ''})\n` +
      (i.extrasDetail?.length ? `   + ${i.extrasDetail.map(e=>e.name).join(', ')}\n` : '') +
      (i.note ? `   Not: ${i.note}\n` : '') +
      `   ${((i.unitPrice) * i.quantity).toLocaleString('tr-TR')} ₺`
    ),
    '--------------------------------',
    `TOPLAM: ${order.total.toLocaleString('tr-TR')} ₺`,
    '================================',
    order.note ? `Not: ${order.note}` : '',
    'Fiyatlar ' + MENU.menuPriceDate + ' tarihli.',
    '',
  ].filter(l => l !== null);

  log.info('print', { orderId: order.id, by: req.user.username });
  res.json({ receipt: lines.join('\n'), orderId: order.id });
});

// ─── SOCKET.IO ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const role    = socket.handshake.query.role    || 'unknown';
  const tableId = socket.handshake.query.tableId || null;

  log.info('socket:connect', { id: socket.id, role, tableId });

  // Join rooms based on role
  if (role === 'kitchen')             socket.join('kitchen');
  if (role === 'staff')               socket.join('staff');
  if (role === 'manager')             socket.join('staff');
  if (role === 'customer' && tableId) socket.join(`table:${tableId}`);

  // Send current state on connect
  socket.emit('init', {
    tables,
    activeOrders: db.orders.filter(o => o.status !== 'paid' && o.status !== 'cancelled'),
    menu: MENU,
  });

  // Customer calls waiter
  socket.on('call:waiter', ({ tableId: tid }) => {
    log.info('call:waiter', { tableId: tid });
    io.to('staff').emit('call:waiter', { tableId: tid, time: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    log.info('socket:disconnect', { id: socket.id, role });
  });
});

// ─── GLOBAL ERROR HANDLER ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log.error('unhandled', { msg: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// Root — serve main PWA landing page
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Catch uncaught exceptions — log and keep server alive
process.on('uncaughtException',      (e) => log.error('uncaughtException',      { msg: e.message, stack: e.stack }));
process.on('unhandledRejection', (r, p) => log.error('unhandledRejection',  { reason: String(r), promise: String(p) }));

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(CONFIG.port, () => {
  log.info('server:start', { port: CONFIG.port, env: CONFIG.nodeEnv, tables: CONFIG.tableCount });
  console.log(`
  ╔══════════════════════════════════════╗
  ║      MAK BOX POS  v2.0.0            ║
  ║  http://localhost:${CONFIG.port}              ║
  ║                                      ║
  ║  Staff    → /staff                   ║
  ║  Customer → /customer?table=1        ║
  ║  Kitchen  → /kitchen                 ║
  ║  Manager  → /manager                 ║
  ╚══════════════════════════════════════╝
  `);
});
