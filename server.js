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

    // 2. Bảng sản phẩm (Có price: Giá thường, price_cookie: Giá kèm cookie)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        category TEXT DEFAULT 'Tài khoản AI',
        price INTEGER DEFAULT 35000,
        price_cookie INTEGER DEFAULT 45000,
        old_price INTEGER DEFAULT 350000,
        image TEXT,
        description TEXT
    )`);

    // Tự động thêm cột mới nếu file database.sqlite cũ chưa có (tránh lỗi trắng dữ liệu)
    db.run(`ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'Tài khoản AI'`, () => {});
    db.run(`ALTER TABLE products ADD COLUMN price_cookie INTEGER DEFAULT 0`, () => {
        db.run(`UPDATE products SET price_cookie = price + 10000 WHERE price_cookie IS NULL OR price_cookie = 0`, () => {});
    });

    // 3. Bảng kho hàng (Có cột variant: 'normal' = Không cookie, 'cookie' = Có cookie)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        variant TEXT DEFAULT 'normal',
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    db.run(`ALTER TABLE inventory ADD COLUMN variant TEXT DEFAULT 'normal'`, () => {
        db.run(`UPDATE inventory SET variant = 'normal' WHERE variant IS NULL OR variant = ''`, () => {});
    });

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

    // Tạo sản phẩm mẫu + Kho mẫu nếu chưa có sản phẩm nào
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, category, price, price_cookie, old_price, image, description) VALUES 
                (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 'Tài khoản AI', 35000, 45000, 350000, ?, '• Tài khoản Muse AI cấp sẵn có 1 tỷ token dùng riêng.\n• Tùy chọn 1 (Không Cookie): Nhận định dạng Email|Pass.\n• Tùy chọn 2 (Kèm Cookie): Nhận định dạng Email|Pass|Cookie_Token vào thẳng không cần xác minh.\n• Hệ thống giao tự động 24/7 ngay sau khi bấm thanh toán.')`, [DEFAULT_MUSE_IMAGE]);
        }
    });
});

// Kiểm tra quyền Admin
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

// ================= SẢN PHẨM & MUA HÀNG (CÓ CHỌN SỐ LƯỢNG & LOẠI COOKIE) =================
app.get('/api/products', (req, res) => {
    const sql = `
        SELECT p.*,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0 AND (i.variant = 'normal' OR i.variant IS NULL)) as stock_normal,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0 AND i.variant = 'cookie') as stock_cookie,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as stock,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 1) as sold
        FROM products p
        ORDER BY p.id DESC
    `;
    db.all(sql, [], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/buy', (req, res) => {
    const { userId, productId, variant, quantity } = req.body;
    const buyType = variant === 'cookie' ? 'cookie' : 'normal';
    const qty = Math.max(1, parseInt(quantity) || 1);

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (err, product) => {
            if (!user || !product) return res.status(400).json({ error: 'Dữ liệu sản phẩm hoặc tài khoản không hợp lệ!' });

            const unitPrice = buyType === 'cookie' 
                ? (product.price_cookie || product.price) 
                : product.price;
            const totalCost = unitPrice * qty;

            if (user.balance < totalCost) {
                return res.status(400).json({ error: `Số dư không đủ! Cần ${totalCost.toLocaleString()}đ nhưng ví bạn có ${user.balance.toLocaleString()}đ.` });
            }

            const variantCondition = buyType === 'cookie' 
                ? `variant = 'cookie'` 
                : `(variant = 'normal' OR variant IS NULL)`;

            db.all(`SELECT * FROM inventory WHERE product_id = ? AND is_sold = 0 AND ${variantCondition} LIMIT ?`, [productId, qty], (err, items) => {
                if (!items || items.length < qty) {
                    const currentStock = items ? items.length : 0;
                    const typeLabel = buyType === 'cookie' ? 'Bản Kèm Cookie' : 'Bản Thường (Không Cookie)';
                    return res.status(400).json({ error: `Kho [${typeLabel}] chỉ còn ${currentStock} tài khoản, không đủ số lượng ${qty} bạn chọn!` });
                }

                const ids = items.map(i => i.id);
                const placeholders = ids.map(() => '?').join(',');

                db.serialize(() => {
                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalCost, userId]);
                    db.run(`UPDATE inventory SET is_sold = 1, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [userId, ...ids], (updateErr) => {
                        if (updateErr) return res.status(500).json({ error: 'Lỗi khi xuất kho tài khoản!' });
                        res.json({
                            message: `Mua thành công ${qty} tài khoản!`,
                            accounts: items.map(i => i.account_data),
                            productName: product.name,
                            totalCost
                        });
                    });
                });
            });
        });
    });
});

app.get('/api/orders/:userId', (req, res) => {
    db.all(`SELECT i.id, i.account_data, i.variant, i.sold_at, p.name, p.price, p.price_cookie 
            FROM inventory i JOIN products p ON i.product_id = p.id 
            WHERE i.buyer_id = ? ORDER BY i.sold_at DESC, i.id DESC`, [req.params.userId], (err, rows) => {
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

// ================= QUẢN TRỊ VIÊN (ADMIN) =================
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    const stats = {};
    db.get(`SELECT COUNT(*) as totalUsers FROM users`, (e1, r1) => {
        stats.totalUsers = r1 ? r1.totalUsers : 0;
        db.get(`SELECT COUNT(*) as totalSold, 
                COALESCE(SUM(CASE WHEN i.variant = 'cookie' THEN p.price_cookie ELSE p.price END), 0) as totalRevenue 
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

// Thêm sản phẩm (Có Giá Thường & Giá Kèm Cookie)
app.post('/api/admin/products', verifyAdmin, (req, res) => {
    const { name, category, price, price_cookie, old_price, image, description } = req.body;
    const numPrice = parseInt(price);
    const numPriceCookie = parseInt(price_cookie) || numPrice;
    const numOldPrice = parseInt(old_price) || numPrice * 2;
    if (!name || !numPrice) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm và giá bán!' });

    db.run(`INSERT INTO products (name, category, price, price_cookie, old_price, image, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name.trim(), (category || 'Tài khoản AI').trim(), numPrice, numPriceCookie, numOldPrice, image || DEFAULT_MUSE_IMAGE, description || ''],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi tạo sản phẩm!' });
            res.json({ message: 'Đã thêm sản phẩm mới thành công!', id: this.lastID });
        }
    );
});

// Cập nhật sản phẩm
app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, category, price, price_cookie, old_price, image, description } = req.body;
    const numPrice = parseInt(price);
    const numPriceCookie = parseInt(price_cookie) || numPrice;
    const numOldPrice = parseInt(old_price) || numPrice * 2;
    if (!name || !numPrice) return res.status(400).json({ error: 'Tên và giá bán không được để trống!' });

    db.run(`UPDATE products SET name = ?, category = ?, price = ?, price_cookie = ?, old_price = ?, image = ?, description = ? WHERE id = ?`,
        [name.trim(), (category || 'Tài khoản AI').trim(), numPrice, numPriceCookie, numOldPrice, image || DEFAULT_MUSE_IMAGE, description || '', req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi cập nhật sản phẩm!' });
            res.json({ message: 'Đã lưu thay đổi sản phẩm!' });
        }
    );
});

// Xóa sản phẩm
app.delete('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const prodId = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM inventory WHERE product_id = ? AND is_sold = 0`, [prodId]);
        db.run(`DELETE FROM products WHERE id = ?`, [prodId], () => {
            res.json({ message: 'Đã xóa sản phẩm!' });
        });
    });
});

// Nạp kho theo Phân loại (normal = Không cookie, cookie = Kèm cookie)
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variant, accountsText } = req.body;
    if (!productId || !accountsText) return res.status(400).json({ error: 'Vui lòng chọn sản phẩm và nhập danh sách tài khoản!' });
    const stockVariant = variant === 'cookie' ? 'cookie' : 'normal';
    const lines = accountsText.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (!lines.length) return res.status(400).json({ error: 'Danh sách tài khoản trống!' });

    const stmt = db.prepare(`INSERT INTO inventory (product_id, variant, account_data) VALUES (?, ?, ?)`);
    lines.forEach(acc => stmt.run(productId, stockVariant, acc));
    stmt.finalize();
    const label = stockVariant === 'cookie' ? 'Bản Kèm Cookie' : 'Bản Thường (Không Cookie)';
    res.json({ message: `Đã thêm ${lines.length} tài khoản vào kho [${label}]!` });
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

app.get('/api/admin/users', verifyAdmin, (req, res) => {
    db.all(`SELECT id, username, balance, role, created_at,
            (SELECT COUNT(*) FROM inventory WHERE buyer_id = users.id) as orders_count
            FROM users ORDER BY id DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/balance', verifyAdmin, (req, res) => {
    const { userId, amount, mode } = req.body;
    const val = parseInt(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Số tiền không hợp lệ!' });

    const sql = mode === 'set' 
        ? `UPDATE users SET balance = ? WHERE id = ?`
        : `UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?`;

    db.run(sql, [val, userId], () => {
        res.json({ message: 'Đã cập nhật số dư thành viên!' });
    });
});

app.get('/api/admin/transactions', verifyAdmin, (req, res) => {
    db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/approve-tx', verifyAdmin, (req, res) => {
    const { txId, action } = req.body;
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
