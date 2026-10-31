const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database('./database.sqlite');

const MUSE_IMAGE = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
        old_price INTEGER,
        image TEXT,
        description TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT,
        amount INTEGER,
        info TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tài khoản Admin mặc định: admin / 123456
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) 
            VALUES ('admin', '123456', 500000, 'admin')`);

    // Làm sạch danh sách sản phẩm cũ để chỉ giữ đúng 1 sản phẩm Muse AI duy nhất
    db.all("SELECT * FROM products", (err, rows) => {
        if (!rows || rows.length !== 1 || !rows[0].image) {
            db.run("DELETE FROM products", () => {
                db.run(`INSERT INTO products (id, name, price, old_price, image, description) VALUES 
                    (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – cấp sẵn, dùng riêng', 35000, 350000, ?, 'Mua tài khoản Muse AI cấp sẵn, có sẵn 1 tỷ token, dùng riêng. Kích hoạt tự động 24/7, nhận ngay Email|Pass|Cookie sau khi thanh toán.')`, [MUSE_IMAGE]);
            });
        }
    });
});

// ================= ĐĂNG KÝ & ĐĂNG NHẬP =================
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập đủ tên tài khoản và mật khẩu!' });
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.status(400).json({ error: 'Tên tài khoản này đã có người sử dụng!' });
        res.json({ id: this.lastID, username, balance: 0, role: 'user' });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username, balance, role FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Sai tên tài khoản hoặc mật khẩu!' });
        res.json(row);
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => res.json(row));
});

// ================= SẢN PHẨM & MUA HÀNG =================
app.get('/api/products', (req, res) => {
    db.all(`SELECT p.*, (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as stock FROM products p`, [], (err, rows) => {
        res.json(rows);
    });
});

// Cho phép Admin cập nhật giá sản phẩm Muse AI nếu muốn
app.post('/api/admin/update-price', (req, res) => {
    const { price } = req.body;
    const numPrice = parseInt(price);
    if (!numPrice || numPrice < 1000) return res.status(400).json({ error: 'Giá không hợp lệ!' });
    db.run(`UPDATE products SET price = ?, old_price = ? WHERE id = 1`, [numPrice, numPrice * 10], () => {
        res.json({ message: 'Đã cập nhật giá sản phẩm thành công!' });
    });
});

app.post('/api/buy', (req, res) => {
    const { userId, productId } = req.body;
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (err, product) => {
            if (!user || !product) return res.status(400).json({ error: 'Dữ liệu không hợp lệ!' });
            if (user.balance < product.price) return res.status(400).json({ error: 'Số dư của bạn không đủ! Vui lòng nạp thêm tiền.' });

            db.get(`SELECT * FROM inventory WHERE product_id = ? AND is_sold = 0 LIMIT 1`, [productId], (err, item) => {
                if (!item) return res.status(400).json({ error: 'Sản phẩm hiện đang tạm hết hàng! Vui lòng chờ Admin nhập thêm.' });

                db.serialize(() => {
                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [product.price, userId]);
                    db.run(`UPDATE inventory SET is_sold = 1, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?`, [userId, item.id]);
                    res.json({ message: 'Mua hàng thành công!', account: item.account_data });
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

// ================= TẠO ĐƠN NẠP TIỀN (TỐI THIỂU 20.000Đ) =================
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 20000) {
        return res.status(400).json({ error: 'Định mức nạp tối thiểu là 20.000đ! Vui lòng chọn từ 20.000đ trở lên.' });
    }

    db.run(`INSERT INTO transactions (user_id, type, amount, info, status) VALUES (?, 'deposit', ?, 'TEMP', 'pending')`, [userId, numAmount], function(err) {
        const txId = this.lastID;
        const code = `NAP${txId + 100}`;
        db.run(`UPDATE transactions SET info = ? WHERE id = ?`, [code, txId], () => {
            res.json({ txId, code, amount: numAmount });
        });
    });
});

app.get('/api/deposit/check/:txId', (req, res) => {
    db.get(`SELECT status, amount, info FROM transactions WHERE id = ?`, [req.params.txId], (err, row) => {
        if (!row) return res.status(404).json({ status: 'not_found' });
        res.json(row);
    });
});

// ================= WEBHOOK TỰ ĐỘNG SEPAY / CASSO (CHẶN DƯỚI 20K) =================
app.post('/api/webhook/bank', (req, res) => {
    const content = (req.body.content || req.body.description || (req.body.data && req.body.data[0]?.description) || '').toUpperCase();
    const transferAmount = parseInt(req.body.transferAmount || req.body.amount || (req.body.data && req.body.data[0]?.amount) || 0);

    // Nếu khách chuyển khoản dưới 20.000đ thì bỏ qua luôn, không cộng tiền và không báo gì
    if (transferAmount > 0 && transferAmount < 20000) {
        return res.json({ success: false, message: 'Số tiền nạp dưới mức tối thiểu 20.000đ, hệ thống từ chối cộng tiền.' });
    }

    const match = content.match(/NAP\d+/);
    if (!match) return res.json({ success: false, message: 'Không tìm thấy mã NAP hợp lệ' });

    const code = match[0];

    db.get(`SELECT * FROM transactions WHERE info = ? AND status = 'pending'`, [code], (err, tx) => {
        if (!tx) return res.json({ success: false, message: 'Đơn nạp không tồn tại hoặc đã hoàn tất' });

        const addAmount = transferAmount >= 20000 ? transferAmount : tx.amount;

        db.serialize(() => {
            db.run(`UPDATE transactions SET status = 'completed', amount = ? WHERE id = ?`, [addAmount, tx.id]);
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [addAmount, tx.user_id]);
            res.json({ success: true, message: `Đã tự động cộng ${addAmount}đ cho mã ${code}` });
        });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => res.json(rows));
});

// ================= QUẢN TRỊ ADMIN =================
app.post('/api/admin/add-stock', (req, res) => {
    const { productId, accountsText } = req.body;
    const lines = accountsText.split('\n').map(l => l.trim()).filter(l => l !== '');
    const stmt = db.prepare(`INSERT INTO inventory (product_id, account_data) VALUES (?, ?)`);
    lines.forEach(acc => stmt.run(productId || 1, acc));
    stmt.finalize();
    res.json({ message: `Đã thêm thành công ${lines.length} tài khoản Muse AI vào kho!` });
});

app.get('/api/admin/transactions', (req, res) => {
    db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => res.json(rows));
});

app.post('/api/admin/approve-tx', (req, res) => {
    const { txId } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'pending'`, [txId], (err, tx) => {
        if (!tx) return res.status(400).json({ error: 'Giao dịch không tồn tại hoặc đã duyệt!' });
        db.serialize(() => {
            db.run(`UPDATE transactions SET status = 'completed' WHERE id = ?`, [txId]);
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [tx.amount, tx.user_id]);
            res.json({ message: 'Đã duyệt cộng tiền thành công!' });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>>> JERRY SHOP DA CHAY TAI: http://localhost:${PORT} <<<`));
