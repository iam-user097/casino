const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// FORCE ROUTE: Send login.html when user visits the base URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// FORCE ROUTE: Send dashboard.html
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// MySQL Pool
const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10
});

// Helper function for Transaction Logging
const logTx = (uid, type, amt, desc) => {
    db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [uid, type, amt, desc]);
};

// --- API ROUTES ---

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

app.post('/api/user-details', (req, res) => {
    // 1 Chip = 1 RS Logic: Select actual balance and inr_balance separately
    db.query('SELECT *, balance, inr_balance FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    
    // GLOBAL VISIBILITY: SuperAdmin sees everyone. Others see direct downlines.
    let query = `SELECT id, username, role, balance, exposure, total_wins, total_losses,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users`;
    
    let params = [];
    if (role === 'SuperAdmin') {
        query += ` WHERE role != 'SuperAdmin'`; 
    } else {
        query += ` WHERE parent_id = ?`;
        params.push(parentId);
    }

    db.query(query, params, (_, r) => res.json({ users: r || [] }));
});

// Get Transaction History
app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [req.body.userId], (_, r) => res.json({ history: r || [] }));
});

// Exposure Wallet Logic
app.post('/api/add-exposure', (req, res) => {
    const { userId, amount } = req.body;
    const amt = parseFloat(amount);
    if (amt < 1000) return res.json({ success: false, message: 'Min 1000 required' });

    db.query('UPDATE users SET balance = balance - ?, exposure = exposure + ? WHERE id = ? AND balance >= ?', 
    [amt, amt, userId, amt], (err, result) => {
        if (result && result.affectedRows > 0) {
            logTx(userId, 'Exposure', -amt, 'Deposited to Exposure Wallet');
            res.json({ success: true, message: 'Exposure Updated' });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

// Place Bet & Recursive Spread (Commission Chain)
app.post('/api/place-bet', (req, res) => {
    const { userId, betAmount, isWin } = req.body;
    const amt = parseFloat(betAmount);
    const rates = { 'SuperAdmin': 0.08, 'Admin': 0.06, 'SuperMaster': 0.05, 'Master': 0.04, 'Agent': 0.02 };

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            if (isWin) {
                const profit = amt; 
                // FIXED: profit is now added to BOTH balance (chips) and inr_balance (money)
                conn.query('UPDATE users SET exposure = exposure - ?, balance = balance + ?, inr_balance = inr_balance + ?, total_wins = total_wins + ? WHERE id = ?', 
                [amt, amt + profit, profit, profit, userId]);
                
                logTx(userId, 'Win', profit, `Bet Win: Chips & INR updated`);

                const spread = (childId) => {
                    conn.query('SELECT parent_id FROM users WHERE id = ?', [childId], (err, res) => {
                        if (res[0]?.parent_id) {
                            const pid = res[0].parent_id;
                            conn.query('SELECT id, role FROM users WHERE id = ?', [pid], (err, pData) => {
                                const parent = pData[0];
                                const comm = profit * (rates[parent.role] || 0);
                                if (comm > 0) {
                                    // Commissions are also added to both chips and INR for uplines
                                    conn.query('UPDATE users SET balance = balance + ?, inr_balance = inr_balance + ? WHERE id = ?', [comm, comm, parent.id]);
                                    logTx(parent.id, 'Commission', comm, `Commission from downline win`);
                                }
                                if (parent.role !== 'SuperAdmin') spread(parent.id);
                                else conn.commit(() => { conn.release(); });
                            });
                        } else { conn.commit(() => { conn.release(); }); }
                    });
                };
                spread(userId);
                res.json({ success: true });
            } else {
                conn.query('UPDATE users SET exposure = exposure - ?, total_losses = total_losses + ? WHERE id = ?', [amt, amt, userId], () => {
                    logTx(userId, 'Loss', -amt, 'Bet Loss');
                    conn.commit(() => { res.json({ success: true }); conn.release(); });
                });
            }
        });
    });
});

app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, senderId, amount], (err, res1) => {
        if (res1.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, receiverId], () => {
                logTx(senderId, 'Sent', -amount, `Transferred to User ID: ${receiverId}`);
                logTx(receiverId, 'Received', amount, `Received from User ID: ${senderId}`);
                res.json({ success: true, message: 'Transfer Success' });
            });
        } else {
            res.json({ success: false, message: 'Low Balance' });
        }
    });
});

// UPDATED: Take back only resets Chips (balance) to 0. INR Money remains safe.
app.post('/api/take-back-chips', (req, res) => {
    const { adminId, userId } = req.body;
    db.query('SELECT balance FROM users WHERE id=?', [userId], (e, r) => {
        if (e || !r.length) return res.json({ success: false });
        const amt = r[0].balance;
        
        db.query('UPDATE users SET balance = 0 WHERE id=?', [userId], () => {
            db.query('UPDATE users SET balance = balance + ? WHERE id=?', [amt, adminId], () => {
                logTx(adminId, 'Clawback', amt, `Took back chips from User ID: ${userId}`);
                logTx(userId, 'TakeBack', -amt, `Playable chips removed by SuperAdmin`);
                res.json({ success: true, recovered: amt });
            });
        });
    });
});

app.post('/api/create-user', (req, res) => {
    const { newUsername, newPassword, newRole, creatorId } = req.body;
    db.query('INSERT INTO users(username, password, role, parent_id, balance, inr_balance) VALUES(?,?,?,?,0,0)', 
    [newUsername, newPassword, newRole, creatorId], (err) => {
        res.json({ success: !err, message: err ? 'Error' : 'User Created' });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server Online`));

