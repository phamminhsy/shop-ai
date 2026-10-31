const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

const DEFAULT_MUSE_IMAGE = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';

// Khởi tạo Database & Schema
db.serialize(() => {
    // 1. Cài đặt hệ thống & Giao diện (Customizer)
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // 2. Bảng người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Bảng sản phẩm
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        old_price INTEGER DEFAULT 0,
        image TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Bảng tùy chọn sản phẩm động
    db.run(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        name TEXT,
        price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // 5. BẢNG ĐƠN HÀNG (Lưu gộp toàn bộ tài khoản trong 1 lần mua)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT UNIQUE,
        user_id INTEGER,
        product_id INTEGER,
        variant_id INTEGER,
        product_name TEXT,
        variant_name TEXT,
        quantity INTEGER DEFAULT 1,
        total_price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 6. Bảng kho hàng (Có order_id để liên kết chính xác với đơn hàng)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        variant_id INTEGER,
        variant_name TEXT,
        account_data TEXT,
        is_sold INTEGER DEFAULT 0,
        order_id INTEGER,
        buyer_id INTEGER,
        sold_at DATETIME
    )`);

    // Tự động kiểm tra thêm cột order_id nếu db cũ đã tạo
    db.run(`ALTER TABLE inventory ADD COLUMN order_id INTEGER`, () => {});

    // 7. Bảng giao dịch nạp tiền
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT DEFAULT 'deposit',
        amount INTEGER,
        info TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Admin mặc định
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) 
            VALUES ('admin', '123456', 500000, 'admin')`);

    // Thiết lập mặc định cho Shop
    const defaultSettings = [
        ['site_name', 'JERRY SHOP'],
        ['site_slogan', 'Hệ Thống Tài Khoản AI & Tiện Ích Giá Rẻ Tự Động 24/7'],
        ['site_logo', ''],
        ['site_hotline', '0982.900.374'],
        ['site_zalo', '0982900374'],
        ['site_notice', '⚡ Jerry Shop - Hệ thống phân phối tài khoản số tự động 24/7. Trả acc ngay sau 3 giây!'],
        ['site_banner_title', 'Jerry Shop - Sàn Phân Phối Tài Khoản AI Uy Tín'],
        ['site_banner_desc', 'Bấm trực tiếp vào sản phẩm để chọn tùy chọn gói, số lượng và nhận tài khoản ngay lập tức.'],
        ['bank_id', 'MB'],
        ['bank_name', 'MB BANK (Quân Đội)'],
        ['bank_account', '5428102008'],
        ['bank_owner', 'JERRY SHOP'],
        ['min_deposit', '20000'],
        ['theme_color', 'navy'],
        ['container_width', 'standard']
    ];

    const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    defaultSettings.forEach(s => stmt.run(s[0], s[1]));
    stmt.finalize();

    // Dữ liệu sản phẩm mẫu + Nạp sẵn kho nếu trống
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, description) VALUES 
                (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, ?)`, 
                [
                    DEFAULT_MUSE_IMAGE, 
                    '• Tài khoản Muse AI cấp sẵn 1 tỷ token tạo ảnh và video tốc độ cao.\n• Bảo hành 1 đổi 1 suốt thời gian sử dụng.\n• Hệ thống bàn giao tài khoản tự động ngay sau khi thanh toán.'
                ],
                function() {
                    const prodId = 1;
                    db.run(`INSERT INTO product_variants (id, product_id, name, price) VALUES 
                        (1, ?, 'Tài khoản thường (Email | Mật khẩu)', 35000),
                        (2, ?, 'Tài khoản kèm Cookie (Đăng nhập tức thì không xác minh)', 45000)`,
                        [prodId, prodId],
                        function() {
                            const sampleNormal = [
                                'muse_vip_user01@gmail.com|JerryShop#992',
                                'muse_vip_user02@gmail.com|JerryShop#881',
                                'muse_vip_user03@gmail.com|JerryShop#774',
                                'muse_vip_user04@gmail.com|JerryShop#663',
                                'muse_vip_user05@gmail.com|JerryShop#552'
                            ];
                            const sampleCookie = [
                                'muse_cookie01@gmail.com|Pass@123|session_token=eyJhGciOiJIUzI1NiIsIn...',
                                'muse_cookie02@gmail.com|Pass@456|session_token=eyJhGciOiJIUzI1NiIsIn...',
                                'muse_cookie03@gmail.com|Pass@789|session_token=eyJhGciOiJIUzI1NiIsIn...'
                            ];

                            const s = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
                            sampleNormal.forEach(acc => s.run(prodId, 1, 'Tài khoản thường (Email | Mật khẩu)', acc));
                            sampleCookie.forEach(acc => s.run(prodId, 2, 'Tài khoản kèm Cookie (Đăng nhập tức thì không xác minh)', acc));
                            s.finalize();
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

// ================= CÀI ĐẶT & GIAO DIỆN (SETTINGS & THEME) =================
app.get('/api/settings', (req, res) => {
    db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
        const obj = {};
        (rows || []).forEach(r => obj[r.key] = r.value);
        res.json(obj);
    });
});

app.post('/api/admin/settings', verifyAdmin, (req, res) => {
    const settings = req.body.settings || {};
    const keys = Object.keys(settings);
    if (!keys.length) return res.status(400).json({ error: 'Không có dữ liệu cài đặt' });

    db.serialize(() => {
        const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
        keys.forEach(k => stmt.run(k, String(settings[k])));
        stmt.finalize(() => {
            res.json({ message: 'Đã lưu cài đặt giao diện và hệ thống thành công!' });
        });
    });
});

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

// ================= SẢN PHẨM =================
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

// ================= MUA HÀNG (TẠO ĐƠN HÀNG GỘP TẤT CẢ ACC) =================
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

                // Kiểm tra kho
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

                        // Tạo mã đơn hàng duy nhất: DH-YYMMDD-XXXX
                        const now = new Date();
                        const dateStr = String(now.getFullYear()).slice(2) + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
                        const rand = Math.floor(1000 + Math.random() * 9000);
                        const orderCode = `DH-${dateStr}-${rand}`;

                        db.serialize(() => {
                            // 1. Trừ tiền khách
                            db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalCost, userId]);

                            // 2. Tạo đơn hàng mới trong bảng orders
                            db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, quantity, total_price) 
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                [orderCode, userId, productId, variantId, product.name, variant.name, qty, totalCost],
                                function(ordErr) {
                                    if (ordErr) return res.status(500).json({ error: 'Lỗi khi tạo đơn hàng!' });
                                    const orderId = this.lastID;

                                    // 3. Cập nhật các tài khoản đã bán và gán order_id
                                    db.run(`UPDATE inventory SET is_sold = 1, order_id = ?, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, 
                                        [orderId, userId, ...ids], 
                                        (updateErr) => {
                                            if (updateErr) return res.status(500).json({ error: 'Lỗi khi bàn giao tài khoản!' });
                                            
                                            const accountsList = items.map(i => i.account_data);
                                            res.json({
                                                message: `Thanh toán thành công ${qty} tài khoản!`,
                                                orderCode,
                                                orderId,
                                                productName: product.name,
                                                variantName: variant.name,
                                                totalCost,
                                                quantity: qty,
                                                accounts: accountsList
                                            });
                                        }
                                    );
                                }
                            );
                        });
                    }
                );
            });
        });
    });
});

// LỊCH SỬ ĐƠN HÀNG: GỘP TẤT CẢ TÀI KHOẢN VÀO TỪNG ĐƠN HÀNG
app.get('/api/orders/:userId', (req, res) => {
    const userId = req.params.userId;
    db.all(`SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC`, [userId], (err, orders) => {
        if (err || !orders || !orders.length) return res.json([]);

        // Lấy toàn bộ tài khoản thuộc các đơn hàng của user
        db.all(`SELECT id, order_id, account_data, sold_at FROM inventory WHERE buyer_id = ? AND is_sold = 1 ORDER BY id ASC`, [userId], (iErr, items) => {
            const accMap = {};
            (items || []).forEach(it => {
                const oid = it.order_id || 0;
                if (!accMap[oid]) accMap[oid] = [];
                accMap[oid].push(it.account_data);
            });

            const result = orders.map(ord => ({
                ...ord,
                accounts: accMap[ord.id] || []
            }));

            res.json(result);
        });
    });
});

// Tra cứu đơn hàng nhanh bằng mã đơn (Không cần đăng nhập)
app.get('/api/order-lookup/:code', (req, res) => {
    const code = req.params.code.trim().toUpperCase();
    db.get(`SELECT * FROM orders WHERE order_code = ?`, [code], (err, order) => {
        if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng với mã này!' });

        db.all(`SELECT account_data FROM inventory WHERE order_id = ?`, [order.id], (iErr, items) => {
            res.json({
                ...order,
                accounts: (items || []).map(i => i.account_data)
            });
        });
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
        db.get(`SELECT COUNT(*) as totalOrders, COALESCE(SUM(total_price), 0) as totalRevenue FROM orders`, (e2, r2) => {
            stats.totalOrders = r2 ? r2.totalOrders : 0;
            stats.totalRevenue = r2 ? r2.totalRevenue : 0;
            db.get(`SELECT COUNT(*) as totalSold FROM inventory WHERE is_sold = 1`, (e3, r3) => {
                stats.totalSold = r3 ? r3.totalSold : 0;
                db.get(`SELECT COUNT(*) as totalStock FROM inventory WHERE is_sold = 0`, (e4, r4) => {
                    stats.totalStock = r4 ? r4.totalStock : 0;
                    db.get(`SELECT COUNT(*) as pendingTx FROM transactions WHERE status = 'pending'`, (e5, r5) => {
                        stats.pendingTx = r5 ? r5.pendingTx : 0;
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

// NẠP KHO VỚI BỘ LỌC TRÙNG LẶP NỘI BỘ VÀ KIỂM TRA DATABASE
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variantId, accountsText } = req.body;
    if (!productId || !variantId || !accountsText || !accountsText.trim()) {
        return res.status(400).json({ error: 'Vui lòng chọn sản phẩm, chọn tùy chọn và nhập danh sách tài khoản!' });
    }

    db.get(`SELECT * FROM product_variants WHERE id = ? AND product_id = ?`, [variantId, productId], (vErr, variant) => {
        if (!variant) return res.status(400).json({ error: 'Tùy chọn không tồn tại!' });

        const rawLines = accountsText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) return res.status(400).json({ error: 'Danh sách tài khoản trống!' });

        // 1. Lọc trùng lặp nội bộ trong danh sách dán vào
        const uniqueSet = new Set();
        const internalDuplicates = [];
        const uniqueLines = [];

        rawLines.forEach(line => {
            if (uniqueSet.has(line)) {
                internalDuplicates.push(line);
            } else {
                uniqueSet.add(line);
                uniqueLines.push(line);
            }
        });

        // 2. Kiểm tra xem tài khoản đã từng tồn tại trong Database hay chưa
        db.all(`SELECT account_data FROM inventory WHERE product_id = ?`, [productId], (dbErr, existingItems) => {
            const dbExistingSet = new Set((existingItems || []).map(i => i.account_data));

            const toInsert = [];
            const dbDuplicates = [];

            uniqueLines.forEach(line => {
                if (dbExistingSet.has(line)) {
                    dbDuplicates.push(line);
                } else {
                    toInsert.push(line);
                }
            });

            if (!toInsert.length) {
                return res.status(400).json({
                    error: `Tất cả ${rawLines.length} tài khoản dán vào đều đã tồn tại trong kho hoặc bị trùng lặp! Không có tài khoản mới nào được thêm.`
                });
            }

            const stmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
            toInsert.forEach(acc => stmt.run(productId, variantId, variant.name, acc));
            stmt.finalize(() => {
                const totalDup = rawLines.length - toInsert.length;
                res.json({
                    success: true,
                    message: `Đã nạp thành công ${toInsert.length} tài khoản mới vào kho! (Đã tự động loại bỏ ${totalDup} tài khoản bị trùng lặp).`,
                    addedCount: toInsert.length,
                    duplicateCount: totalDup,
                    internalDuplicatesCount: internalDuplicates.length,
                    dbDuplicatesCount: dbDuplicates.length
                });
            });
        });
    });
});

// XEM KHO HÀNG
app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const { productId, variantId, status } = req.query;
    let sql = `SELECT i.*, p.name as product_name, u.username as buyer_name 
               FROM inventory i 
               LEFT JOIN products p ON i.product_id = p.id 
               LEFT JOIN users u ON i.buyer_id = u.id WHERE 1=1`;
    const params = [];

    if (productId) { sql += ` AND i.product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND i.variant_id = ?`; params.push(variantId); }
    if (status === 'available') { sql += ` AND i.is_sold = 0`; }
    if (status === 'sold') { sql += ` AND i.is_sold = 1`; }

    sql += ` ORDER BY i.is_sold ASC, i.id DESC LIMIT 500`;

    db.all(sql, params, (err, rows) => res.json(rows || []));
});

// XUẤT HOẶC SAO CHÉP TOÀN BỘ KHO CÒN LẠI DẠNG TEXT
app.get('/api/admin/export-stock', verifyAdmin, (req, res) => {
    const { productId, variantId } = req.query;
    let sql = `SELECT account_data FROM inventory WHERE is_sold = 0`;
    const params = [];
    if (productId) { sql += ` AND product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND variant_id = ?`; params.push(variantId); }

    db.all(sql, params, (err, rows) => {
        const text = (rows || []).map(r => r.account_data).join('\n');
        res.type('text/plain').send(text);
    });
});

app.delete('/api/admin/inventory/:id', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], () => {
        res.json({ message: 'Đã xóa tài khoản khỏi kho!' });
    });
});

app.post('/api/admin/clean-sold-stock', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM inventory WHERE is_sold = 1`, function(err) {
        res.json({ message: `Đã dọn dẹp ${this.changes || 0} tài khoản đã bán khỏi bộ nhớ kho!` });
    });
});

// QUẢN LÝ THÀNH VIÊN
app.get('/api/admin/users', verifyAdmin, (req, res) => {
    db.all(`SELECT id, username, balance, role, created_at,
            (SELECT COUNT(*) FROM orders WHERE user_id = users.id) as orders_count
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

// QUẢN LÝ ĐƠN NẠP
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
