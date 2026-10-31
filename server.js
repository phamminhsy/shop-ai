const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Khởi tạo Database tự động
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // 1. Bảng Người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user'
    )`);

    // 2. Bảng Sản phẩm
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
        description TEXT
    )`);

    // 3. Bảng Kho tài khoản
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    // 4. Bảng Giao dịch Nạp / Rút
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT,
        amount INTEGER,
        info TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tạo sẵn tài khoản Admin (Tài khoản: admin | Mật khẩu: 123456)
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) 
            VALUES ('admin', '123456', 500000, 'admin')`);

    // Tạo sẵn 3 mặt hàng mẫu
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO products (name, price, description) VALUES 
                ('Tài khoản Muse AI Pro (1 Tháng)', 50000, 'Full tính năng, kèm Cookie & 2FA, bảo hành 1 đổi 1'),
                ('Tài khoản ChatGPT Plus (Dùng riêng)', 120000, 'Tài khoản chính chủ, hỗ trợ GPT-4o mới nhất'),
                ('Tài khoản Claude 3.5 Sonnet', 90000, 'Định dạng Email|Pass|SessionKey, vượt giới hạn chat')`);
        }
    });
});


// ================= API ĐĂNG KÝ & ĐĂNG NHẬP =================

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Vui lòng nhập đủ thông tin!' });
    }
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.status(400).json({ error: 'Tên tài khoản đã tồn tại!' });
        res.json({ id: this.lastID, username, balance: 0, role: 'user' });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username, balance, role FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Sai tài khoản hoặc mật khẩu!' });
        res.json(row);
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        res.json(row);
    });
});


// ================= API CỬA HÀNG & MUA TÀI KHOẢN =================

app.get('/api/products', (req, res) => {
    db.all(`SELECT p.*, (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as stock FROM products p`, [], (err, rows) => {
        res.json(rows);
    });
});

app.post('/api/buy', (req, res) => {
    const { userId, productId } = req.body;
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (err, product) => {
            if (!user || !product) return res.status(400).json({ error: 'Dữ liệu không hợp lệ!' });
            if (user.balance < product.price) return res.status(400).json({ error: 'Số dư không đủ! Vui lòng nạp thêm tiền.' });

            db.get(`SELECT * FROM inventory WHERE product_id = ? AND is_sold = 0 LIMIT 1`, [productId], (err, item) => {
                if (!item) return res.status(400).json({ error: 'Sản phẩm này vừa hết hàng trong kho!' });

                db.serialize(() => {
                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [product.price, userId]);
                    db.run(`UPDATE inventory SET is_sold = 1, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?`, [userId, item.id]);
                    res.json({ message: 'Mua thành công!', account: item.account_data });
                });
            });
        });
    });
});

app.get('/api/orders/:userId', (req, res) => {
    db.all(`SELECT i.account_data, i.sold_at, p.name, p.price FROM inventory i JOIN products p ON i.product_id = p.id WHERE i.buyer_id = ? ORDER BY i.sold_at DESC`, [req.params.userId], (err, rows) => {
        res.json(rows);
    });
});


// ================= API NẠP TIỀN & RÚT TIỀN =================

app.post('/api/transaction', (req, res) => {
    const { userId, type, amount, info } = req.body;
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 10000) {
        return res.status(400).json({ error: 'Số tiền tối thiểu là 10.000đ!' });
    }

    if (type === 'withdraw') {
        db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
            if (user.balance < numAmount) return res.status(400).json({ error: 'Số dư không đủ để rút!' });
            db.serialize(() => {
                db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numAmount, userId]);
                db.run(`INSERT INTO transactions (user_id, type, amount, info) VALUES (?, 'withdraw', ?, ?)`, [userId, numAmount, info]);
                res.json({ message: 'Đã tạo lệnh rút tiền! Chờ Admin chuyển khoản.' });
            });
        });
    } else {
        db.run(`INSERT INTO transactions (user_id, type, amount, info) VALUES (?, 'deposit', ?, ?)`, [userId, numAmount, info], function() {
            res.json({ message: 'Đã gửi yêu cầu nạp tiền! Hệ thống sẽ duyệt sau ít phút.' });
        });
    }
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => {
        res.json(rows);
    });
});


// ================= API QUẢN TRỊ VIÊN (ADMIN) =================

app.post('/api/admin/add-stock', (req, res) => {
    const { productId, accountsText } = req.body;
    const lines = accountsText.split('\n').map(l => l.trim()).filter(l => l !== '');
    const stmt = db.prepare(`INSERT INTO inventory (product_id, account_data) VALUES (?, ?)`);
    lines.forEach(acc => stmt.run(productId, acc));
    stmt.finalize();
    res.json({ message: `Đã thêm thành công ${lines.length} tài khoản vào kho!` });
});

app.get('/api/admin/transactions', (req, res) => {
    db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => {
        res.json(rows);
    });
});

app.post('/api/admin/approve-tx', (req, res) => {
    const { txId } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'pending'`, [txId], (err, tx) => {
        if (!tx) return res.status(400).json({ error: 'Giao dịch không tồn tại hoặc đã duyệt!' });
        db.serialize(() => {
            db.run(`UPDATE transactions SET status = 'completed' WHERE id = ?`, [txId]);
            if (tx.type === 'deposit') {
                db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [tx.amount, tx.user_id]);
            }
            res.json({ message: 'Đã duyệt giao dịch thành công!' });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>>> WEB DA CHAY TAI: http://localhost:${PORT} <<<`));