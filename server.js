require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE CONNECTION POOL ---
const db = mysql.createPool({
  host: process.env.DB_HOST || "srv1952.hstgr.io",
  user: process.env.DB_USER || "u178691095_magic9",
  password: process.env.DB_PASSWORD || "Magic@097",
  database: process.env.DB_NAME || "u178691095_magic9_db",
  port: 3306,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

const promiseDb = db.promise();

// --- ENSURE SUPERADMIN (AUTO CREATE IF MISSING) ---
async function ensureSuperAdmin() {
  const [rows] = await promiseDb.query(
    "SELECT id FROM users WHERE id = 1 OR role = 'SuperAdmin' LIMIT 1"
  );

  if (rows.length === 0) {
    await promiseDb.query(`
      INSERT INTO users
      (id, username, first_name, password, role, balance, inr_balance, commission_percentage)
      VALUES
      (1, 'sadmin', 'Main Holder', '123456', 'SuperAdmin', 100000, 1000000, 10)
    `);
    console.log("✅ SuperAdmin CREATED (id=1)");
  } else {
    console.log("✅ SuperAdmin already exists");
  }
}

// --- DB HEARTBEAT ---
setInterval(() => {
  db.query('SELECT 1', err => {
    if (err) console.error("Heartbeat Error:", err);
  });
}, 30000);

// --- INIT ---
(async () => {
  try {
    await ensureSuperAdmin();
  } catch (err) {
    console.error("SuperAdmin Init Error:", err);
  }
})();

// --- STATE MANAGEMENT ---
let activeBets = [];
const defaultPasswords = [
  '123456','111111','222222','333333','444444',
  '555555','666666','000000','654321','112233',
  '123654','456321','543210','012345','332211'
];

// --- ROUTES ---
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

// --- LOGIN (DB BASED, SUPERADMIN SAFE) ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  db.query(
    'SELECT * FROM users WHERE username=? AND password=?',
    [username, password],
    (err, result) => {
      if (err) return res.status(500).json({ success: false });

      if (!result.length)
        return res.json({ success: false, message: "Invalid credentials" });

      const user = result[0];
      let forceFlag = user.force_password_change || 0;

      if (user.role !== 'SuperAdmin' && defaultPasswords.includes(password))
        forceFlag = 1;

      db.query(
        'UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?',
        [forceFlag, user.id]
      );

      res.json({
        success: true,
        user: { ...user, force_password_change: forceFlag }
      });
    }
  );
});

// --- UPDATE PASSWORD ---
app.post('/api/update-password-secure', (req, res) => {
  const { userId, newPass } = req.body;
  db.query(
    'UPDATE users SET password=?, force_password_change=0 WHERE id=?',
    [newPass, userId],
    err => {
      if (err) return res.json({ success: false });
      res.json({ success: true });
    }
  );
});

// --- USER DETAILS ---
app.post('/api/user-details', (req, res) => {
  db.query(
    'SELECT * FROM users WHERE id=?',
    [req.body.id],
    (e, r) => {
      (r && r.length)
        ? res.json({ success: true, data: r[0] })
        : res.json({ success: false });
    }
  );
});

// --- CREATE USER (ADVANCED) ---
app.post('/api/create-user-advanced', async (req, res) => {
  const { uName, fullName, pass, role, commission, deposit, creatorId } = req.body;
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();
    const dep = parseFloat(deposit) || 0;

    if (creatorId != 1) {
      const [deduct] = await conn.query(
        'UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?',
        [dep, dep, creatorId, dep]
      );
      if (deduct.affectedRows === 0)
        throw new Error("Insufficient creator balance");
    }

    const [result] = await conn.query(
      `INSERT INTO users
       (username, first_name, password, role, commission_percentage, parent_id, balance, inr_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uName, fullName, pass, role, commission, creatorId, dep, dep * 10]
    );

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "SENT", ?, ?)',
      [creatorId, -dep, `Created user ${uName}`]
    );

    await conn.query(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "RECEIVED", ?, ?)',
      [result.insertId, dep, `Initial chips from creator`]
    );

    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    res.json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
});

// --- BETTING ---
app.post('/api/place-bet-direct', (req, res) => {
  const { userId, amount, boxes, stakePerBox } = req.body;
  const totalStake = parseFloat(amount);

  db.query(
    'UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?',
    [totalStake, totalStake, userId, totalStake],
    (err, r) => {
      if (r && r.affectedRows > 0) {
        db.query(
          'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "BET PLACED", ?, ?)',
          [userId, -totalStake, `Stake on: ${boxes.join(',')}`]
        );
        activeBets.push({ userId, boxes, stakePerBox: parseFloat(stakePerBox) });
        res.json({ success: true });
      } else res.json({ success: false, message: 'Insufficient Balance' });
    }
  );
});

// --- SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server ${PORT} is ACTIVE`)
);
