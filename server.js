const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// DB Pool
const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10
});

// --- API ROUTES ---

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (err) return res.json({ success: false });
        if (result.length > 0) {
            db.query('UPDATE users SET last_active=NOW() WHERE id=?', [result[0].id]);
            res.json({ success: true, user: result[0] });
        } else {
            res.json({ success: false, message: 'Invalid Login' });
        }
    });
});

// Get User Details for Account Page
app.post('/api/user-details', (req, res) => {
    db.query('SELECT *, (balance * 100) as balance_inr FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// Get All Users (Downline) & Activity
app.post('/api/my-users', (req, res) => {
    db.query(
        `SELECT id, username, role, balance, total_wins, total_losses,
        CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
        FROM users WHERE parent_id=?`,
        [req.body.parentId],
        (_, r) => res.json({ users: r || [] })
    );
});

// The Winning Spread Logic (Upline Commission Chain)
app.post('/api/process-win', (req, res) => {
    const { userId, winAmount } = req.body; // winAmount in chips
    const commissionRates = { 'SuperAdmin': 0.08, 'Admin': 0.06, 'SuperMaster': 0.05, 'Master': 0.04, 'Agent': 0.02 };

    db.getConnection((err, conn) => {
        conn.beginTransaction(async () => {
            // 1. Credit the winner
            conn.query('UPDATE users SET balance = balance + ?, total_wins = total_wins + ? WHERE id = ?', [winAmount, winAmount, userId]);

            // 2. Recursive function to pay all upper levels
            const payUpline = (childId) => {
                conn.query('SELECT parent_id FROM users WHERE id = ?', [childId], (err, results) => {
                    if (results.length > 0 && results[0].parent_id) {
                        const pid = results[0].parent_id;
                        conn.query('SELECT id, role, parent_id FROM users WHERE id = ?', [pid], (err, pData) => {
                            if (pData.length > 0) {
                                const parent = pData[0];
                                const rate = commissionRates[parent.role] || 0;
                                const comm = winAmount * rate;
                                
                                if(comm > 0) conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [comm, parent.id]);
                                
                                if(parent.role !== 'SuperAdmin') payUpline(parent.id);
                                else conn.commit(() => { res.json({ success: true }); conn.release(); });
                            }
                        });
                    } else {
                        conn.commit(() => { res.json({ success: true }); conn.release(); });
                    }
                });
            };
            payUpline(userId);
        });
    });
});

// Chip Transfer / Give
app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, senderId, amount], (err, res1) => {
        if (res1.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, receiverId], () => {
                res.json({ success: true, message: 'Chips Sent' });
            });
        } else {
            res.json({ success: false, message: 'Insufficient Balance' });
        }
    });
});

// Take Back Chips (SuperAdmin only)
app.post('/api/take-back-chips', (req, res) => {
    const { adminId, userId } = req.body;
    db.query('SELECT balance FROM users WHERE id=?', [userId], (e, r) => {
        const amt = r[0].balance;
        db.query('UPDATE users SET balance = 0 WHERE id=?', [userId], () => {
            db.query('UPDATE users SET balance = balance + ? WHERE id=?', [amt, adminId], () => {
                res.json({ success: true, recovered: amt });
            });
        });
    });
});

app.post('/api/create-user', (req, res) => {
    const { newUsername, newPassword, newRole, creatorId } = req.body;
    db.query('INSERT INTO users(username, password, role, parent_id, balance) VALUES(?,?,?,?,0)', 
    [newUsername, newPassword, newRole, creatorId], (err) => {
        res.json({ success: !err, message: err ? 'Error creating user' : 'User Created' });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
