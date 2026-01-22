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

const defaultPasswords = ['123456', '111111', '222222', '333333', '444444', '555555', '666666', '000000', '654321', '112233'];

// In-memory queue to track bets until House Settle is called
let activeBets = [];

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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

// --- USER MANAGEMENT (HIERARCHY PROTECTED) ---
app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, role, balance, commission_percentage, force_password_change,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users WHERE id != ?`;
    let params = [parentId];

    if (role !== 'SuperAdmin') {
        query += ` AND parent_id = ?`;
        params.push(parentId);
    }

    db.query(query, params, (err, r) => {
        if (err) return res.json({ users: [] });
        let allUsers = r || [];

        if (role !== 'SuperAdmin') {
            db.query("SELECT id, username, role, balance, commission_percentage, 'Online' as status, 0 as force_password_change FROM users WHERE role = 'SuperAdmin' LIMIT 1", (err, saResult) => {
                if (saResult && saResult.length > 0) allUsers.unshift(saResult[0]);
                res.json({ users: allUsers });
            });
        } else res.json({ users: allUsers });
    });
});

app.post('/api/create-user-advanced', (req, res) => {
    const { uName, pass, role, deposit, commission, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const force = defaultPasswords.includes(pass) ? 1 : 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            const sql = `INSERT INTO users(username, password, role, parent_id, balance, commission_percentage, force_password_change) VALUES(?,?,?,?,?,?,?)`;
            conn.query(sql, [uName, pass, role, creatorId, depAmt, commission, force], (err) => {
                if (err) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'User exists' }); });
                if (depAmt > 0) {
                    conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [depAmt, creatorId], () => {
                        conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', 
                        [creatorId, 'Setup', -depAmt, `Setup: ${uName} (Value: ₹${depAmt*10})`], () => {
                            conn.commit(() => { conn.release(); res.json({ success: true }); });
                        });
                    });
                } else conn.commit(() => { conn.release(); res.json({ success: true }); });
            });
        });
    });
});

// --- DIRECT BETTING & HOUSE CONTROL ENGINE ---
app.post('/api/place-bet-direct', (req, res) => {
    const { userId, amount, boxes, stakePerBox } = req.body;
    const totalStake = parseFloat(amount);
    
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [totalStake, userId, totalStake], (err, r) => {
        if (r && r.affectedRows > 0) {
            // Log deduction
            db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Bet Active', -totalStake, `Stake on ${boxes.length} boxes`]);
            
            // Queue for House Settle
            activeBets.push({ userId, boxes, stakePerBox });
            res.json({ success: true });
        } else res.json({ success: false, message: 'Insufficient Main Balance' });
    });
});

app.post('/api/house-settle', async (req, res) => {
    const { winnerBox } = req.body;
    const conn = db.promise();
    
    try {
        await conn.query('START TRANSACTION');

        for (let bet of activeBets) {
            const isWin = bet.boxes.includes(parseInt(winnerBox));
            const stake = parseFloat(bet.stakePerBox);
            const odds = 2; // Double payout rule
            const profit = isWin ? (stake * odds) - stake : 0;
            
            const [uRows] = await conn.query('SELECT username FROM users WHERE id = ?', [bet.userId]);
            const clientName = uRows[0].username;

            if (isWin) {
                // Return original stake + net profit
                await conn.query('UPDATE users SET balance = balance + ?, total_wins = total_wins + 1 WHERE id = ?', [stake + profit, bet.userId]);
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [bet.userId, 'Win', profit, `Winner Box: ${winnerBox}`]);

                // Upward Commission Loop
                let currentChildId = bet.userId;
                while (true) {
                    const [pRows] = await conn.query('SELECT parent_id FROM users WHERE id = ?', [currentChildId]);
                    if (!pRows[0]?.parent_id) break;

                    const pid = pRows[0].parent_id;
                    const [pData] = await conn.query('SELECT id, role, commission_percentage FROM users WHERE id = ?', [pid]);
                    
                    if (pData[0]) {
                        const share = profit * (pData[0].commission_percentage / 100);
                        if (share > 0) {
                            await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [share, pid]);
                            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', 
                                [pid, 'Comm-Income', share, `Comm from ${clientName}`]);
                        }
                        if (pData[0].role === 'SuperAdmin') break;
                        currentChildId = pid;
                    } else break;
                }
            } else {
                await conn.query('UPDATE users SET total_losses = total_losses + 1 WHERE id = ?', [bet.userId]);
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [bet.userId, 'Loss', 0, `Box ${winnerBox} won`]);
            }
        }

        activeBets = []; // Clear queue
        await conn.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await conn.query('ROLLBACK');
        res.json({ success: false });
    }
});

// --- FINANCIALS & UTILS ---
app.post('/api/commission-summary', (req, res) => {
    db.query(`SELECT SUBSTRING_INDEX(description, 'from ', -1) as downline_name, SUM(amount) as total_earned FROM transactions WHERE user_id = ? AND type = 'Comm-Income' GROUP BY downline_name`, [req.body.userId], (err, r) => res.json({ success: !err, summary: r || [] }));
});

app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.body.userId], (_, r) => res.json({ success: true, history: r || [] }));
});

app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, senderId, amount], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, receiverId], () => {
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [senderId, 'Sent', -amount, `To ID: ${receiverId}`]);
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [receiverId, 'Received', amount, `From ID: ${senderId}`]);
                res.json({ success: true });
            });
        } else res.json({ success: false });
    });
});

app.post('/api/withdraw-chips', (req, res) => {
    const { adminId, userId, amount } = req.body;
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, userId, amount], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, adminId], () => {
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Withdrawal', -amount, `Recovered`]);
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [adminId, 'Clawback', amount, `From ID: ${userId}`]);
                res.json({ success: true });
            });
        } else res.json({ success: false });
    });
});

app.post('/api/delete-user', (req, res) => {
    db.query('DELETE FROM users WHERE id = ? AND balance = 0', [req.body.id], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('DELETE FROM transactions WHERE user_id = ?', [req.body.id]);
            res.json({ success: true });
        } else res.json({ success: false, message: "Withdraw chips first" });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server Active on Port ${PORT}`));
