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
    connectionLimit: 15,
    queueLimit: 0
});

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

const defaultPasswords = ['123456', '111111', '222222', '333333', '444444', '555555', '666666', '000000', '654321', '112233', '123654', '456321', '543210', '012345', '332211'];

let activeBets = [];
let lockedWinner = null;

// --- AUTH & SECURITY ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (result && result.length > 0) {
            const user = result[0];
            let forceFlag = user.force_password_change;
            if (user.role !== 'SuperAdmin' && defaultPasswords.includes(password)) forceFlag = 1;
            db.query('UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?', [forceFlag, user.id]);
            res.json({ success: true, user: { ...user, force_password_change: forceFlag } });
        } else res.json({ success: false, message: "Invalid credentials" });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, first_name, role, balance, commission_percentage, parent_id,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users WHERE id != ?`;
    let params = [parentId];
    if (role !== 'SuperAdmin') { query += ` AND parent_id = ?`; params.push(parentId); }
    db.query(query, params, (err, r) => res.json({ users: r || [] }));
});

// --- CHIP MANAGEMENT (WITH PERFECT MOMENTS) ---

app.post('/api/transfer-credits', async (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const amt = parseFloat(amount);
    const conn = db.promise();
    try {
        await conn.query('START TRANSACTION');
        const [update] = await conn.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [amt, amt, senderId, amt]);
        if (update.affectedRows > 0) {
            await conn.query('UPDATE users SET balance = balance + ?, inr_balance = (balance + ?) * 10 WHERE id = ?', [amt, amt, receiverId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Sent", ?, ?)', [senderId, -amt, `Transfer to ID: ${receiverId}`]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Received", ?, ?)', [receiverId, amt, `Received from ID: ${senderId}`]);
            await conn.commit();
            res.json({ success: true });
        } else res.json({ success: false, message: "Insufficient balance" });
    } catch (e) { await conn.rollback(); res.json({ success: false }); }
});

app.post('/api/withdraw-chips', async (req, res) => {
    const { adminId, userId, amount } = req.body;
    const amt = parseFloat(amount);
    const conn = db.promise();
    try {
        await conn.query('START TRANSACTION');
        const [update] = await conn.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [amt, amt, userId, amt]);
        if (update.affectedRows > 0) {
            await conn.query('UPDATE users SET balance = balance + ?, inr_balance = (balance + ?) * 10 WHERE id = ?', [amt, amt, adminId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Withdrawal", ?, "Clawback by Admin")', [userId, -amt]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Clawback", ?, ?)', [adminId, amt, `Recovered from User: ${userId}`]);
            await conn.commit();
            res.json({ success: true });
        } else res.json({ success: false });
    } catch (e) { await conn.rollback(); res.json({ success: false }); }
});

// --- LIVE BETTING SYSTEM ---

app.post('/api/place-bet-direct', (req, res) => {
    const { userId, amount, boxes, stakePerBox } = req.body;
    const totalStake = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [totalStake, totalStake, userId, totalStake], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Bet Placed", ?, ?)', [userId, -totalStake, `Stake on boxes: ${boxes.join(',')}`]);
            activeBets.push({ userId, boxes, stakePerBox: parseFloat(stakePerBox) });
            res.json({ success: true });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

app.post('/api/house-settle', async (req, res) => {
    const winnerBox = lockedWinner || req.body.winnerBox;
    if (!winnerBox) return res.json({ success: false, message: "No winner set" });
    
    const conn = db.promise();
    try {
        await conn.query('START TRANSACTION');
        for (let bet of activeBets) {
            const isWin = bet.boxes.map(Number).includes(parseInt(winnerBox));
            if (isWin) {
                const winAmount = bet.stakePerBox * 9; // 9x payout
                await conn.query('UPDATE users SET balance = balance + ?, inr_balance = (balance + ?) * 10 WHERE id = ?', [winAmount, winAmount, bet.userId]);
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Game Win", ?, ?)', [bet.userId, winAmount, `Won on box ${winnerBox}`]);
                
                // Waterfall Commission Moments
                let currentId = bet.userId;
                while (true) {
                    const [p] = await conn.query('SELECT parent_id FROM users WHERE id = ?', [currentId]);
                    if (!p[0] || !p[0].parent_id) break;
                    const [pData] = await conn.query('SELECT id, commission_percentage FROM users WHERE id = ?', [p[0].parent_id]);
                    if (!pData[0]) break;
                    
                    const share = winAmount * (pData[0].commission_percentage / 100);
                    if (share > 0) {
                        await conn.query('UPDATE users SET balance = balance + ?, inr_balance = (balance + ?) * 10 WHERE id = ?', [share, share, pData[0].id]);
                        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Commission", ?, "Earned from downline win")', [pData[0].id, share]);
                    }
                    currentId = pData[0].id;
                }
            } else {
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "Game Loss", 0, ?)', [bet.userId, `Lost on box ${winnerBox}`]);
            }
        }
        activeBets = []; lockedWinner = null;
        await conn.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await conn.query('ROLLBACK'); res.json({ success: false }); }
});

// --- NEW: HISTORY FETCHING ROUTE ---
app.post('/api/user-history', (req, res) => {
    const { userId } = req.body;
    db.query('SELECT type, amount, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, data: results });
    });
});

app.post('/api/lock-winner', (req, res) => {
    lockedWinner = req.body.box;
    res.json({ success: true, message: `Locked to Box ${lockedWinner}` });
});

app.post('/api/delete-user', (req, res) => {
    db.query('DELETE FROM users WHERE id = ? AND balance = 0', [req.body.id], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('DELETE FROM transactions WHERE user_id = ?', [req.body.id]);
            res.json({ success: true });
        } else res.json({ success: false, message: "Balance must be 0 to delete" });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server ${PORT} is ACTIVE !!`));
