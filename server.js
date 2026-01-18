const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });

const db = mysql.createPool({
    host: process.env.DB_HOST || "srv1952.hstgr.io",
    user: process.env.DB_USER || "u178691095_magic9",
    password: process.env.DB_PASSWORD || "Magic@097",
    database: process.env.DB_NAME || "u178691095_magic9_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10
});

const logTx = (uid, type, amt, desc) => {
    db.query('INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)', [uid, type, amt, desc]);
};

// --- API ROUTES ---

const weakPasswords = ['1234', '12345', '1111', '2222'];

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (result && result.length > 0) {
            const user = result[0];
            let force = user.force_password_change;
            if (user.role !== 'SuperAdmin' && weakPasswords.includes(password)) force = 1;
            
            db.query('UPDATE users SET force_password_change=? WHERE id=?', [force, user.id]);
            res.json({ success: true, user: { ...user, force_password_change: force } });
        } else res.json({ success: false });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT *, balance, inr_balance, force_password_change FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

app.post('/api/change-password-secure', (req, res) => {
    const { userId, oldPass, newPass } = req.body;
    db.query('SELECT password FROM users WHERE id = ?', [userId], (e, r) => {
        if (r && r[0].password === oldPass) {
            db.query('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?', [newPass, userId], (err) => {
                res.json({ success: !err, message: err ? 'Update failed' : 'Password changed successfully' });
            });
        } else {
            res.json({ success: false, message: 'Current password is incorrect' });
        }
    });
});

app.post('/api/update-password', (req, res) => {
    const { userId, newPass } = req.body;
    db.query('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?', [newPass, userId], (err) => {
        res.json({ success: !err });
    });
});

app.post('/api/my-users', (req, res) => {
    const { parentId, role } = req.body;
    let query = `SELECT id, username, first_name, role, balance, exposure, total_wins, total_losses, max_logins, force_password_change,
                CASE WHEN last_active >= NOW() - INTERVAL 5 MINUTE THEN 'Online' ELSE 'Offline' END AS status 
                FROM users`;
    let params = [];
    if (role === 'SuperAdmin') query += ` WHERE role != 'SuperAdmin'`;
    else { query += ` WHERE parent_id = ?`; params.push(parentId); }
    db.query(query, params, (_, r) => res.json({ users: r || [] }));
});

app.post('/api/history', (req, res) => {
    db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [req.body.userId], (_, r) => res.json({ history: r || [] }));
});

app.post('/api/withdraw-chips', (req, res) => {
    const { adminId, userId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amt, userId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, adminId]);
            logTx(userId, 'Withdrawal', -amt, `Chips taken by Admin`);
            logTx(adminId, 'Clawback', amt, `Withdrew from User ID: ${userId}`);
            res.json({ success: true, message: 'Withdrawal Successful' });
        } else res.json({ success: false, message: 'Insufficient user balance' });
    });
});

// FIXED: Delete User with full history cleanup logic
app.post('/api/delete-user', (req, res) => {
    const { id } = req.body;

    db.getConnection((err, conn) => {
        if (err) return res.json({ success: false, message: 'Connection Error' });

        conn.beginTransaction((tErr) => {
            if (tErr) { conn.release(); return res.json({ success: false }); }

            // 1. Check if user still has chips (Sir's requirement)
            conn.query('SELECT balance FROM users WHERE id = ?', [id], (e, r) => {
                if (e || !r.length) {
                    return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'User not found' }); });
                }
                
                if (r[0].balance > 0) {
                    return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Withdraw chips before deleting!' }); });
                }

                // 2. Delete all transaction history first to avoid Foreign Key Error
                conn.query('DELETE FROM transactions WHERE user_id = ?', [id], (txErr) => {
                    if (txErr) {
                        return conn.rollback(() => { conn.release(); res.json({ success: false, message: 'Failed to clear history' }); });
                    }

                    // 3. Delete the user account
                    conn.query('DELETE FROM users WHERE id = ?', [id], (usrErr) => {
                        if (usrErr) {
                            return conn.rollback(() => {
                                conn.release();
                                res.json({ success: false, message: 'Cannot delete: This user has sub-users linked to them.' });
                            });
                        }

                        conn.commit((cErr) => {
                            if (cErr) return conn.rollback(() => { conn.release(); res.json({ success: false }); });
                            conn.release();
                            res.json({ success: true, message: 'User deleted successfully' });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/update-user', (req, res) => {
    const { id, fName, logins } = req.body;
    db.query('UPDATE users SET first_name = ?, max_logins = ? WHERE id = ?', [fName, logins, id], (err) => {
        res.json({ success: !err, message: err ? 'Update failed' : 'User updated successfully' });
    });
});

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

const rates = { 'SuperAdmin': 0.10, 'Admin': 0.08, 'SuperMaster': 0.06, 'Master': 0.05, 'Agent': 0.04, 'Client': 0.00 };

// 1. Deduct Chips & Set Exposure
app.post('/api/place-bet (req, res) => {
    const { userId, amount } = req.body;
    const amt = parseFloat(amount);
    db.query('UPDATE users SET balance = balance - ?, exposure = exposure + ? WHERE id = ? AND balance >= ?', 
    [amt, amt, userId, amt], (err, r) => {
        if (r && r.affectedRows > 0) {
            logTx(userId, 'Bet Active', -amt, 'Moved to Exposure');
            res.json({ success: true });
        } else res.json({ success: false, message: 'Low Balance' });
    });
});

// 2. Settle & Distribute Commissions
app.post('/api/settle-bet', (req, res) => {
    const { userId, amount, isWin, odds } = req.body;
    const amt = parseFloat(amount);
    const profit = isWin ? (amt * parseFloat(odds)) - amt : 0;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            if (isWin) {
                conn.query('UPDATE users SET exposure = exposure - ?, balance = balance + ?, total_wins = total_wins + 1 WHERE id = ?', [amt, amt + profit, userId]);
                
                // Recursive Waterfall Distribution
                const distribute = (currId) => {
                    conn.query('SELECT parent_id FROM users WHERE id = ?', [currId], (err, pRes) => {
                        if (pRes && pRes[0]?.parent_id) {
                            const pid = pRes[0].parent_id;
                            conn.query('SELECT id, role FROM users WHERE id = ?', [pid], (err, pData) => {
                                const parent = pData[0];
                                const comm = profit * (rates[parent.role] || 0);
                                if (comm > 0) {
                                    conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [comm, parent.id]);
                                }
                                if (parent.role !== 'SuperAdmin') distribute(parent.id);
                                else conn.commit(() => conn.release());
                            });
                        } else conn.commit(() => conn.release());
                    });
                };
                distribute(userId);
            } else {
                conn.query('UPDATE users SET exposure = exposure - ?, total_losses = total_losses + 1 WHERE id = ?', [amt, userId]);
                conn.commit(() => conn.release());
            }
        });
        res.json({ success: true });
    });
});

app.post('/api/transfer-credits', (req, res) => {
    const { senderId, receiverId, amount } = req.body;
    db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [amount, senderId, amount], (err, res1) => {
        if (res1 && res1.affectedRows > 0) {
            db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, receiverId], () => {
                logTx(senderId, 'Sent', -amount, `Sent to User ID: ${receiverId}`);
                logTx(receiverId, 'Received', amount, `Received from User ID: ${senderId}`);
                res.json({ success: true, message: 'Transfer Success' });
            });
        } else res.json({ success: false, message: 'Low Balance' });
    });
});

app.post('/api/take-back-chips', (req, res) => {
    const { adminId, userId } = req.body;
    db.query('SELECT balance FROM users WHERE id=?', [userId], (e, r) => {
        if (e || !r.length) return res.json({ success: false });
        const amt = r[0].balance;
        db.query('UPDATE users SET balance = 0 WHERE id=?', [userId], () => {
            db.query('UPDATE users SET balance = balance + ? WHERE id=?', [amt, adminId], () => {
                logTx(adminId, 'Clawback', amt, `Took back all chips from User ID: ${userId}`);
                logTx(userId, 'TakeBack', -amt, `Chips removed by Admin (INR Safe)`);
                res.json({ success: true, recovered: amt });
            });
        });
    });
});

app.post('/api/create-user-advanced', (req, res) => {
    const { fName, uName, pass, role, logins, deposit, creatorId } = req.body;
    const depAmt = parseFloat(deposit) || 0;
    const forceFlag = (role === 'SuperAdmin') ? 0 : 1;

    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            const sql = `INSERT INTO users(first_name, username, password, role, parent_id, max_logins, balance, inr_balance, force_password_change) 
                         VALUES(?,?,?,?,?,?,?,?,?)`;
            conn.query(sql, [fName, uName, pass, role, creatorId, logins, depAmt, 0, forceFlag], (err, result) => {
                if (err) return conn.rollback(() => res.json({ success: false, message: 'Username already exists' }));
                if (depAmt > 0) {
                    conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [depAmt, creatorId], () => {
                        logTx(creatorId, 'Deduction', -depAmt, `Setup deposit for ${uName}`);
                        logTx(result.insertId, 'Deposit', depAmt, `Initial setup deposit`);
                        conn.commit(() => { res.json({ success: true, message: 'User Created & Deposited' }); });
                    });
                } else conn.commit(() => { res.json({ success: true, message: 'User Created Successfully' }); });
            });
        });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server Online`));

