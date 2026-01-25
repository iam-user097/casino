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

// --- FIXED ROUTES: One for Login, one for Dashboard ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Helper for security checks
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
            const userData = { ...user, inr_balance: user.balance * 10, force_password_change: forceFlag };
            db.query('UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?', [forceFlag, user.id]);
            res.json({ success: true, user: userData });
        } else res.json({ success: false, message: "Invalid credentials" });
    });
});

app.post('/api/update-password-secure', (req, res) => {
    const { userId, newPass } = req.body;
    if (!newPass || newPass.length !== 6) return res.json({ success: false, message: "Fixed 6 chars only" });
    db.query('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?', [newPass, userId], (err) => {
        res.json({ success: !err });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, full_name, role, balance, commission_percentage, 
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users WHERE id != ?`;
    let params = [parentId];
    if (role !== 'SuperAdmin') { query += ` AND creator_id = ?`; params.push(parentId); }
    db.query(query, params, (err, r) => res.json({ users: r || [] }));
});

app.post('/api/create-user-advanced', (req, res) => {
    const { uName, fullName, pass, role, deposit, commission, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const force = defaultPasswords.includes(pass) ? 1 : 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            // Logic: Using first_name to match your image image_9c78f0.jpg exactly
            const sql = `INSERT INTO users(username, first_name, password, role, parent_id, creator_id, balance, commission_percentage, force_password_change) VALUES(?,?,?,?,?,?,?,?,?)`;
            conn.query(sql, [uName, fullName, pass, role, creatorId, creatorId, depAmt, commission, force], (err) => {
                if (err) {
                    console.error("SQL Error Details:", err);
                    return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'User exists or SQL Error' }); });
                }
                
                if (depAmt > 0) {
                    conn.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [depAmt, creatorId, depAmt], (err, upRes) => {
                        if (upRes.affectedRows === 0) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'No Chips' }); });
                        conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', 
                        [creatorId, 'Setup', -depAmt, `Setup: ${uName}`], () => {
                            conn.commit(() => { conn.release(); res.json({ success: true }); });
                        });
                    });
                } else conn.commit(() => { conn.release(); res.json({ success: true }); });
            });
        });
    });
});

app.post('/api/lock-winner', (req, res) => {
    lockedWinner = req.body.box;
    res.json({ success: true, message: `Locked to ${lockedWinner}` });
});

app.post('/api/place-bet-direct', (req, res) => {
    const { userId, amount, boxes, stakePerBox } = req.body;
    const totalStake = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [totalStake, userId, totalStake], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Bet Active', -totalStake, `Stake on ${boxes.length} boxes`]);
            activeBets.push({ userId, boxes, stakePerBox });
            res.json({ success: true });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

app.post('/api/house-settle', async (req, res) => {
    const winnerBox = lockedWinner || req.body.winnerBox;
    const conn = db.promise();
    try {
        await conn.query('START TRANSACTION');
        for (let bet of activeBets) {
            const isWin = bet.boxes.includes(parseInt(winnerBox));
            const stake = parseFloat(bet.stakePerBox);
            const profit = isWin ? (stake * 2) - stake : 0;
            if (isWin) {
                await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [stake + profit, bet.userId]);
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [bet.userId, 'Win', profit, `Winner: ${winnerBox}`]);
                let currentId = bet.userId;
                while (true) {
                    const [p] = await conn.query('SELECT parent_id FROM users WHERE id = ?', [currentId]);
                    if (!p[0]?.parent_id) break;
                    const [pData] = await conn.query('SELECT id, commission_percentage FROM users WHERE id = ?', [p[0].parent_id]);
                    const share = profit * (pData[0].commission_percentage / 100);
                    if (share > 0) await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [share, pData[0].id]);
                    currentId = pData[0].id;
                }
            }
        }
        activeBets = []; lockedWinner = null;
        await conn.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await conn.query('ROLLBACK'); res.json({ success: false }); }
});

app.post('/api/transfer-credits', async (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const conn = db.promise();
    try {
        const [update] = await conn.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, senderId, amount]);
        if (update.affectedRows > 0) {
            await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, receiverId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [senderId, 'Sent', -amount, `Transferred out`]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [receiverId, 'Received', amount, `Received chips`]);
            res.json({ success: true });
        } else res.json({ success: false });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/delete-user', (req, res) => {
    db.query('DELETE FROM users WHERE id = ? AND balance = 0', [req.body.id], (err, r) => {
        res.json({ success: r?.affectedRows > 0 });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server ${PORT} is ACTIVE !`));

