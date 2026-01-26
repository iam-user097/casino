require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE CONNECTION POOL ---
const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

const promiseDb = db.promise();

// --- DB HEARTBEAT ---
setInterval(() => {
    db.query('SELECT 1', (err) => {
        if (err) console.error("Heartbeat Error:", err);
    });
}, 30000);

// --- STATE MANAGEMENT ---
let activeBets = []; 
const defaultPasswords = ['123456', '111111', '222222', '333333', '444444', '555555', '666666', '000000', '654321', '112233', '123654', '456321', '543210', '012345', '332211'];

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// --- AUTH & SECURITY (FIXED SUPERADMIN sadmin) ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Hardcoded logic for main site holder sadmin
    if (username === "sadmin" && password === "123456") {
        const sAdminData = { id: 1, username: 'sadmin', role: 'SuperAdmin', balance: 100000, inr_balance: 1000000 };
        return res.json({ success: true, user: sAdminData });
    }

    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (err) return res.status(500).json({ success: false });
        if (result && result.length > 0) {
            const user = result[0];
            let forceFlag = user.force_password_change;
            if (user.role !== 'SuperAdmin' && defaultPasswords.includes(password)) forceFlag = 1;
            db.query('UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?', [forceFlag, user.id]);
            res.json({ success: true, user: { ...user, force_password_change: forceFlag } });
        } else res.json({ success: false, message: "Invalid credentials" });
    });
});

app.post('/api/update-password-secure', (req, res) => {
    const { userId, newPass } = req.body;
    db.query('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?', [newPass, userId], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

app.post('/api/user-details', (req, res) => {
    if (req.body.id == 1) {
        return res.json({ success: true, data: { id: 1, username: 'sadmin', role: 'SuperAdmin', balance: 100000, inr_balance: 1000000 } });
    }
    db.query('SELECT * FROM users WHERE id=?', [req.body.id], (e, r) => {
        (r && r.length) ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// --- ADVANCED USER CREATION (CHIPS DEDUCTED FROM CREATOR) ---
app.post('/api/create-user-advanced', async (req, res) => {
    const { uName, fullName, pass, role, commission, deposit, creatorId } = req.body;
    const conn = await promiseDb.getConnection();
    try {
        await conn.beginTransaction();
        const dep = parseFloat(deposit) || 0;
        
        // Deduction logic: Subtract chips from the person creating the user
        if (creatorId != 1) {
            const [deduct] = await conn.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [dep, dep, creatorId, dep]);
            if (deduct.affectedRows === 0) throw new Error("Insufficient creator balance");
        }

        const [result] = await conn.query(
            'INSERT INTO users (username, first_name, password, role, commission_percentage, parent_id, balance, inr_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [uName, fullName, pass, role, commission, creatorId, dep, dep * 10]
        );
        
        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "SENT", ?, ?)', [creatorId, -dep, `Created user ${uName}`]);
        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "RECEIVED", ?, ?)', [result.insertId, dep, `Initial chips from creator`]);
        
        await conn.commit();
        res.json({ success: true });
    } catch (e) {
        await conn.rollback();
        res.json({ success: false, message: e.message });
    } finally { conn.release(); }
});

// --- LIVE BETTING SYSTEM (2X PAYOUT & RANDOM RESULT) ---
app.post('/api/place-bet-direct', (req, res) => {
    const { userId, amount, boxes, stakePerBox } = req.body;
    const totalStake = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [totalStake, totalStake, userId, totalStake], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "BET PLACED", ?, ?)', [userId, -totalStake, `Stake on: ${boxes.join(',')}`]);
            activeBets.push({ userId, boxes, stakePerBox: parseFloat(stakePerBox) });
            res.json({ success: true });
        } else res.json({ success: false, message: 'Insufficient Balance' });
    });
});

app.post('/api/house-settle', async (req, res) => {
    const winnerBox = Math.floor(Math.random() * 10) + 1; 
    const conn = await promiseDb.getConnection();
    try {
        await conn.beginTransaction();
        for (let bet of activeBets) {
            const isWin = bet.boxes.map(Number).includes(winnerBox);
            const stake = parseFloat(bet.stakePerBox);
            
            if (isWin) {
                const winAmount = stake * 2; 
                await conn.query('UPDATE users SET balance = balance + ?, inr_balance = inr_balance + ? WHERE id = ?', [winAmount, winAmount * 10, bet.userId]);
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "GAME WIN", ?, ?)', [bet.userId, winAmount, `Box ${winnerBox} Won (2x)`]);
                
                let currentId = bet.userId;
                while (true) {
                    const [parents] = await conn.query('SELECT parent_id FROM users WHERE id = ?', [currentId]);
                    if (!parents[0] || !parents[0].parent_id) break;
                    const [pData] = await conn.query('SELECT id, commission_percentage FROM users WHERE id = ?', [parents[0].parent_id]);
                    if (!pData[0]) break;
                    
                    const share = winAmount * (parseFloat(pData[0].commission_percentage) / 100);
                    if (share > 0) {
                        await conn.query('UPDATE users SET balance = balance + ?, inr_balance = inr_balance + ? WHERE id = ?', [share, share * 10, pData[0].id]);
                        await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "COMMISSION", ?, ?)', [pData[0].id, share, `From win ID: ${bet.userId}`]);
                    }
                    currentId = pData[0].id;
                }
            } else {
                await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "GAME LOSS", 0, ?)', [bet.userId, `Box ${winnerBox} won.`]);
            }
        }
        activeBets = []; 
        await conn.commit();
        res.json({ success: true, winner: winnerBox });
    } catch (err) { await conn.rollback(); res.json({ success: false }); }
    finally { conn.release(); }
});

// --- CHIP FLOW & HISTORY ---
app.post('/api/transfer-credits', async (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    const amt = parseFloat(amount);
    const conn = await promiseDb.getConnection();
    try {
        await conn.beginTransaction();
        const [up] = await conn.query('UPDATE users SET balance = balance - ?, inr_balance = (balance - ?) * 10 WHERE id = ? AND balance >= ?', [amt, amt, senderId, amt]);
        if (up.affectedRows > 0) {
            await conn.query('UPDATE users SET balance = balance + ?, inr_balance = (balance + ?) * 10 WHERE id = ?', [amt, amt, receiverId]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "SENT", ?, ?)', [senderId, -amt, `To ID: ${receiverId}`]);
            await conn.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, "RECEIVED", ?, ?)', [receiverId, amt, `From ID: ${senderId}`]);
            await conn.commit();
            res.json({ success: true });
        } else res.json({ success: false });
    } catch (e) { await conn.rollback(); res.json({ success: false }); }
    finally { conn.release(); }
} );

app.post('/api/user-history', (req, res) => {
    const { userId } = req.body;
    db.query('SELECT type, amount, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, data: results });
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server ${PORT} is ACTIVE !`));
