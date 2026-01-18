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
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Helper: Standardized Transaction Logger (Always use inside a connection)
const logTxConn = (conn, uid, type, amt, desc) => {
    return conn.promise().query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [uid, type, amt, desc]);
};

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (result && result.length > 0) {
            db.query('UPDATE users SET last_active=NOW() WHERE id=?', [result[0].id]);
            res.json({ success: true, user: result[0] });
        } else res.json({ success: false });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, role, balance, exposure, commission_percentage,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users`;
    let params = [];
    if (role !== 'SuperAdmin') { query += ` WHERE parent_id = ?`; params.push(parentId); }
    db.query(query, params, (_, r) => res.json({ users: r || [] }));
});

app.post('/api/delete-user', (req, res) => {
    const { id } = req.body;
    db.getConnection((err, conn) => {
        if (err) return res.json({ success: false, message: 'Connection Error' });
        conn.beginTransaction(() => {
            conn.query('SELECT balance FROM users WHERE id = ?', [id], (e, r) => {
                if (r && r[0]?.balance > 0) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Withdraw chips first!' }); });
                conn.query('DELETE FROM transactions WHERE user_id = ?', [id], () => {
                    conn.query('DELETE FROM users WHERE id = ?', [id], (usrErr) => {
                        if (usrErr) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'User has downlines' }); });
                        conn.commit(() => { conn.release(); res.json({ success: true }); });
                    });
                });
            });
        });
    });
});

app.post('/api/create-user-advanced', (req, res) => {
    const { uName, pass, role, deposit, commission, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const comm = parseFloat(commission) || 0;
    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            const sql = `INSERT INTO users(username, password, role, parent_id, balance, commission_percentage) VALUES(?,?,?,?,?,?)`;
            conn.query(sql, [uName, pass, role, creatorId, depAmt, comm], (err) => {
                if (err) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Username exists' }); });
                if (depAmt > 0) {
                    conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [depAmt, creatorId], () => {
                        conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [creatorId, 'Setup', -depAmt, `Setup: ${uName}`], () => {
                            conn.commit(() => { conn.release(); res.json({ success: true }); });
                        });
                    });
                } else conn.commit(() => { conn.release(); res.json({ success: true }); });
            });
        });
    });
});

// --- SETTLEMENT ENGINE ---
app.post('/api/settle-bet', async (req, res) => {
    const { userId, amount, isWin, odds } = req.body;
    const amt = parseFloat(amount);
    const profit = isWin ? (amt * parseFloat(odds)) - amt : 0;

    const conn = db.promise();
    try {
        await conn.query('START TRANSACTION');
        const [userRows] = await conn.query('SELECT username FROM users WHERE id = ?', [userId]);
        const clientName = userRows[0].username;

        if (isWin) {
            await conn.query('UPDATE users SET exposure = exposure - ?, balance = balance + ?, total_wins = total_wins + 1 WHERE id = ?', [amt, amt + profit, userId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Win', profit, `Live Bet Won (Odds: ${odds})`]);

            // Upward Commission Loop
            let currentId = userId;
            while (true) {
                const [pRows] = await conn.query('SELECT parent_id FROM users WHERE id = ?', [currentId]);
                if (!pRows[0]?.parent_id) break;

                const pid = pRows[0].parent_id;
                const [pData] = await conn.query('SELECT id, role, commission_percentage FROM users WHERE id = ?', [pid]);
                
                if (pData[0]) {
                    const share = profit * (pData[0].commission_percentage / 100);
                    if (share > 0) {
                        await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [share, pid]);
                        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [pid, 'Comm-Income', share, `Commission from ${clientName}`]);
                    }
                    if (pData[0].role === 'SuperAdmin') break;
                    currentId = pid;
                } else break;
            }
        } else {
            await conn.query('UPDATE users SET exposure = exposure - ?, total_losses = total_losses + 1 WHERE id = ?', [amt, userId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Loss', -amt, 'Live Bet Lost']);
        }

        await conn.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await conn.query('ROLLBACK');
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/commission-summary', (req, res) => {
    const sql = `SELECT SUBSTRING_INDEX(description, 'from ', -1) as downline_name, SUM(amount) as total_earned FROM transactions WHERE user_id = ? AND type = 'Comm-Income' GROUP BY downline_name`;
    db.query(sql, [req.body.userId], (err, r) => res.json({ success: !err, summary: r || [] }));
});

app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.body.userId], (_, r) => res.json({ success: true, history: r || [] }));
});

// --- CORE LOGIC (DEPOSITS/WITHDRAWALS) ---
app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amt, senderId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, receiverId], () => {
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [senderId, 'Sent', -amt, `To ID: ${receiverId}`]);
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [receiverId, 'Received', amt, `From ID: ${senderId}`]);
                res.json({ success: true, message: 'Transfer Success' });
            });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Magic9 Server Live on ${PORT}`));
