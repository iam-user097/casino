require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
// Serve static files (like your index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root "/" to your main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard',(req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ================= DB =================
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
  const [r] = await pdb.query(`SELECT id FROM users WHERE id=1`);
  if (!r.length) {
    await pdb.query(`
      INSERT INTO users
      (id, username, first_name, password, role, balance, inr_balance, commission_percentage)
      VALUES (1,'sadmin','Main Holder','123456','SuperAdmin',100000,1000000,10)
    `);
    console.log("✅ SuperAdmin Created");
  }
}
ensureSuperAdmin();

// ================= GLOBAL =================
let activeBets = [];

// ================= LOGIN =================
const DEFAULT_PASSWORDS = [
  '123456','112233','223344','666666','665544','000000','012345','123654',
  '321456','654321','111111','222222','333333','444444','555555','000111','111000'
];

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Fetch user by username
  const [rows] = await pdb.query(
    'SELECT * FROM users WHERE username=?',
    [username]
  );

  if (!rows.length) return res.json({ success:false, message:"Invalid credentials" });

  const user = rows[0];

  // Check password
  if (user.password !== password) {
    return res.json({ success:false, message:"Invalid credentials" });
  }

  let force = 0;

  // SuperAdmin never forced
  if (user.role === 'SuperAdmin') {
    force = 0;
  } else {
    // Force password change if password is in the default list
    if (DEFAULT_PASSWORDS.includes(password)) {
      force = 1;
    }
  }

  // Update last_active and force_password_change
  await pdb.query(
    'UPDATE users SET force_password_change=?, last_active=NOW() WHERE id=?',
    [force, user.id]
  );

  res.json({ success:true, user:{ ...user, force_password_change:force } });
});

// ================= PASSWORD =================
app.post('/api/update-password-secure', async (req,res)=>{
  const { userId, newPass } = req.body;
  await pdb.query(
    'UPDATE users SET password=?, force_password_change=0 WHERE id=?',
    [newPass, userId]
  );
  res.json({ success:true });
});

// ================= USER DETAILS =================
app.post('/api/user-details', async (req,res)=>{
  const [r] = await pdb.query('SELECT * FROM users WHERE id=?',[req.body.id]);
  r.length ? res.json({success:true,data:r[0]}) : res.json({success:false});
});

// ================= CREATE USER =================
app.post('/api/create-user-advanced', async (req,res)=>{
  const { uName, fullName, pass, role, commission, deposit, creatorId } = req.body;
  const conn = await pdb.getConnection();
  try {
    await conn.beginTransaction();

    if (creatorId != 1) {
      const [d] = await conn.query(
        'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
        [deposit, deposit, creatorId, deposit]
      );
      if (!d.affectedRows) throw "Insufficient balance";
    }

    const [u] = await conn.query(`
      INSERT INTO users
      (username, first_name, password, role, commission_percentage, parent_id, balance, inr_balance)
      VALUES (?,?,?,?,?,?,?,?)
    `,[uName, fullName, pass, role, commission, creatorId, deposit, deposit*10]);

    await conn.query(
      'INSERT INTO transactions VALUES (NULL,?, "TRANSFER_IN", ?, "Initial Chips", NOW())',
      [u.insertId, deposit]
    );

    await conn.commit();
    res.json({ success:true });
  } catch (e) {
    await conn.rollback();
    res.json({ success:false, message:e });
  } finally {
    conn.release();
  }
});

// ================= USERS LIST =================
app.post('/api/my-users', async (req,res)=>{
  const { parentId } = req.body;
  const [r] = await pdb.query(
    'SELECT * FROM users WHERE parent_id=?',
    [parentId]
  );
  res.json({ users:r });
});

// ================= DELETE USER =================
app.post('/api/delete-user', async (req,res)=>{
  const { requesterId, targetId } = req.body;
  if (targetId == 1) return res.json({ success:false, message:"Cannot delete SuperAdmin" });

  await pdb.query('DELETE FROM transactions WHERE user_id=?',[targetId]);
  await pdb.query('DELETE FROM users WHERE id=?',[targetId]);
  res.json({ success:true });
});

// ================= TRANSFER CREDITS (DEPOSIT) =================
app.post('/api/transfer-credits', async (req,res)=>{
  const { senderId, receiverId, amount } = req.body;
  if (amount <= 0) return res.json({ success:false });

  const conn = await pdb.getConnection();
  try {
    await conn.beginTransaction();

    const [d] = await conn.query(
      'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
      [amount, amount, senderId, amount]
    );
    if (!d.affectedRows) throw "Insufficient balance";

    await conn.query(
      'UPDATE users SET balance=balance+?, inr_balance=(balance+?)*10 WHERE id=?',
      [amount, amount, receiverId]
    );

    await conn.query(
      'INSERT INTO transactions VALUES (NULL,?, "TRANSFER_OUT", ?, "Transfer to user '+receiverId+'", NOW())',
      [senderId, -amount]
    );
    await conn.query(
      'INSERT INTO transactions VALUES (NULL,?, "TRANSFER_IN", ?, "Received from user '+senderId+'", NOW())',
      [receiverId, amount]
    );

    await conn.commit();
    res.json({ success:true });
  } catch (e) {
    await conn.rollback();
    res.json({ success:false, message:e });
  } finally {
    conn.release();
  }
});

// ================= WITHDRAW =================
app.post('/api/withdraw-chips', async (req,res)=>{
  const { userId, amount } = req.body;
  const [r] = await pdb.query(
    'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
    [amount, amount, userId, amount]
  );
  if (!r.affectedRows) return res.json({ success:false });

  await pdb.query(
    'INSERT INTO transactions VALUES (NULL,?, "WITHDRAW", ?, "Withdraw", NOW())',
    [userId, -amount]
  );
  res.json({ success:true });
});

// ================= EDIT USER =================
app.post('/api/edit-user', async (req,res)=>{
  const { targetId, username, commission } = req.body;
  await pdb.query(
    'UPDATE users SET username=?, commission_percentage=? WHERE id=?',
    [username, commission, targetId]
  );
  res.json({ success:true });
});

// ================= BET =================
app.post('/api/place-bet-direct', async (req,res)=>{
  const { userId, amount, boxes, stakePerBox } = req.body;

  const [r] = await pdb.query(
    'UPDATE users SET balance=balance-?, inr_balance=(balance-?)*10 WHERE id=? AND balance>=?',
    [amount, amount, userId, amount]
  );
  if (!r.affectedRows) return res.json({ success:false });

  activeBets.push({ userId, boxes, stakePerBox });

  await pdb.query(
    'INSERT INTO transactions VALUES (NULL,?, "BET", ?, ?, NOW())',
    [userId, -amount, `Boxes ${boxes.join(',')}`]
  );

  res.json({ success:true });
});

// ================= MARKET SETTLE (DIFFERENTIAL COMMISSION) =================
app.post('/api/house-settle', async (req,res)=>{
  if (!activeBets.length) return res.json({ success:false });

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
        'INSERT INTO transactions VALUES (NULL,?, "WIN", ?, "Winner Box '+winner+'", NOW())',
        [bet.userId, winAmt]
      );

      // DIFFERENTIAL COMMISSION
      let lastPercent = 0;
      let child = bet.userId;

      while (true) {
        const [[u]] = await conn.query(
          'SELECT parent_id, commission_percentage FROM users WHERE id=?',
          [child]
        );
        if (!u || !u.parent_id) break;

        const diff = u.commission_percentage - lastPercent;
        if (diff > 0) {
          const com = (winAmt * diff) / 100;
          await conn.query(
            'UPDATE users SET balance=balance+?, inr_balance=(balance+?)*10 WHERE id=?',
            [com, com, u.parent_id]
          );
          await conn.query(
            'INSERT INTO transactions VALUES (NULL,?, "COMMISSION", ?, "Downline commission", NOW())',
            [u.parent_id, com]
          );
        }

        lastPercent = u.commission_percentage;
        child = u.parent_id;
      }
    }

    activeBets = [];
    await conn.commit();
    res.json({ success:true, winner });

  } catch (e) {
    await conn.rollback();
    res.json({ success:false });
  } finally {
    conn.release();
  }
});

// ================= HISTORY =================
app.post('/api/user-history', async (req,res)=>{
  const [r] = await pdb.query(
    'SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC',
    [req.body.userId]
  );
  res.json({ success:true, data:r });
});

// ================= SERVER =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`🚀 SERVER LIVE @ ${PORT}`));
