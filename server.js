const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ----------- 1. Serve Frontend Files -----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ----------- 2. MySQL Pool -----------
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

// ----------- 3. API ROUTES -----------

// Login with Activity Tracking
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query(
        'SELECT * FROM users WHERE username=? AND password=?',
        [username, password],
        (err, result) => {
            if (err) return res.json({ success: false, error: err.message });
            if (result.length > 0) {
                // Update last_active every time they login
                db.query('UPDATE users SET last_active=NOW() WHERE id=?', [result[0].id]);
                res.json({ success: true, user: result[0] });
            } else {
                res.json({ success: false, message: 'Invalid credentials' });
            }
        }
    );
});

// Get User Details (Chips, Role, etc.)
app.post('/api/user-details', (req, res) => {
    db.query('SELECT id, username, role, balance, parent_id FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// Get User List (Shows Online/Offline Status)
app.post('/api/my-users', (req, res) => {
    db.query(
        `SELECT id, username, role, balance, 
        CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE 
        THEN 'Online' ELSE 'Offline' END AS status 
        FROM users WHERE parent_id=?`,
        [req.body.parentId],
        (_, r) => res.json({ users: r || [] })
    );
});

// Create User
app.post('/api/create-user', (req, res) => {
    const { newUsername, newPassword, newRole, creatorId } = req.body;
    db.query(
        'INSERT INTO users(username, password, role, parent_id, balance) VALUES(?,?,?,?, 0)',
        [newUsername, newPassword, newRole, creatorId],
        err => {
            if (err) res.json({ success: false, message: 'Username exists or DB error' });
            else res.json({ success: true, message: 'User created successfully' });
        }
    );
});

// ADVANCED: Transfer Chips (Subtract from Admin, Add to User)
app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const transferAmount = parseFloat(amount);

    db.getConnection((err, connection) => {
        if (err) return res.json({ success: false, message: 'DB Connection Error' });

        connection.beginTransaction(err => {
            if (err) return res.json({ success: false, message: 'Transaction Error' });

            // 1. Check Sender Balance
            connection.query('SELECT balance FROM users WHERE id = ?', [senderId], (err, results) => {
                if (err || results.length === 0 || results[0].balance < transferAmount) {
                    return connection.rollback(() => {
                        res.json({ success: false, message: 'Insufficient chips in your account' });
                        connection.release();
                    });
                }

                // 2. Subtract from Sender
                connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [transferAmount, senderId], (err) => {
                    if (err) return connection.rollback(() => { res.json({ success: false }); connection.release(); });

                    // 3. Add to Receiver
                    connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [transferAmount, receiverId], (err) => {
                        if (err) return connection.rollback(() => { res.json({ success: false }); connection.release(); });

                        connection.commit(err => {
                            if (err) return connection.rollback(() => { res.json({ success: false }); connection.release(); });
                            res.json({ success: true, message: 'Chips Transferred' });
                            connection.release();
                        });
                    });
                });
            });
        });
    });
});

// SUPERADMIN ONLY: Take Back Remaining Chips
app.post('/api/take-back-chips', (req, res) => {
    const { adminId, userId } = req.body;

    db.getConnection((err, connection) => {
        connection.beginTransaction(err => {
            // 1. Get user's current balance
            connection.query('SELECT balance FROM users WHERE id = ?', [userId], (err, results) => {
                const chipsToRecover = results[0].balance;

                // 2. Reset user to 0
                connection.query('UPDATE users SET balance = 0 WHERE id = ?', [userId], (err) => {
                    // 3. Give chips back to SuperAdmin
                    connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [chipsToRecover, adminId], (err) => {
                        connection.commit(() => {
                            res.json({ success: true, recovered: chipsToRecover });
                            connection.release();
                        });
                    });
                });
            });
        });
    });
});

// ----------- START SERVER -----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Casino Backend running on port ${PORT}`));
