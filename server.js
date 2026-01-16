const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const http = require('http'); // ADDED for real-time
const { Server } = require('socket.io'); // ADDED for real-time

const app = express();
const server = http.createServer(app); // Wrap express app
const io = new Server(server, { cors: { origin: "*" } }); // Initialize Socket.io

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

// --- NEW FEATURE: REAL-TIME NOTIFICATION LOGIC ---
io.on('connection', (socket) => {
    socket.on('join-admin-room', (adminId) => {
        socket.join(`admin_${adminId}`); // Admins join their private notification room
    });
});

// --- API ROUTES ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username=? AND password=?', [username, password], (err, result) => {
        if (err) return res.json({ success: false });
        if (result.length > 0) {
            const user = result[0];
            db.query('UPDATE users SET last_active=NOW() WHERE id=?', [user.id]);
            
            // BROADCAST: Notify parent admin that this user has logged in
            io.to(`admin_${user.parent_id}`).emit('user-logged-in', {
                username: user.username,
                role: user.role
            });

            res.json({ success: true, user: user });
        } else res.json({ success: false, message: 'Invalid Login' });
    });
});

app.post('/api/user-details', (req, res) => {
    db.query('SELECT *, balance, inr_balance, force_password_change FROM users WHERE id=?', [req.body.id], (e, r) => {
        r && r.length ? res.json({ success: true, data: r[0] }) : res.json({ success: false });
    });
});

// ENHANCED SECURITY: Update password with OLD password verification
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

// Quick Password Reset (For Admin/Key button)
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

// Withdraw Chips (Button W)
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

// FIXED: Delete User with full history cleanup
app.post('/api/delete-user', (req, res) => {
    const { id } = req.body;
    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            conn.query('SELECT balance FROM users WHERE id = ?', [id], (e, r) => {
                if (e || !r.length) return conn.rollback(() => res.json({ success: false, message: 'User not found' }));
                if (r[0].balance > 0) {
                    return conn.rollback(() => res.json({ success: false, message: 'Withdraw chips before deleting!' }));
                }
                conn.query('DELETE FROM transactions WHERE user_id = ?', [id], () => {
                    conn.query('DELETE FROM users WHERE id = ?', [id], (err, final) => {
                        if (err) {
                            return conn.rollback(() => {
                                res.json({ success: false, message: 'Cannot delete: This user is a parent to other users.' });
                            });
                        }
                        conn.commit(() => res.json({ success: true, message: 'User deleted successfully' }));
                    });
                });
            });
        });
    });
});

// Edit User (Update Name and Logins Only)
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

app.post('/api/place-bet', (req, res) => {
    const { userId, betAmount, isWin } = req.body;
    const amt = parseFloat(betAmount);
    const rates = { 'SuperAdmin': 0.08, 'Admin': 0.06, 'SuperMaster': 0.05, 'Master': 0.04, 'Agent': 0.02 };
    db.getConnection((err, conn) => {
        conn.beginTransaction(() => {
            if (isWin) {
                const profit = amt; 
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
server.listen(PORT, () => console.log(`🚀 Server Online with Notifications`));
