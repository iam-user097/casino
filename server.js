const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path'); // Added path module

const app = express();
app.use(cors());
app.use(express.json());

// ----------- 1. Serve Frontend Files -----------
// This tells Node to use the 'public' folder for static files
app.use(express.static(path.join(__dirname, 'public')));

// Route: Open Login page by default
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Route: Open Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


// ----------- MySQL Pool -----------
const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test DB connection
db.getConnection((err, connection) => {
    if (err) console.error('❌ MySQL Connection Error:', err.message);
    else {
        console.log('✅ MySQL Connected');
        connection.release();
    }
});

// ----------- API ROUTES (Your existing code) -----------

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.query(
    'SELECT * FROM users WHERE username=? AND password=?',
    [username, password],
    (err, result) => {
      if (err) return res.json({ success: false, error: err.message });
      if (result.length > 0) {
        db.query('UPDATE users SET last_active=NOW() WHERE id=?', [result[0].id]);
        res.json({ success: true, user: result[0] });
      } else {
        res.json({ success: false, message: 'Invalid credentials' });
      }
    }
  );
});

// Get user details
app.post('/api/user-details', (req, res) => {
  db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
    r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
  });
});

// Get my users
app.post('/api/my-users', (req, res) => {
  db.query(
    `SELECT id, username, role, balance,
      CASE WHEN last_active >= NOW()-INTERVAL 5 MINUTE
      THEN 'Online' ELSE 'Offline' END status
      FROM users WHERE parent_id=?`,
    [req.body.parentId],
    (_, r) => res.json({ users: r })
  );
});

// Create user
app.post('/api/create-user', (req, res) => {
  const { newUsername, newPassword, newRole, creatorId } = req.body;
  db.query(
    'INSERT INTO users(username,password,role,parent_id) VALUES(?,?,?,?)',
    [newUsername, newPassword, newRole, creatorId],
    err => {
      if (err) res.json({ success: false, message: 'Username exists or error' });
      else res.json({ success: true, message: 'User created' });
    }
  );
});

// Transfer credits
app.post('/api/transfer-credits', (req, res) => {
  const { senderId, receiverId, amount } = req.body;
  db.getConnection((err, connection) => {
    if (err) return res.json({ success: false, message: err.message });
    connection.beginTransaction(err => {
      if (err) return res.json({ success: false, message: err.message });
      connection.query(
        'UPDATE users SET balance=balance-? WHERE id=?',
        [amount, senderId],
        (err) => {
          if (err) return connection.rollback(() => res.json({ success: false, message: err.message }));
          connection.query(
            'UPDATE users SET balance=balance+? WHERE id=?',
            [amount, receiverId],
            (err) => {
              if (err) return connection.rollback(() => res.json({ success: false, message: err.message }));
              connection.commit(err => {
                if (err) return connection.rollback(() => res.json({ success: false, message: err.message }));
                res.json({ success: true, message: 'Transfer done' });
                connection.release();
              });
            }
          );
        }
      );
    });
  });
});

// ----------- START SERVER -----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));