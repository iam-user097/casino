require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= STATIC PAGES =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ================= DATABASE =================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 20
});
const pdb = db.promise();

// ================= SUPERADMIN =================
async function ensureSuperAdmin() {
    try {
        const [r] = await pdb.query(`SELECT id FROM users WHERE id=1`);
        if (!r.length) {
            await pdb.query(`
              INSERT INTO users
              (id, username, first_name, password, role, balance, inr_balance, commission_percentage)
              VALUES (1,'sadmin','Main Holder','123456','SuperAdmin',100000,1000000,10)
            `);
            console.log("✅ SuperAdmin Created");
        }
    } catch (e) {
        console.error("SuperAdmin check error:", e.message || e);
    }
}
ensureSuperAdmin();

// ================= GLOBAL =================
let activeBets = [];
const DEFAULT_PASSWORDS = ['123456','112233','223344','666666','665544','000000','012345','123654','321456','654321','111111','222222','333333','444444','555555','000111','111000'];

// ================= LOGIN =================
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [rows] = await pdb.query('SELECT * FROM users WHERE username=?', [username]);
        if (!rows.length) return res.json({ success: false, message: "Invalid credentials" });

        const user = rows[0];
        if (user.password !== password) return res.json({ success: false, message: "Invalid credentials" });

        let force = 0;
        if (user.role !== 'SuperAdmin' && DEFAULT_PASSWORDS.includes(password)) force = 1;

        await pdb.query('UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?', [force, user.id]);
        res.json({ success: true, user: { ...user, force_password_change: force } });
    } catch (e) {
        console.error(e);
        res.json({ success: false, message: e.message || e.toString() });
    }
});

// ================= UPDATE PASSWORD =================
app.post('/api/update-password-secure', async (req,res)=>{
    try {
        const { userId, newPass } = req.body;
        await pdb.query('UPDATE users SET password=?, force_password_change=0 WHERE id=?', [newPass, userId]);
        res.json({ success:true, message:"PIN updated successfully ✅" });
    } catch (e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= USER DETAILS =================
app.post('/api/user-details', async (req,res)=>{
    try {
        const [r] = await pdb.query('SELECT * FROM users WHERE id=?', [req.body.id]);
        r.length ? res.json({ success:true, data:r[0] }) : res.json({ success:false, message:"User not found" });
    } catch (e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= CREATE USER =================
app.post('/api/create-user-advanced', async (req,res)=>{
    const { uName, fullName, pass, role, commission, deposit, creatorId } = req.body;
    const conn = await pdb.getConnection();
    try {
        await conn.beginTransaction();

        // Deduct from creator (unless SuperAdmin)
        if (creatorId != 1) {
            const [d] = await conn.query(
                'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
                [deposit, deposit, creatorId, deposit]
            );
            if (!d.affectedRows) throw new Error("Insufficient balance for creating user");
        }

        // Create new user
        const [u] = await conn.query(`
            INSERT INTO users
            (username, first_name, password, role, commission_percentage, parent_id, balance, inr_balance)
            VALUES (?,?,?,?,?,?,?,?)
        `,[uName, fullName, pass, role, commission, creatorId, deposit, deposit*10]);

        // Record initial transaction
        await conn.query(
            'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
            [u.insertId, "TRANSFER_IN", deposit, "Initial Chips"]
        );

        await conn.commit();
        res.json({ success:true, message:"User created ✅" });
    } catch (e) {
        await conn.rollback();
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    } finally {
        conn.release();
    }
});

// ================= USERS LIST =================
app.post('/api/my-users', async (req, res) => {
  const { parentId, role } = req.body;

  try {
    let rows;

    if (role === 'SuperAdmin') {
      // 🔥 SuperAdmin sees ALL users except himself
      [rows] = await pdb.query(
        'SELECT * FROM users WHERE id != 1 ORDER BY id DESC'
      );
    } else {
      // 🔒 Others see only their direct downline
      [rows] = await pdb.query(
        'SELECT * FROM users WHERE parent_id = ? ORDER BY id DESC',
        [parentId]
      );
    }

    res.json({ success: true, users: rows });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// ================= DELETE USER =================
app.post('/api/delete-user', async (req,res)=>{
    try {
        const { requesterId, targetId } = req.body;
        if (targetId == 1) return res.json({ success:false, message:"Cannot delete SuperAdmin" });

        await pdb.query('DELETE FROM transactions WHERE user_id=?',[targetId]);
        await pdb.query('DELETE FROM users WHERE id=?',[targetId]);
        res.json({ success:true, message:"User deleted ✅" });
    } catch (e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= TRANSFER CREDITS =================
app.post('/api/transfer-credits', async (req,res)=>{
    const { senderId, receiverId, amount } = req.body;
    const conn = await pdb.getConnection();
    try {
        if (amount <= 0) throw new Error("Invalid amount");

        await conn.beginTransaction();
        const [d] = await conn.query(
            'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
            [amount, amount, senderId, amount]
        );
        if (!d.affectedRows) throw new Error("Insufficient balance");

        await conn.query(
            'UPDATE users SET balance=balance+?, inr_balance=(balance+?)*10 WHERE id=?',
            [amount, amount, receiverId]
        );

        await conn.query(
            'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
            [senderId,"TRANSFER_OUT",-amount,`Transfer to user ${receiverId}`]
        );
        await conn.query(
            'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
            [receiverId,"TRANSFER_IN",amount,`Received from user ${senderId}`]
        );

        await conn.commit();
        res.json({ success:true, message:"Transfer successful ✅" });
    } catch(e) {
        await conn.rollback();
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    } finally {
        conn.release();
    }
});

// ================= WITHDRAW =================
app.post('/api/withdraw-chips', async (req,res)=>{
    try {
        const { userId, amount } = req.body;
        const [r] = await pdb.query(
            'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
            [amount, amount, userId, amount]
        );
        if (!r.affectedRows) return res.json({ success:false, message:"Insufficient balance" });

        await pdb.query(
            'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
            [userId,"WITHDRAW",-amount,"Withdraw"]
        );
        res.json({ success:true, message:"Withdrawal successful ✅" });
    } catch (e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= PLACE BET =================
app.post('/api/place-bet-direct', async (req,res)=>{
    try {
        const { userId, amount, boxes, stakePerBox } = req.body;
        if (!boxes?.length) throw new Error("No boxes selected");

        const [r] = await pdb.query(
            'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
            [amount, amount, userId, amount]
        );
        if (!r.affectedRows) throw new Error("Insufficient balance");

        activeBets.push({ userId, boxes, stakePerBox });

        await pdb.query(
            'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
            [userId,"BET",-amount,`Boxes ${boxes.join(',')}`]
        );

        res.json({ success:true, message:"Bet placed ✅" });
    } catch(e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= MARKET SETTLE =================
app.post('/api/house-settle', async (req,res)=>{
    if (!activeBets.length) return res.json({ success:false, message:"No active bets" });

    const winner = Math.floor(Math.random()*10)+1;
    const conn = await pdb.getConnection();

    try {
        await conn.beginTransaction();

        for (const bet of activeBets) {
            if (!bet.boxes.includes(winner)) continue;

            const winAmt = bet.stakePerBox * 9;

            await conn.query(
                'UPDATE users SET balance=balance+?, inr_balance=(balance+?)*10 WHERE id=?',
                [winAmt, winAmt, bet.userId]
            );
            await conn.query(
                'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
                [bet.userId,"WIN",winAmt,`Winner Box ${winner}`]
            );

            // DIFFERENTIAL COMMISSION
            let lastPercent = 0;
            let child = bet.userId;

            while (true) {
                const [[u]] = await conn.query('SELECT parent_id, commission_percentage FROM users WHERE id=?',[child]);
                if (!u || !u.parent_id) break;

                const diff = u.commission_percentage - lastPercent;
                if (diff > 0) {
                    const com = (winAmt * diff)/100;
                    await conn.query(
                        'UPDATE users SET balance=balance+?, inr_balance=(balance+?)*10 WHERE id=?',
                        [com, com, u.parent_id]
                    );
                    await conn.query(
                        'INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
                        [u.parent_id,"COMMISSION",com,"Downline commission"]
                    );
                }

                lastPercent = u.commission_percentage;
                child = u.parent_id;
            }
        }

        activeBets = [];
        await conn.commit();
        res.json({ success:true, winner });
    } catch(e) {
        await conn.rollback();
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    } finally {
        conn.release();
    }
});

// ================= HISTORY =================
app.post('/api/user-history', async (req,res)=>{
    try {
        const [r] = await pdb.query('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC', [req.body.userId]);
        res.json({ success:true, data:r });
    } catch(e) {
        console.error(e);
        res.json({ success:false, message:e.message || e.toString() });
    }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`🚀 SERVER LIVE @ ${PORT}`));


