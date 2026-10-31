const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

const DEFAULT_MUSE_IMAGE = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';

// Khởi tạo Database & Schema
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

    // 2. Bảng sản phẩm chung
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        old_price INTEGER DEFAULT 0,
        image TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. BẢNG TÙY CHỌN SẢN PHẨM ĐỘNG (Dynamic Variants)
    db.run(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        name TEXT,
        price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // 4. Bảng kho hàng (Liên kết với product_id và variant_id)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        variant_id INTEGER,
        variant_name TEXT,
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    // 5. Bảng giao dịch nạp tiền
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT DEFAULT 'deposit',
        amount INTEGER,
        info TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tạo tài khoản Admin mặc định: admin / 123456
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) 
            VALUES ('admin', '123456', 500000, 'admin')`);

    // Tạo sản phẩm mẫu AI kèm các tùy chọn động + nạp sẵn kho nếu db trống
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, description) VALUES 
                (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, ?)`, 
                [
                    DEFAULT_MUSE_IMAGE, 
                    '• Tài khoản Muse AI cấp sẵn 1 tỷ token tốc độ cao, hỗ trợ tạo ảnh & video AI.\n• Bảo hành 1 đổi 1 trong suốt thời gian sử dụng.\n• Hệ thống bàn giao tài khoản tự động ngay sau khi thanh toán.'
                ],
                function(pErr) {
                    const prodId = 1;
                    db.run(`INSERT INTO product_variants (id, product_id, name, price) VALUES 
                        (1, ?, 'Tài khoản thường (Email | Mật khẩu)', 35000),
                        (2, ?, 'Tài khoản kèm Cookie (Đăng nhập tức thì không xác minh)', 45000)`,
                        [prodId, prodId],
                        function() {
                            const sampleNormal = [
                                'muse_vip_user01@gmail.com|JerryShopPass#992',
                                'muse_vip_user02@gmail.com|JerryShopPass#881',
                                'muse_vip_user03@gmail.com|JerryShopPass#774',
                                'muse_vip_user04@gmail.com|JerryShopPass#663',
                                'muse_vip_user05@gmail.com|JerryShopPass#552'
                            ];
                            const sampleCookie = [
                                'muse_cookie01@gmail.com|Pass@123|session_token=eyJhGciOiJIUzI1NiIsIn...',
                                'muse_cookie02@gmail.com|Pass@456|session_token=eyJhGciOiJIUzI1NiIsIn...',
                                'muse_cookie03@gmail.com|Pass@789|session_token=eyJhGciOiJIUzI1NiIsIn...'
                            ];

                            const stmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
                            sampleNormal.forEach(acc => stmt.run(prodId, 1, 'Tài khoản thường (Email | Mật khẩu)', acc));
                            sampleCookie.forEach(acc => stmt.run(prodId, 2, 'Tài khoản kèm Cookie (Đăng nhập tức thì không xác minh)', acc));
                            stmt.finalize();
                        }
                    );
                }
            );
        }
    });
});

function verifyAdmin(req, res, next) {
    const adminId = req.headers['x-admin-id'] || req.body.adminId;
    if (!adminId) return res.status(403).json({ error: 'Không có quyền truy cập!' });
    db.get(`SELECT role FROM users WHERE id = ?`, [adminId], (err, user) => {
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Chỉ Quản trị viên mới được thao tác!' });
        }
        next();
    });
}

// ================= AUTH =================
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập đủ tài khoản và mật khẩu!' });
    if (username.length < 3 || password.length < 4) return res.status(400).json({ error: 'Tên tối thiểu 3 ký tự, mật khẩu tối thiểu 4 ký tự!' });

    db.run(`INSERT INTO users (username, password, balance, role) VALUES (?, ?, 0, 'user')`, [username.trim(), password], function(err) {
        if (err) return res.status(400).json({ error: 'Tên tài khoản này đã có người đăng ký!' });
        res.json({ id: this.lastID, username: username.trim(), balance: 0, role: 'user' });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username, balance, role FROM users WHERE username = ? AND password = ?`, [username.trim(), password], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Sai tên đăng nhập hoặc mật khẩu!' });
        res.json(row);
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
        res.json(row);
    });
});

// ================= SẢN PHẨM & TÙY CHỌN =================
app.get('/api/products', (req, res) => {
    const sql = `
        SELECT p.*,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as total_stock,
            (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 1) as total_sold
        FROM products p
        ORDER BY p.id DESC
    `;
    db.all(sql, [], (err, products) => {
        if (err || !products || products.length === 0) return res.json([]);

        db.all(`
            SELECT pv.*,
                (SELECT COUNT(*) FROM inventory i WHERE i.variant_id = pv.id AND i.is_sold = 0) as stock
            FROM product_variants pv
            ORDER BY pv.id ASC
        `, [], (vErr, variants) => {
            const variantMap = {};
            (variants || []).forEach(v => {
                if (!variantMap[v.product_id]) variantMap[v.product_id] = [];
                variantMap[v.product_id].push(v);
            });

            const result = products.map(p => {
                const pVariants = variantMap[p.id] || [];
                const minPrice = pVariants.length ? Math.min(...pVariants.map(v => v.price)) : (p.price || 0);
                return {
                    ...p,
                    variants: pVariants,
                    min_price: minPrice,
                    total_stock: Number(p.total_stock || 0)
                };
            });
            res.json(result);
        });
    });
});

// ================= MUA HÀNG =================
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);

    if (!userId || !productId || !variantId) {
        return res.status(400).json({ error: 'Thiếu thông tin đặt hàng hoặc chưa chọn tùy chọn!' });
    }

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(400).json({ error: 'Vui lòng đăng nhập trước khi mua!' });

        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (pErr, product) => {
            if (!product) return res.status(400).json({ error: 'Sản phẩm không tồn tại!' });

            db.get(`SELECT * FROM product_variants WHERE id = ? AND product_id = ?`, [variantId, productId], (vErr, variant) => {
                if (!variant) return res.status(400).json({ error: 'Tùy chọn sản phẩm không hợp lệ!' });

                const unitPrice = Number(variant.price || 0);
                const totalCost = unitPrice * qty;

                if (user.balance < totalCost) {
                    return res.status(400).json({ 
                        error: `Số dư ví không đủ! Cần ${totalCost.toLocaleString()}đ nhưng bạn chỉ có ${user.balance.toLocaleString()}đ. Vui lòng nạp thêm tiền!` 
                    });
                }

                db.all(`SELECT * FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 LIMIT ?`, 
                    [productId, variantId, qty], 
                    (invErr, items) => {
                        if (!items || items.length < qty) {
                            const avail = items ? items.length : 0;
                            return res.status(400).json({ 
                                error: `Tùy chọn [${variant.name}] chỉ còn ${avail} tài khoản trong kho, không đủ số lượng ${qty} bạn chọn!` 
                            });
                        }

                        const ids = items.map(i => i.id);
                        const placeholders = ids.map(() => '?').join(',');

                        db.serialize(() => {
                            db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalCost, userId]);
                            db.run(`UPDATE inventory SET is_sold = 1, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, 
                                [userId, ...ids], 
                                (updateErr) => {
                                    if (updateErr) return res.status(500).json({ error: 'Lỗi khi bàn giao tài khoản!' });
                                    res.json({
                                        message: `Thanh toán thành công ${qty} tài khoản!`,
                                        productName: product.name,
                                        variantName: variant.name,
                                        totalCost,
                                        accounts: items.map(i => i.account_data)
                                    });
                                }
                            );
                        });
                    }
                );
            });
        });
    });
});

app.get('/api/orders/:userId', (req, res) => {
    db.all(`
        SELECT i.id, i.account_data, i.sold_at, i.variant_name, p.name as product_name, pv.price
        FROM inventory i 
        JOIN products p ON i.product_id = p.id 
        LEFT JOIN product_variants pv ON i.variant_id = pv.id
        WHERE i.buyer_id = ? 
        ORDER BY i.sold_at DESC, i.id DESC
    `, [req.params.userId], (err, rows) => {
        res.json(rows || []);
    });
});

// ================= NẠP TIỀN & WEBHOOK SEPAY =================
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
        return res.json({ success: false, message: 'Số tiền chuyển nhỏ hơn định mức tối thiểu 20.000đ.' });
    }

    const match = content.match(/NAP\d+/);
    if (!match) return res.json({ success: false, message: 'Không phát hiện mã nội dung hợp lệ (NAP...)' });

    const code = match[0];
    db.get(`SELECT * FROM transactions WHERE info = ? AND status = 'pending'`, [code], (err, tx) => {
        if (!tx) return res.json({ success: false, message: 'Đơn nạp không tồn tại hoặc đã xử lý trước đó.' });

        const addAmount = transferAmount >= 20000 ? transferAmount : tx.amount;
        db.serialize(() => {
            db.run(`UPDATE transactions SET status = 'completed', amount = ? WHERE id = ?`, [addAmount, tx.id]);
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [addAmount, tx.user_id]);
            res.json({ success: true, message: `Đã tự động cộng ${addAmount.toLocaleString()}đ cho mã ${code}` });
        });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => res.json(rows || []));
});

// ================= QUẢN TRỊ ADMIN =================
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    const stats = {};
    db.get(`SELECT COUNT(*) as totalUsers FROM users`, (e1, r1) => {
        stats.totalUsers = r1 ? r1.totalUsers : 0;
        db.get(`SELECT COUNT(*) as totalSold FROM inventory WHERE is_sold = 1`, (e2, r2) => {
            stats.totalSold = r2 ? r2.totalSold : 0;
            db.get(`SELECT COUNT(*) as pendingTx FROM transactions WHERE status = 'pending'`, (e3, r3) => {
                stats.pendingTx = r3 ? r3.pendingTx : 0;
                db.get(`SELECT COUNT(*) as totalStock FROM inventory WHERE is_sold = 0`, (e4, r4) => {
                    stats.totalStock = r4 ? r4.totalStock : 0;
                    db.get(`
                        SELECT COALESCE(SUM(pv.price), 0) as totalRevenue 
                        FROM inventory i 
                        LEFT JOIN product_variants pv ON i.variant_id = pv.id 
                        WHERE i.is_sold = 1
                    `, (e5, r5) => {
                        stats.totalRevenue = r5 ? r5.totalRevenue : 0;
                        res.json(stats);
                    });
                });
            });
        });
    });
});

app.post('/api/admin/products', verifyAdmin, (req, res) => {
    const { name, old_price, image, description, variants } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm!' });

    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) {
        return res.status(400).json({ error: 'Sản phẩm phải có ít nhất 1 tùy chọn và giá bán!' });
    }

    db.run(`INSERT INTO products (name, old_price, image, description) VALUES (?, ?, ?, ?)`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_MUSE_IMAGE, description || ''],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi lưu sản phẩm!' });
            const prodId = this.lastID;

            const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
            varList.forEach(v => {
                stmt.run(prodId, v.name.trim(), parseInt(v.price) || 0);
            });
            stmt.finalize(() => {
                res.json({ message: 'Đã thêm sản phẩm và các tùy chọn thành công!', id: prodId });
            });
        }
    );
});

app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, old_price, image, description, variants } = req.body;
    const prodId = req.params.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên sản phẩm không được để trống!' });

    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) {
        return res.status(400).json({ error: 'Sản phẩm phải có ít nhất 1 tùy chọn giá bán!' });
    }

    db.run(`UPDATE products SET name = ?, old_price = ?, image = ?, description = ? WHERE id = ?`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_MUSE_IMAGE, description || '', prodId],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi cập nhật sản phẩm!' });

            db.run(`DELETE FROM product_variants WHERE product_id = ?`, [prodId], () => {
                const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
                varList.forEach(v => {
                    stmt.run(prodId, v.name.trim(), parseInt(v.price) || 0);
                });
                stmt.finalize(() => {
                    res.json({ message: 'Đã lưu thay đổi sản phẩm và các tùy chọn!' });
                });
            });
        }
    );
});

app.delete('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const prodId = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM inventory WHERE product_id = ? AND is_sold = 0`, [prodId]);
        db.run(`DELETE FROM product_variants WHERE product_id = ?`, [prodId]);
        db.run(`DELETE FROM products WHERE id = ?`, [prodId], () => {
            res.json({ message: 'Đã xóa sản phẩm thành công!' });
        });
    });
});

app.get('/api/admin/variants/:productId', verifyAdmin, (req, res) => {
    db.all(`
        SELECT pv.*, 
            (SELECT COUNT(*) FROM inventory i WHERE i.variant_id = pv.id AND i.is_sold = 0) as stock
        FROM product_variants pv 
        WHERE pv.product_id = ? 
        ORDER BY pv.id ASC
    `, [req.params.productId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variantId, accountsText } = req.body;
    if (!productId || !variantId || !accountsText) {
        return res.status(400).json({ error: 'Vui lòng chọn sản phẩm, chọn tùy chọn và nhập danh sách tài khoản!' });
    }

    db.get(`SELECT * FROM product_variants WHERE id = ? AND product_id = ?`, [variantId, productId], (vErr, variant) => {
        if (!variant) return res.status(400).json({ error: 'Tùy chọn không tồn tại!' });

        const lines = accountsText.split('\n').map(l => l.trim()).filter(l => l !== '');
        if (!lines.length) return res.status(400).json({ error: 'Danh sách tài khoản trống!' });

        const stmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
        lines.forEach(acc => stmt.run(productId, variantId, variant.name, acc));
        stmt.finalize(() => {
            res.json({ message: `Đã nạp thành công ${lines.length} tài khoản vào tùy chọn [${variant.name}]!` });
        });
    });
});

app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const productId = req.query.productId;
    const query = productId 
        ? `SELECT i.*, p.name as product_name, u.username as buyer_name 
           FROM inventory i 
           LEFT JOIN products p ON i.product_id = p.id 
           LEFT JOIN users u ON i.buyer_id = u.id 
           WHERE i.product_id = ? 
           ORDER BY i.is_sold ASC, i.id DESC LIMIT 300`
        : `SELECT i.*, p.name as product_name, u.username as buyer_name 
           FROM inventory i 
           LEFT JOIN products p ON i.product_id = p.id 
           LEFT JOIN users u ON i.buyer_id = u.id 
           ORDER BY i.is_sold ASC, i.id DESC LIMIT 300`;
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
    const { userId, amount } = req.body;
    const val = parseInt(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Số tiền không hợp lệ!' });

    db.run(`UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?`, [val, userId], () => {
        res.json({ message: 'Đã cập nhật số dư cho thành viên!' });
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
                res.json({ message: 'Đã duyệt nạp và cộng tiền cho khách!' });
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>>> JERRY SHOP ĐANG CHẠY TẠI: http://localhost:${PORT} <<<`));
