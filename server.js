const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE CONNECTION ---
const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    connectionLimit: 10
});

// Helper: Log Transaction with 1:10 logic
const logTx = (uid, type, amt, desc) => {
    db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', 
    [uid, type, amt, desc]);
};

// --- AUTH & USER DETAILS ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (result && result.length > 0) {
            const user = result[0];
            db.query('UPDATE users SET last_active=NOW() WHERE id=?', [user.id]);
            res.json({ success: true, user });
        } else res.json({ success: false });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// --- USER MANAGEMENT (HIERARCHY) ---
app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, role, balance, exposure, commission_percentage,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users`;
    let params = [];
    if (role !== 'SuperAdmin') {
        query += ` WHERE parent_id = ?`;
        params.push(parentId);
    }
    db.query(query, params, (_, r) => res.json({ users: r || [] }));
});

app.post('/api/create-user-advanced', (req, res) => {
    const { uName, pass, role, deposit, commission, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const comm = parseFloat(commission) || 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            const sql = `INSERT INTO users(username, password, role, parent_id, balance, commission_percentage) VALUES(?,?,?,?,?,?)`;
            conn.query(sql, [uName, pass, role, creatorId, depAmt, comm], (err, result) => {
                if (err) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Username exists' }); });
                
                if (depAmt > 0) {
                    conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [depAmt, creatorId], () => {
                        logTx(creatorId, 'Setup', -depAmt, `User setup: ${uName} (${comm}%)`);
                        conn.commit(() => { conn.release(); res.json({ success: true }); });
                    });
                } else conn.commit(() => { conn.release(); res.json({ success: true }); });
            });
        });
    });
});

// --- FINANCIALS ---
app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amt, senderId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, receiverId], () => {
                logTx(senderId, 'Sent', -amt, `Sent to ID: ${receiverId}`);
                logTx(receiverId, 'Received', amt, `Received from ID: ${senderId}`);
                res.json({ success: true, message: 'Transfer Success' });
            });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

app.post('/api/withdraw-chips', (req, res) => {
    const { adminId, userId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amt, userId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, adminId]);
            logTx(userId, 'Withdrawal', -amt, `Recovered by Admin`);
            logTx(adminId, 'Clawback', amt, `Withdrew from ID: ${userId}`);
            res.json({ success: true, message: 'Withdrawal Success' });
        } else res.json({ success: false, message: 'Insufficient User Balance' });
    });
});

// --- LIVE BETTING & COMMISSION ENGINE ---
app.post('/api/place-bet', (req, res) => {
    const { userId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('SELECT role, balance FROM users WHERE id = ?', [userId], (e, r) => {
        if (r[0].role !== 'Client') return res.json({ success: false, message: 'Only Clients can bet' });
        
        db.query('UPDATE users SET balance = balance - ?, exposure = exposure + ? WHERE id = ? AND balance >= ?', 
        [amt, amt, userId, amt], (err, r2) => {
            if (r2 && r2.affectedRows > 0) {
                logTx(userId, 'Bet Active', -amt, 'Chips moved to Exposure');
                res.json({ success: true });
            } else res.json({ success: false, message: 'Insufficient Balance' });
        });
    });
});

app.post('/api/settle-bet', (req, res) => {
    const { userId, amount, isWin, odds } = req.body;
    const amt = parseFloat(amount);
    const profit = isWin ? (amt * parseFloat(odds)) - amt : 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            if (isWin) {
                // 1. Pay Client
                conn.query('UPDATE users SET exposure = exposure - ?, balance = balance + ?, total_wins = total_wins + 1 WHERE id = ?', 
                [amt, amt + profit, userId]);
                logTx(userId, 'Win', profit, `Live Bet Won (Odds: ${odds})`);

                // 2. Recursive Commission Distribution
                const distribute = (currentId) => {
                    conn.query('SELECT parent_id FROM users WHERE id = ?', [currentId], (e, pRes) => {
                        if (pRes && pRes[0]?.parent_id) {
                            const pid = pRes[0].parent_id;
                            conn.query('SELECT id, role, commission_percentage FROM users WHERE id = ?', [pid], (e, pData) => {
                                if (pData && pData[0]) {
                                    const parent = pData[0];
                                    const share = profit * (parent.commission_percentage / 100);
                                    
                                    if (share > 0) {
                                        conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [share, parent.id]);
                                        logTx(parent.id, 'Comm-Income', share, `Downline Profit Share (${parent.role})`);
                                    }
                                    
                                    if (parent.role !== 'SuperAdmin') distribute(parent.id);
                                    else conn.commit(() => conn.release());
                                } else conn.commit(() => conn.release());
                            });
                        } else conn.commit(() => conn.release());
                    });
                };
                distribute(userId);
            } else {
                // 3. Handle Loss
                conn.query('UPDATE users SET exposure = exposure - ?, total_losses = total_losses + 1 WHERE id = ?', [amt, userId]);
                logTx(userId, 'Loss', -amt, 'Live Bet Lost');
                conn.commit(() => conn.release());
            }
        });
    });
    res.json({ success: true });
});

// --- GLOBAL HISTORY ---
app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', 
    [req.body.userId], (_, r) => res.json({ success: true, history: r || [] }));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Magic9 Global Server Live on ${PORT}`));
