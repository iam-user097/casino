require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= STATIC PAGES =================
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

// ================= DATABASE =================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 20
});
const pdb = db.promise();

// ================= SUPERADMIN =================
async function ensureSuperAdmin() {
  try {
    const [r] = await pdb.query('SELECT id FROM users WHERE id=1');
    if (!r.length) {
      await pdb.query(`
        INSERT INTO users
        (id, username, first_name, password, role, balance, inr_balance, commission_percentage)
        VALUES (1,'sadmin','Main Holder','123456','SuperAdmin',100000,1000000,10)
      `);
      console.log('✅ SuperAdmin created');
    }
  } catch (e) {
    console.error('SuperAdmin check error:', e);
  }
}
ensureSuperAdmin();

// ================= GLOBAL =================
let activeBets = [];
const DEFAULT_PASSWORDS = [
  '123456','112233','223344','666666','665544','000000',
  '012345','123654','321456','654321',
  '111111','222222','333333','444444','555555',
  '000111','111000'
];

// ================= LOGIN =================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await pdb.query(
      'SELECT * FROM users WHERE username=?',
      [username]
    );
    if (!rows.length)
      return res.json({ success: false, message: 'Invalid credentials' });

    const user = rows[0];
    if (user.password !== password)
      return res.json({ success: false, message: 'Invalid credentials' });

    const force =
      user.role !== 'SuperAdmin' && DEFAULT_PASSWORDS.includes(password) ? 1 : 0;

    await pdb.query(
      'UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?',
      [force, user.id]
    );

    res.json({
      success: true,
      user: { ...user, force_password_change: force }
    });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: 'Login error' });
  }
});

// ================= UPDATE PASSWORD =================
app.post('/api/update-password-secure', async (req, res) => {
  try {
    const { userId, newPass } = req.body;

    await pdb.query(
      'UPDATE users SET password=?, force_password_change=0 WHERE id=?',
      [newPass, userId]
    );

    res.json({ success: true, message: 'PIN updated successfully ✅' });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= USER DETAILS =================
app.post('/api/user-details', async (req, res) => {
  try {
    const [r] = await pdb.query(
      'SELECT * FROM users WHERE id=?',
      [req.body.id]
    );

    if (!r.length)
      return res.json({ success: false, message: 'User not found' });

    res.json({ success: true, data: r[0] });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= CREATE USER =================
app.post('/api/create-user-advanced', async (req, res) => {
  const { uName, fullName, pass, role, commission, deposit, creatorId } = req.body;
  const conn = await pdb.getConnection();

  try {
    await conn.beginTransaction();

    if (creatorId != 1) {
      const [d] = await conn.query(
        'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
        [deposit, deposit, creatorId, deposit]
      );
      if (!d.affectedRows)
        throw new Error('Insufficient balance');
    }

    const [u] = await conn.query(`
      INSERT INTO users
      (username, first_name, password, role, commission_percentage, parent_id, balance, inr_balance)
      VALUES (?,?,?,?,?,?,?,?)
    `, [uName, fullName, pass, role, commission, creatorId, deposit, deposit * 10]);

    await conn.query(
      'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
      [u.insertId, 'TRANSFER_IN', deposit, 'Initial Chips']
    );

    await conn.commit();
    res.json({ success: true, message: 'User created ✅' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
});

// ================= USERS LIST =================
app.post('/api/my-users', async (req, res) => {
  const { parentId, role } = req.body;

  try {
    let rows;

    if (role === 'SuperAdmin') {
      [rows] = await pdb.query(
        'SELECT * FROM users WHERE id!=1 ORDER BY id DESC'
      );
    } else {
      [rows] = await pdb.query(
        'SELECT * FROM users WHERE parent_id=? ORDER BY id DESC',
        [parentId]
      );
    }

    res.json({ success: true, users: rows });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= DELETE USER =================
app.post('/api/delete-user', async (req, res) => {
  try {
    const { targetId } = req.body;

    if (targetId == 1)
      return res.json({ success: false, message: 'Cannot delete SuperAdmin' });

    await pdb.query('DELETE FROM transactions WHERE user_id=?', [targetId]);
    await pdb.query('DELETE FROM users WHERE id=?', [targetId]);

    res.json({ success: true, message: 'User deleted ✅' });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= TRANSFER =================
app.post('/api/transfer-credits', async (req, res) => {
  const { senderId, receiverId, amount } = req.body;
  const conn = await pdb.getConnection();

  try {
    await conn.beginTransaction();

    const [d] = await conn.query(
      'UPDATE users SET balance=balance-? WHERE id=? AND balance>=?',
      [amount, senderId, amount]
    );
    if (!d.affectedRows)
      throw new Error('Insufficient balance');

    await conn.query(
      'UPDATE users SET balance=balance+? WHERE id=?',
      [amount, receiverId]
    );

    await conn.commit();
    res.json({ success: true, message: 'Transfer successful ✅' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.json({ success: false });
  } finally {
    conn.release();
  }
});

// ================= HISTORY =================
app.post('/api/user-history', async (req, res) => {
  try {
    const [r] = await pdb.query(
      'SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC',
      [req.body.userId]
    );
    res.json({ success: true, data: r });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 SERVER LIVE @ ${PORT}`)
);
