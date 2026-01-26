const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const app = express();

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'panel',
  waitForConnections: true,
  connectionLimit: 10
});

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= LOGIN =================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const [rows] = await db.query(
      'SELECT * FROM users WHERE username=? AND password=?',
      [username, password]
    );

    if (!rows.length)
      return res.json({ success: false, msg: 'Invalid credentials' });

    await db.query(
      'UPDATE users SET last_active=NOW() WHERE id=?',
      [rows[0].id]
    );

    res.json({ success: true, user: rows[0] });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= CREATE USER =================
app.post('/api/create-user-advanced', async (req, res) => {
  const { creatorId, username, password, role, deposit } = req.body;

  try {
    const [creator] = await db.query(
      'SELECT * FROM users WHERE id=?',
      [creatorId]
    );

    if (!creator.length)
      return res.json({ success: false, msg: 'Creator not found' });

    if (creator[0].balance < deposit)
      return res.json({ success: false, msg: 'Insufficient balance' });

    await db.query(
      `INSERT INTO users
       (username,password,role,balance,parent_id,created_at)
       VALUES (?,?,?,?,?,NOW())`,
      [username, password, role, deposit, creatorId]
    );

    await db.query(
      'UPDATE users SET balance=balance-? WHERE id=?',
      [deposit, creatorId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= USERS LIST =================
app.post('/api/my-users', async (req, res) => {
  const { parentId, role } = req.body;

  try {
    let rows;

    if (role === 'SuperAdmin') {
      [rows] = await db.query(`
        SELECT *,
        IF(last_active > NOW() - INTERVAL 5 MINUTE,'Online','Offline') AS status
        FROM users
        WHERE id != 1
        ORDER BY id DESC
      `);
    } else {
      [rows] = await db.query(`
        SELECT *,
        IF(last_active > NOW() - INTERVAL 5 MINUTE,'Online','Offline') AS status
        FROM users
        WHERE parent_id=?
        ORDER BY id DESC
      `, [parentId]);
    }

    res.json({ success: true, users: rows });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= EDIT USER =================
app.post('/api/edit-user', async (req, res) => {
  const { id, username, commission } = req.body;

  try {
    await db.query(
      'UPDATE users SET username=?, commission_percentage=? WHERE id=?',
      [username, commission, id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= DELETE USER =================
app.post('/api/delete-user', async (req, res) => {
  const { userId, requesterId, requesterRole } = req.body;

  try {
    // ❌ prevent self delete
    if (userId === requesterId)
      return res.json({ success: false, msg: 'Cannot delete yourself' });

    // check target user
    const [target] = await db.query(
      'SELECT * FROM users WHERE id=?',
      [userId]
    );

    if (!target.length)
      return res.json({ success: false, msg: 'User not found' });

    // check ownership
    if (requesterRole !== 'SuperAdmin' &&
        target[0].parent_id !== requesterId)
      return res.json({ success: false, msg: 'Permission denied' });

    // ❌ block delete if user has downline
    const [child] = await db.query(
      'SELECT id FROM users WHERE parent_id=? LIMIT 1',
      [userId]
    );

    if (child.length)
      return res.json({ success: false, msg: 'User has downline' });

    await db.query('DELETE FROM users WHERE id=?', [userId]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= DEPOSIT =================
app.post('/api/deposit', async (req, res) => {
  const { fromId, toId, amount } = req.body;

  try {
    const [from] = await db.query(
      'SELECT balance FROM users WHERE id=?',
      [fromId]
    );

    if (from[0].balance < amount)
      return res.json({ success: false });

    await db.query('UPDATE users SET balance=balance-? WHERE id=?',
      [amount, fromId]);

    await db.query('UPDATE users SET balance=balance+? WHERE id=?',
      [amount, toId]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= WITHDRAW =================
app.post('/api/withdraw', async (req, res) => {
  const { fromId, toId, amount } = req.body;

  try {
    const [to] = await db.query(
      'SELECT balance FROM users WHERE id=?',
      [toId]
    );

    if (to[0].balance < amount)
      return res.json({ success: false });

    await db.query('UPDATE users SET balance=balance-? WHERE id=?',
      [amount, toId]);

    await db.query('UPDATE users SET balance=balance+? WHERE id=?',
      [amount, fromId]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= STATIC ROUTES =================
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/index.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/dashboard.html'))
);

// ================= START SERVER =================
app.listen(PORT, () =>
  console.log('Server running on port ' + PORT)
);
