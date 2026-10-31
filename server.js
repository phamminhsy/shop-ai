const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database('./database.sqlite');

const DEFAULT_MUSE_IMAGE = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';

db.serialize(() => {
    // 1. Bảng người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Bảng sản phẩm (Bổ sung cột category & note/description)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        category TEXT DEFAULT 'Tài khoản AI',
        price INTEGER,
        old_price INTEGER,
        image TEXT,
        description TEXT
    )`);

    // Đảm bảo tương thích nếu bảng cũ chưa có cột category
    db.run(`ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'Tài khoản AI'`, () => {});

    // 3. Bảng kho tài khoản
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    // 4. Bảng giao dịch nạp tiền
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

    // Khởi tạo sản phẩm mẫu nếu bảng products đang trống (KHÔNG xóa sản phẩm khi khởi động lại)
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO products (name, category, price, old_price, image, description) VALUES 
                ('Tài khoản Muse AI 1 Tỷ Token (Dùng riêng)', 'Tài khoản AI', 35000, 350000, ?, '• Tài khoản Muse AI cấp sẵn có 1 tỷ token sử dụng độc lập.\n• Hệ thống tự động xuất định dạng Email|Pass|Token ngay sau khi bấm thanh toán.\n• Bảo hành 1 đổi 1 nếu phát sinh lỗi đăng nhập lần đầu.')`, [DEFAULT_MUSE_IMAGE]);
        }
    });
});

// Middleware kiểm tra quyền Admin đơn giản
function verifyAdmin(req, res, next) {
    const adminId = req.headers['x-admin-id'] || req.body.adminId;
    if (!adminId) return res.status(403).json({ error: 'Không có quyền truy cập!' });
    db.get(`SELECT role FROM users WHERE id = ?`, [adminId], (err, user) => {
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Chỉ Quản trị viên mới được thực hiện thao tác này!' });
        }
        next();
    });
}

// ================= ĐĂNG KÝ & ĐĂNG NHẬP =================
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập đủ tên tài khoản và mật khẩu!' });
    if (username.length < 3 || password.length < 4) return res.status(400).json({ error: 'Tên tài khoản tối thiểu 3 ký tự, mật khẩu tối thiểu 4 ký tự!' });

    db.run(`INSERT INTO users (username, password, balance, role) VALUES (?, ?, 0, 'user')`, [username, password], function(err) {
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
    db.get(`SELECT id, username, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
        res.json(row);
    });
});

// ================= SẢN PHẨM & MUA HÀNG =================
app.get('/api/products', (req, res) => {
    db.all(`SELECT p.*, 
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as stock,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 1) as sold
            FROM products p ORDER BY p.id DESC`, [], (err, rows) => {
        res.json(rows || []);
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
                    res.json({ message: 'Mua hàng thành công!', account: item.account_data, productName: product.name });
                });
            });
        });
    });
});

app.get('/api/orders/:userId', (req, res) => {
    db.all(`SELECT i.id, i.account_data, i.sold_at, p.name, p.price, p.image 
            FROM inventory i JOIN products p ON i.product_id = p.id 
            WHERE i.buyer_id = ? ORDER BY i.sold_at DESC`, [req.params.userId], (err, rows) => {
        res.json(rows || []);
    });
});

// ================= NẠP TIỀN & WEBHOOK =================
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 20000) {
        return res.status(400).json({ error: 'Định mức nạp tối thiểu là 20.000đ!' });
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

app.post('/api/webhook/bank', (req, res) => {
    const content = (req.body.content || req.body.description || (req.body.data && req.body.data[0]?.description) || '').toUpperCase();
    const transferAmount = parseInt(req.body.transferAmount || req.body.amount || (req.body.data && req.body.data[0]?.amount) || 0);

    if (transferAmount > 0 && transferAmount < 20000) {
        return res.json({ success: false, message: 'Số tiền nạp dưới mức tối thiểu 20.000đ.' });
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
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => res.json(rows || []));
});

// ================= HỆ THỐNG QUẢN TRỊ ADMIN TOÀN DIỆN =================

// 1. Thống kê tổng quan Dashboard
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    const stats = {};
    db.get(`SELECT COUNT(*) as totalUsers FROM users`, (e1, r1) => {
        stats.totalUsers = r1 ? r1.totalUsers : 0;
        db.get(`SELECT COUNT(*) as totalSold, COALESCE(SUM(p.price), 0) as totalRevenue 
                FROM inventory i JOIN products p ON i.product_id = p.id WHERE i.is_sold = 1`, (e2, r2) => {
            stats.totalSold = r2 ? r2.totalSold : 0;
            stats.totalRevenue = r2 ? r2.totalRevenue : 0;
            db.get(`SELECT COUNT(*) as pendingTx FROM transactions WHERE status = 'pending'`, (e3, r3) => {
                stats.pendingTx = r3 ? r3.pendingTx : 0;
                db.get(`SELECT COUNT(*) as totalStock FROM inventory WHERE is_sold = 0`, (e4, r4) => {
                    stats.totalStock = r4 ? r4.totalStock : 0;
                    res.json(stats);
                });
            });
        });
    });
});

// 2. Thêm sản phẩm mới
app.post('/api/admin/products', verifyAdmin, (req, res) => {
    const { name, category, price, old_price, image, description } = req.body;
    const numPrice = parseInt(price);
    const numOldPrice = parseInt(old_price) || numPrice * 2;
    if (!name || !numPrice) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm và giá bán hợp lệ!' });

    db.run(`INSERT INTO products (name, category, price, old_price, image, description) VALUES (?, ?, ?, ?, ?, ?)`,
        [name.trim(), (category || 'Tài khoản AI').trim(), numPrice, numOldPrice, image || DEFAULT_MUSE_IMAGE, description || ''],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi tạo sản phẩm!' });
            res.json({ message: 'Đã thêm sản phẩm mới thành công!', id: this.lastID });
        }
    );
});

// 3. Chỉnh sửa sản phẩm
app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, category, price, old_price, image, description } = req.body;
    const numPrice = parseInt(price);
    const numOldPrice = parseInt(old_price) || numPrice * 2;
    if (!name || !numPrice) return res.status(400).json({ error: 'Tên và giá bán không được để trống!' });

    db.run(`UPDATE products SET name = ?, category = ?, price = ?, old_price = ?, image = ?, description = ? WHERE id = ?`,
        [name.trim(), (category || 'Tài khoản AI').trim(), numPrice, numOldPrice, image || DEFAULT_MUSE_IMAGE, description || '', req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi cập nhật sản phẩm!' });
            res.json({ message: 'Đã cập nhật thông tin sản phẩm!' });
        }
    );
});

// 4. Xóa sản phẩm
app.delete('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const prodId = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM inventory WHERE product_id = ? AND is_sold = 0`, [prodId]);
        db.run(`DELETE FROM products WHERE id = ?`, [prodId], () => {
            res.json({ message: 'Đã xóa sản phẩm và dọn kho chưa bán!' });
        });
    });
});

// 5. Quản lý Kho hàng (Thêm acc vào kho & Xem acc tồn kho)
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, accountsText } = req.body;
    if (!productId || !accountsText) return res.status(400).json({ error: 'Vui lòng chọn sản phẩm và nhập danh sách tài khoản!' });
    const lines = accountsText.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (!lines.length) return res.status(400).json({ error: 'Danh sách tài khoản trống!' });

    const stmt = db.prepare(`INSERT INTO inventory (product_id, account_data) VALUES (?, ?)`);
    lines.forEach(acc => stmt.run(productId, acc));
    stmt.finalize();
    res.json({ message: `Đã nạp thành công ${lines.length} tài khoản vào kho!` });
});

app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const productId = req.query.productId;
    const query = productId 
        ? `SELECT i.*, p.name as product_name, u.username as buyer_name FROM inventory i LEFT JOIN products p ON i.product_id = p.id LEFT JOIN users u ON i.buyer_id = u.id WHERE i.product_id = ? ORDER BY i.is_sold ASC, i.id DESC`
        : `SELECT i.*, p.name as product_name, u.username as buyer_name FROM inventory i LEFT JOIN products p ON i.product_id = p.id LEFT JOIN users u ON i.buyer_id = u.id ORDER BY i.is_sold ASC, i.id DESC LIMIT 200`;
    db.all(query, productId ? [productId] : [], (err, rows) => res.json(rows || []));
});

app.delete('/api/admin/inventory/:id', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], () => {
        res.json({ message: 'Đã xóa tài khoản khỏi kho!' });
    });
});

// 6. Quản lý Thành viên (Xem, Cộng/Trừ tiền, Đổi quyền, Xóa user)
app.get('/api/admin/users', verifyAdmin, (req, res) => {
    db.all(`SELECT id, username, balance, role, created_at,
            (SELECT COUNT(*) FROM inventory WHERE buyer_id = users.id) as orders_count
            FROM users ORDER BY id DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/balance', verifyAdmin, (req, res) => {
    const { userId, amount, mode } = req.body; // mode: 'add' (cộng/trừ thêm) hoặc 'set' (đặt cố định)
    const val = parseInt(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Số tiền không hợp lệ!' });

    const sql = mode === 'set' 
        ? `UPDATE users SET balance = ? WHERE id = ?`
        : `UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?`;

    db.run(sql, [val, userId], () => {
        res.json({ message: 'Đã cập nhật số dư thành viên!' });
    });
});

app.post('/api/admin/users/role', verifyAdmin, (req, res) => {
    const { userId, role } = req.body;
    db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, userId], () => {
        res.json({ message: `Đã cập nhật quyền thành ${role}!` });
    });
});

// 7. Quản lý Giao dịch nạp tiền
app.get('/api/admin/transactions', verifyAdmin, (req, res) => {
    db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/approve-tx', verifyAdmin, (req, res) => {
    const { txId, action } = req.body; // action: 'approve' | 'cancel'
    db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'pending'`, [txId], (err, tx) => {
        if (!tx) return res.status(400).json({ error: 'Giao dịch không tồn tại hoặc đã xử lý!' });
        if (action === 'cancel') {
            db.run(`UPDATE transactions SET status = 'cancelled' WHERE id = ?`, [txId], () => {
                res.json({ message: 'Đã hủy đơn nạp tiền!' });
            });
        } else {
            db.serialize(() => {
                db.run(`UPDATE transactions SET status = 'completed' WHERE id = ?`, [txId]);
                db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [tx.amount, tx.user_id]);
                res.json({ message: 'Đã duyệt và cộng tiền cho khách!' });
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>>> JERRY SHOP DA CHAY TAI: http://localhost:${PORT} <<<`));
