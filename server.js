const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;
const dbPool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

dbPool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'local-dev-secret',
    store: new PgSession({
      pool: dbPool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

const initialRooms = [
  { id: 'room-101', room_name: 'Lab Komputer 1', status: 'AVAILABLE', is_active: true },
  { id: 'room-102', room_name: 'Lab Komputer 2', status: 'AVAILABLE', is_active: true },
  { id: 'room-201', room_name: 'Ruang Seminar 1', status: 'AVAILABLE', is_active: true },
  { id: 'room-202', room_name: 'Ruang Seminar 2', status: 'AVAILABLE', is_active: true },
  { id: 'room-301', room_name: 'Loker A', status: 'AVAILABLE', is_active: true },
  { id: 'room-302', room_name: 'Loker B', status: 'AVAILABLE', is_active: true },
];

const initialSecurities = [
  { id: 'sec-1', name: 'Andi Pratama', is_active: true },
  { id: 'sec-2', name: 'Budi Santoso', is_active: true },
  { id: 'sec-3', name: 'Citra Lestari', is_active: true },
];

let rooms = initialRooms.map((room) => ({ ...room }));
let securities = initialSecurities.map((security) => ({ ...security }));
let securityPin = hashPin('123456');
let adminPin = hashPin(process.env.ADMIN_PIN || '000000');
let transactions = [];
let activityLogs = [];

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPin(pin, storedPin) {
  const [scheme, salt, storedHash] = String(storedPin).split('$');
  if (scheme === 'scrypt' && salt && storedHash) {
    const expected = Buffer.from(storedHash, 'hex');
    const actual = crypto.scryptSync(pin, salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  }

  const expected = Buffer.from(String(storedPin));
  const actual = Buffer.from(pin);
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function recordActivity({ action, actorRole, actorName, description, timestamp = new Date().toISOString() }) {
  activityLogs.unshift({
    id: createId('activity'),
    timestamp,
    action,
    actor_role: actorRole,
    actor_name: actorName,
    description,
  });
}

function snapshotState() {
  return {
    rooms,
    securities,
    transactions,
    activityLogs,
    securityPin,
    adminPin,
  };
}

async function persistSnapshot(state) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    for (const room of state.rooms) {
      await client.query(
        `INSERT INTO rooms (id, room_name, status, is_active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           room_name = EXCLUDED.room_name, status = EXCLUDED.status, is_active = EXCLUDED.is_active`,
        [room.id, room.room_name, room.status, room.is_active]
      );
    }

    for (const security of state.securities) {
      await client.query(
        `INSERT INTO securities (id, name, is_active)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active`,
        [security.id, security.name, security.is_active]
      );
    }

    for (const transaction of state.transactions) {
      await client.query(
        `INSERT INTO transactions (id, created_at, status, data)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           created_at = EXCLUDED.created_at, status = EXCLUDED.status, data = EXCLUDED.data`,
        [transaction.id, transaction.created_at, transaction.status, JSON.stringify(transaction)]
      );
    }

    for (const activity of state.activityLogs) {
      await client.query(
        `INSERT INTO activity_logs (id, occurred_at, action, actor_role, actor_name, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           occurred_at = EXCLUDED.occurred_at, action = EXCLUDED.action,
           actor_role = EXCLUDED.actor_role, actor_name = EXCLUDED.actor_name,
           description = EXCLUDED.description`,
        [activity.id, activity.timestamp, activity.action, activity.actor_role, activity.actor_name, activity.description]
      );
    }

    for (const [key, value] of [['security_pin', state.securityPin], ['admin_pin', state.adminPin]]) {
      await client.query(
        `INSERT INTO app_settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let persistenceQueue = Promise.resolve();
function persistState() {
  const state = snapshotState();
  const operation = persistenceQueue.then(
    () => persistSnapshot(state),
    () => persistSnapshot(state)
  );
  persistenceQueue = operation.catch((error) => {
    console.error('Failed to persist application state:', error);
  });
  return operation;
}

async function initializeDatabase() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      status TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS securities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL,
      action TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await dbPool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');

  const [roomRows, securityRows, transactionRows, activityRows, settingRows] = await Promise.all([
    dbPool.query('SELECT id, room_name, status, is_active FROM rooms ORDER BY id'),
    dbPool.query('SELECT id, name, is_active FROM securities ORDER BY id'),
    dbPool.query('SELECT data FROM transactions ORDER BY created_at DESC'),
    dbPool.query(`SELECT id, occurred_at, action, actor_role, actor_name, description
                  FROM activity_logs ORDER BY occurred_at DESC, id DESC`),
    dbPool.query('SELECT key, value FROM app_settings'),
  ]);
  const settings = new Map(settingRows.rows.map(({ key, value }) => [key, value]));

  rooms = roomRows.rows.length
    ? roomRows.rows
    : initialRooms.map((room) => ({ ...room }));
  securities = securityRows.rows.length
    ? securityRows.rows
    : initialSecurities.map((security) => ({ ...security }));
  transactions = transactionRows.rows.map(({ data }) => data);
  activityLogs = activityRows.rows.map((activity) => ({
    id: activity.id,
    timestamp: new Date(activity.occurred_at).toISOString(),
    action: activity.action,
    actor_role: activity.actor_role,
    actor_name: activity.actor_name,
    description: activity.description,
  }));
  securityPin = settings.get('security_pin') || hashPin('123456');
  adminPin = settings.get('admin_pin') || hashPin(process.env.ADMIN_PIN || '000000');
  if (!securityPin.startsWith('scrypt$')) securityPin = hashPin(securityPin);
  if (!adminPin.startsWith('scrypt$')) adminPin = hashPin(adminPin);

  await persistState();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function serializeRooms() {
  return rooms.map((room) => ({ ...room }));
}

function activeRooms() {
  return rooms.filter((room) => room.is_active);
}

function serializeSecurities() {
  return securities.map((security) => ({ ...security }));
}

function activeTransactions() {
  return [...transactions]
    .filter((item) => item.status !== 'DIKEMBALIKAN')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function refreshRealtime() {
  io.emit('dashboard:update', {
    rooms: activeRooms(),
    transactions: activeTransactions(),
    securities: serializeSecurities(),
  });
}

function requireSecurity(req, res, next) {
  if (req.session && req.session.role === 'security') {
    return next();
  }
  return res.redirect('/dashboard/security/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  return res.redirect('/dashboard/admin/login');
}

app.get('/', (req, res) => {
  res.render('index', { rooms: activeRooms() });
});

app.get('/dashboard/security/login', (req, res) => {
  res.render('security-login');
});

app.get('/dashboard/security/', requireSecurity, (req, res) => {
  res.render('security-dashboard', {
    rooms: activeRooms(),
    transactions: activeTransactions(),
    securities: serializeSecurities(),
  });
});

app.get('/dashboard/admin/login', (req, res) => {
  res.render('admin-login');
});

app.get('/dashboard/admin/', requireAdmin, (req, res) => {
  res.render('admin-dashboard', {
    rooms: serializeRooms(),
    transactions: [...transactions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    securities: serializeSecurities(),
    activityLogs,
  });
});

app.post('/dashboard/security/login', asyncRoute(async (req, res) => {
  const pin = String(req.body.pin || '').trim();

  if (!verifyPin(pin, securityPin)) {
    recordActivity({
      action: 'Login security gagal',
      actorRole: 'security',
      actorName: 'Security (PIN bersama)',
      description: 'Percobaan login ditolak karena PIN tidak valid.',
    });
    await persistState();
    return res.status(401).json({ message: 'PIN keamanan tidak valid.' });
  }

  req.session.role = 'security';
  recordActivity({
    action: 'Login security berhasil',
    actorRole: 'security',
    actorName: 'Security (PIN bersama)',
    description: 'Security berhasil masuk ke dashboard.',
  });
  await persistState();
  return res.redirect('/dashboard/security/');
}));

app.post('/dashboard/admin/login', asyncRoute(async (req, res) => {
  const pin = String(req.body.pin || '').trim();

  if (!verifyPin(pin, adminPin)) {
    recordActivity({
      action: 'Login admin gagal',
      actorRole: 'admin',
      actorName: 'Admin',
      description: 'Percobaan login ditolak karena PIN tidak valid.',
    });
    await persistState();
    return res.status(401).json({ message: 'PIN admin tidak valid.' });
  }

  req.session.role = 'admin';
  req.session.adminId = 'admin-1';
  recordActivity({
    action: 'Login admin berhasil',
    actorRole: 'admin',
    actorName: 'Admin',
    description: 'Admin berhasil masuk ke dashboard.',
  });
  await persistState();
  return res.redirect('/dashboard/admin/');
}));

app.post('/logout', asyncRoute(async (req, res) => {
  if (req.session?.role) {
    const role = req.session.role;
    recordActivity({
      action: `Logout ${role}`,
      actorRole: role,
      actorName: role === 'admin' ? 'Admin' : 'Security (PIN bersama)',
      description: `${role === 'admin' ? 'Admin' : 'Security'} keluar dari dashboard.`,
    });
    await persistState();
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
}));

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: activeRooms() });
});

app.get('/api/security/list', (req, res) => {
  res.json({ securities: serializeSecurities() });
});

app.get('/api/security/dashboard', requireSecurity, (req, res) => {
  res.json({
    rooms: activeRooms(),
    transactions: activeTransactions(),
    securities: serializeSecurities(),
  });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json({
    rooms: serializeRooms(),
    transactions: [...transactions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    securities: serializeSecurities(),
    activityLogs,
  });
});

app.post('/api/borrow-request', asyncRoute(async (req, res) => {
  const roomIds = Array.isArray(req.body.rooms) ? req.body.rooms : [req.body.rooms].filter(Boolean);
  const borrowerName = String(req.body.borrower_name || '').trim();
  const borrowerIdNumber = String(req.body.borrower_id_number || '').trim();
  const borrowerPhone = String(req.body.borrower_phone || '').trim();

  if (!borrowerName || !borrowerIdNumber || !borrowerPhone || roomIds.length === 0) {
    return res.status(400).json({
      message: 'Semua field peminjam dan minimal satu ruangan wajib diisi.',
    });
  }

  const now = new Date().toISOString();
  const unavailableRoom = roomIds.find((roomId) => {
    const room = rooms.find((item) => item.id === roomId);
    return !room || !room.is_active || room.status === 'BORROWED';
  });

  if (unavailableRoom) {
    return res.status(409).json({
      message: 'Satu atau lebih ruangan sudah dipinjam dan tidak dapat dipilih.',
    });
  }

  const transaction = {
    id: createId('tx'),
    borrower_name: borrowerName,
    borrower_id_number: borrowerIdNumber,
    borrower_phone: borrowerPhone,
    status: 'REQUESTED',
    created_at: now,
    borrowed_at: null,
    returned_at: null,
    issued_by_security_id: null,
    received_by_security_id: null,
    issued_by_security_name: null,
    received_by_security_name: null,
    rooms: roomIds,
    room_names: roomIds.map((roomId) => rooms.find((room) => room.id === roomId).room_name),
    created_by: 'borrower',
  };

  transactions.unshift(transaction);
  recordActivity({
    action: 'Permintaan peminjaman',
    actorRole: 'borrower',
    actorName: borrowerName,
    description: `${borrowerName} mengajukan ${roomIds.length} kunci: ${transaction.room_names.join(', ')} (NIM/NIK ${borrowerIdNumber}).`,
    timestamp: now,
  });
  roomIds.forEach((roomId) => {
    const room = rooms.find((item) => item.id === roomId);
    if (room) room.status = 'BORROWED';
  });

  await persistState();
  io.emit('borrow-request:new', transaction);
  refreshRealtime();

  return res.status(201).json({
    message: 'Permintaan peminjaman berhasil dikirim ke security.',
    transaction,
  });
}));

app.post('/api/security/transactions/:id/borrow', requireSecurity, asyncRoute(async (req, res) => {
  const transaction = transactions.find((item) => item.id === req.params.id);

  if (!transaction) {
    return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
  }

  const securityId = String(req.body.security_id || '');
  const security = securities.find((item) => item.id === securityId && item.is_active);

  if (!security) {
    return res.status(400).json({ message: 'Pilih security aktif yang menyerahkan kunci.' });
  }

  transaction.status = 'DIPINJAM';
  transaction.issued_by_security_id = securityId;
  transaction.issued_by_security_name = security.name;
  transaction.borrowed_at = transaction.borrowed_at || new Date().toISOString();
  transaction.returned_at = null;
  recordActivity({
    action: 'Kunci dipinjamkan',
    actorRole: 'security',
    actorName: security.name,
    description: `${security.name} menyerahkan kunci kepada ${transaction.borrower_name}: ${(transaction.room_names || []).join(', ')}.`,
    timestamp: transaction.borrowed_at,
  });

  transaction.rooms.forEach((roomId) => {
    const room = rooms.find((item) => item.id === roomId);
    if (room) room.status = 'BORROWED';
  });

  await persistState();
  refreshRealtime();
  return res.json({ message: 'Status transaksi diubah menjadi DIPINJAM.', transaction });
}));

app.post('/api/security/transactions/:id/return', requireSecurity, asyncRoute(async (req, res) => {
  const transaction = transactions.find((item) => item.id === req.params.id);

  if (!transaction) {
    return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
  }

  const securityId = String(req.body.security_id || '');
  const security = securities.find((item) => item.id === securityId && item.is_active);

  if (!security) {
    return res.status(400).json({ message: 'Pilih security aktif yang menerima pengembalian.' });
  }

  transaction.status = 'DIKEMBALIKAN';
  transaction.received_by_security_id = securityId;
  transaction.received_by_security_name = security.name;
  transaction.returned_at = new Date().toISOString();
  recordActivity({
    action: 'Kunci dikembalikan',
    actorRole: 'security',
    actorName: security.name,
    description: `${security.name} menerima pengembalian kunci dari ${transaction.borrower_name}: ${(transaction.room_names || []).join(', ')}.`,
    timestamp: transaction.returned_at,
  });

  transaction.rooms.forEach((roomId) => {
    const room = rooms.find((item) => item.id === roomId);
    if (room) room.status = 'AVAILABLE';
  });

  await persistState();
  refreshRealtime();
  return res.json({ message: 'Kunci berhasil dikembalikan dan dipulihkan.', transaction });
}));

app.post('/api/admin/rooms', requireAdmin, asyncRoute(async (req, res) => {
  const roomName = String(req.body.room_name || '').trim();

  if (!roomName) {
    return res.status(400).json({ message: 'Nama ruangan wajib diisi.' });
  }

  const exists = rooms.some((room) => room.room_name.toLowerCase() === roomName.toLowerCase());
  if (exists) {
    return res.status(409).json({ message: 'Ruangan sudah ada di database.' });
  }

  const room = {
    id: createId('room'),
    room_name: roomName,
    status: 'AVAILABLE',
    is_active: true,
  };

  rooms.push(room);
  recordActivity({
    action: 'Ruangan ditambahkan',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin menambahkan ruangan "${roomName}".`,
  });
  await persistState();
  refreshRealtime();
  return res.status(201).json({ message: 'Ruangan berhasil ditambahkan.', room });
}));

app.put('/api/admin/rooms/:id', requireAdmin, asyncRoute(async (req, res) => {
  const room = rooms.find((item) => item.id === req.params.id);
  const roomName = String(req.body.room_name || '').trim();

  if (!room) {
    return res.status(404).json({ message: 'Ruangan tidak ditemukan.' });
  }

  if (!roomName) {
    return res.status(400).json({ message: 'Nama ruangan wajib diisi.' });
  }

  const duplicate = rooms.some(
    (item) => item.id !== room.id && item.room_name.toLowerCase() === roomName.toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ message: 'Ruangan dengan nama tersebut sudah ada.' });
  }

  const previousName = room.room_name;
  room.room_name = roomName;
  recordActivity({
    action: 'Ruangan diperbarui',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin mengubah nama ruangan dari "${previousName}" menjadi "${roomName}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Nama ruangan berhasil diperbarui.', room });
}));

app.delete('/api/admin/rooms/:id', requireAdmin, asyncRoute(async (req, res) => {
  const room = rooms.find((item) => item.id === req.params.id);
  if (!room) {
    return res.status(404).json({ message: 'Ruangan tidak ditemukan.' });
  }
  if (!room.is_active) {
    return res.status(409).json({ message: 'Ruangan sudah dinonaktifkan.' });
  }
  if (room.status === 'BORROWED') {
    return res.status(409).json({ message: 'Ruangan sedang dipinjam atau memiliki permintaan aktif, sehingga tidak dapat dinonaktifkan.' });
  }

  room.is_active = false;
  recordActivity({
    action: 'Ruangan dinonaktifkan',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin menonaktifkan ruangan "${room.room_name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Ruangan berhasil dinonaktifkan.' });
}));

app.post('/api/admin/rooms/:id/reactivate', requireAdmin, asyncRoute(async (req, res) => {
  const room = rooms.find((item) => item.id === req.params.id);
  if (!room) {
    return res.status(404).json({ message: 'Ruangan tidak ditemukan.' });
  }
  if (room.is_active) {
    return res.status(409).json({ message: 'Ruangan sudah aktif.' });
  }

  room.is_active = true;
  recordActivity({
    action: 'Ruangan diaktifkan kembali',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin mengaktifkan kembali ruangan "${room.room_name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Ruangan berhasil diaktifkan kembali.' });
}));

app.post('/api/admin/security', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({ message: 'Nama security wajib diisi.' });
  }

  const exists = securities.some(
    (item) => item.is_active && item.name.toLowerCase() === name.toLowerCase()
  );
  if (exists) {
    return res.status(409).json({ message: 'Security aktif dengan nama yang sama sudah ada.' });
  }

  const security = {
    id: createId('sec'),
    name,
    is_active: true,
  };

  securities.push(security);
  recordActivity({
    action: 'Security ditambahkan',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin menambahkan security "${name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.status(201).json({ message: 'Petugas keamanan berhasil ditambahkan.', security });
}));

app.patch('/api/admin/security/:id', requireAdmin, asyncRoute(async (req, res) => {
  const security = securities.find((item) => item.id === req.params.id);
  const name = String(req.body.name || '').trim();

  if (!security) {
    return res.status(404).json({ message: 'Security tidak ditemukan.' });
  }

  if (!name) {
    return res.status(400).json({ message: 'Nama security wajib diisi.' });
  }

  const duplicate = securities.some(
    (item) => item.id !== security.id && item.is_active && item.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ message: 'Security aktif dengan nama tersebut sudah ada.' });
  }

  transactions.forEach((transaction) => {
    if (transaction.issued_by_security_id === security.id && !transaction.issued_by_security_name) {
      transaction.issued_by_security_name = security.name;
    }
    if (transaction.received_by_security_id === security.id && !transaction.received_by_security_name) {
      transaction.received_by_security_name = security.name;
    }
  });

  const previousName = security.name;
  security.name = name;
  recordActivity({
    action: 'Security diperbarui',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin mengubah nama security dari "${previousName}" menjadi "${name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Nama security berhasil diperbarui.', security });
}));

app.delete('/api/admin/security/:id', requireAdmin, asyncRoute(async (req, res) => {
  const security = securities.find((item) => item.id === req.params.id);

  if (!security) {
    return res.status(404).json({ message: 'Security tidak ditemukan.' });
  }

  if (!security.is_active) {
    return res.status(409).json({ message: 'Security sudah dinonaktifkan.' });
  }

  security.is_active = false;
  recordActivity({
    action: 'Security dinonaktifkan',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin menonaktifkan security "${security.name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Security berhasil dinonaktifkan.' });
}));

app.post('/api/admin/security/:id/reactivate', requireAdmin, asyncRoute(async (req, res) => {
  const security = securities.find((item) => item.id === req.params.id);

  if (!security) {
    return res.status(404).json({ message: 'Security tidak ditemukan.' });
  }

  if (security.is_active) {
    return res.status(409).json({ message: 'Security sudah aktif.' });
  }

  const duplicate = securities.some(
    (item) => item.is_active && item.name.toLowerCase() === security.name.toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ message: 'Security aktif dengan nama yang sama sudah ada.' });
  }

  security.is_active = true;
  recordActivity({
    action: 'Security diaktifkan kembali',
    actorRole: 'admin',
    actorName: 'Admin',
    description: `Admin mengaktifkan kembali security "${security.name}".`,
  });
  await persistState();
  refreshRealtime();
  return res.json({ message: 'Security berhasil diaktifkan kembali.' });
}));

app.post('/api/admin/security-pin', requireAdmin, asyncRoute(async (req, res) => {
  const pin = String(req.body.pin || '').trim();

  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ message: 'PIN security harus terdiri dari 6 digit angka.' });
  }

  securityPin = hashPin(pin);
  recordActivity({
    action: 'PIN security direset',
    actorRole: 'admin',
    actorName: 'Admin',
    description: 'Admin mengubah PIN bersama security.',
  });
  await persistState();
  return res.json({ message: 'PIN security bersama berhasil diperbarui.' });
}));

app.post('/api/admin/admin-pin', requireAdmin, asyncRoute(async (req, res) => {
  const pin = String(req.body.pin || '').trim();

  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ message: 'PIN admin harus terdiri dari 6 digit angka.' });
  }

  adminPin = hashPin(pin);
  recordActivity({
    action: 'PIN admin direset',
    actorRole: 'admin',
    actorName: 'Admin',
    description: 'Admin mengubah PIN untuk login panel admin.',
  });
  await persistState();
  return res.json({ message: 'PIN admin berhasil diperbarui.' });
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'Endpoint tidak ditemukan.' });
  }
  return res.status(404).render('404');
});

app.use((error, req, res, next) => {
  console.error(`Request failed for ${req.method} ${req.path}:`, error);
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ message: 'Terjadi kesalahan saat menyimpan atau memuat data.' });
  }
  return res.status(500).render('500');
});

io.on('connection', (socket) => {
  socket.emit('dashboard:update', {
    rooms: activeRooms(),
    transactions: activeTransactions(),
    securities: serializeSecurities(),
  });
});

initializeDatabase()
  .then(() => {
    server.listen(port, () => {
      console.log(`Digital Key Log running on http://localhost:${port}`);
    });
  })
  .catch(async (error) => {
    console.error('Failed to initialize PostgreSQL:', error);
    await dbPool.end();
    process.exitCode = 1;
  });
