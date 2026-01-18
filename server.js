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

// --- SECURITY CONFIG ---
const defaultPasswords = ['123456', '111111', '222222', '333333', '444444', '555555', '666666', '654321', '012345', '543210'];

// --- FRONTEND ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Add this inside your server.js login route
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // 1. CHECK FOR FIXED SUPERADMIN CREDENTIALS
    if (username === 'sadmin' && password === '123456') {
        const superAdmin = {
            id: 1,
            username: 'sadmin',
            first_name: 'Casino Head',
            role: 'SuperAdmin',
            balance: 10000,
            inr_balance: 100000, // 10,000 chips * 10
            force_password_change: 0 // SuperAdmin is exempt
        };
        return res.json({ success: true, user: superAdmin });
    }

    // 2. CHECK DATABASE FOR OTHER USERS
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (result && result.length > 0) {
            const user = result[0];
            
            // Password length check for existing users
            if (password.length < 6) {
                return res.json({ success: false, message: "Security update required: Password too short." });
            }

            // Standard Login Logic
            db.query('UPDATE users SET last_active=NOW() WHERE id=?', [user.id]);
            res.json({ success: true, user: user });
        } else {
            res.json({ success: false, message: "Invalid Username or Password" });
        }
    });
});
app.post('/api/update-password-secure', (req, res) => {
    const { userId, newPass } = req.body;
    if (!newPass || newPass.length < 6) return res.json({ success: false, message: "Minimum 6 characters required" });
    db.query('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?', [newPass, userId], (err) => {
        res.json({ success: !err, message: err ? "Database error" : "Success" });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// --- MANAGEMENT ---
app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, role, balance, exposure, commission_percentage, force_password_change,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users`;
    let params = [];
    if (role !== 'SuperAdmin') { query += ` WHERE parent_id = ?`; params.push(parentId); }
    db.query(query, params, (_, r) => res.json({ users: r || [] }));
});

app.post('/api/create-user-advanced', (req, res) => {
    const { uName, pass, role, deposit, commission, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const comm = parseFloat(commission) || 0;
    const force = defaultPasswords.includes(pass) ? 1 : 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            const sql = `INSERT INTO users(username, password, role, parent_id, balance, commission_percentage, force_password_change) VALUES(?,?,?,?,?,?,?)`;
            conn.query(sql, [uName, pass, role, creatorId, depAmt, comm, force], (err) => {
                if (err) return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Username exists' }); });
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

// --- SETTLEMENT ENGINE ---
app.post('/api/settle-bet', async (req, res) => {
    const { userId, amount, isWin, odds } = req.body;
    const amt = parseFloat(amount);
    const profit = isWin ? (amt * parseFloat(odds)) - amt : 0;
    const conn = db.promise();

    try {
        await conn.query('START TRANSACTION');
        const [userRows] = await conn.query('SELECT username FROM users WHERE id = ?', [userId]);
        if (!userRows.length) throw new Error("User not found");
        const clientName = userRows[0].username;

        if (isWin) {
            await conn.query('UPDATE users SET exposure = exposure - ?, balance = balance + ?, total_wins = total_wins + 1 WHERE id = ?', [amt, amt + profit, userId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Win', profit, `Live Bet Won (Odds: ${odds})`]);

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
                        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', 
                        [pid, 'Comm-Income', share, `Commission from ${clientName}`]);
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

// --- REPORTS ---
app.post('/api/commission-summary', (req, res) => {
    const sql = `SELECT SUBSTRING_INDEX(description, 'from ', -1) as downline_name, SUM(amount) as total_earned FROM transactions WHERE user_id = ? AND type = 'Comm-Income' GROUP BY downline_name`;
    db.query(sql, [req.body.userId], (err, r) => res.json({ success: !err, summary: r || [] }));
});

app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.body.userId], (_, r) => res.json({ success: true, history: r || [] }));
});

// --- MOVEMENTS ---
app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amt, senderId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, receiverId], () => {
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [senderId, 'Sent', -amt, `To ID: ${receiverId} (₹${amt*10})`]);
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [receiverId, 'Received', amt, `From ID: ${senderId} (₹${amt*10})`]);
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
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, adminId], () => {
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [userId, 'Withdrawal', -amt, `Recovered (₹${amt*10})`]);
                db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [adminId, 'Clawback', amt, `From ID: ${userId} (₹${amt*10})`]);
                res.json({ success: true, message: 'Withdrawal Success' });
            });
        } else res.json({ success: false, message: 'Insufficient User Balance' });
    });
});

// FIXED DELETE USER (Clears transactions first)
app.post('/api/delete-user', (req, res) => {
    const { id } = req.body;
    db.query('SELECT balance FROM users WHERE id = ?', [id], (e, r) => {
        if (r && r[0]?.balance > 0) return res.json({ success: false, message: "User must have 0 balance to delete" });
        
        db.query('DELETE FROM transactions WHERE user_id = ?', [id], () => {
            db.query('DELETE FROM users WHERE id = ?', [id], (err) => {
                if (err) res.json({ success: false, message: "Cannot delete user with active downlines" });
                else res.json({ success: true });
            });
        });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Magic9 Server Active on ${PORT}`));

