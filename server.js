const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));
const DEFAULT_IMG = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';

// Khởi tạo Database
db.serialize(() => {
    // 1. Cài đặt hệ thống & Giao diện (Customizer)
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    // 2. Người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT,
        balance INTEGER DEFAULT 0, role TEXT DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Sản phẩm
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, old_price INTEGER DEFAULT 0,
        image TEXT, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Tùy chọn sản phẩm động
    db.run(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, name TEXT, price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // 5. Đơn hàng (Gộp toàn bộ acc trong 1 lần mua)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, user_id INTEGER,
        product_id INTEGER, variant_id INTEGER, product_name TEXT, variant_name TEXT,
        quantity INTEGER DEFAULT 1, total_price INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 6. Kho hàng (Liên kết với order_id khi bán)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, variant_id INTEGER,
        variant_name TEXT, account_data TEXT, is_sold INTEGER DEFAULT 0,
        order_id INTEGER, buyer_id INTEGER, sold_at DATETIME
    )`);
    db.run(`ALTER TABLE inventory ADD COLUMN order_id INTEGER`, () => {});

    // 7. Giao dịch nạp tiền
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'deposit',
        amount INTEGER, info TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tài khoản Admin mặc định: admin / 123456
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) VALUES ('admin', '123456', 500000, 'admin')`);

    // Cài đặt shop mặc định
    const defaultSettings = [
        ['site_name', 'JERRY <span class="text-yellow-300">SHOP</span>'],
        ['site_slogan', 'Tài Khoản AI Giá Siêu Rẻ'],
        ['site_logo', ''],
        ['site_hotline', '0982.900.374'],
        ['site_zalo', '0982900374'],
        ['site_notice', 'Jerry Shop - Hệ thống giao tài khoản tự động 24/7'],
        ['site_banner_title', 'Nhấn trực tiếp vào sản phẩm để chọn gói và số lượng mua!'],
        ['site_banner_desc', 'Hệ thống phân phối tài khoản cấp sẵn dùng riêng, tự động bàn giao ngay sau 3 giây thanh toán.'],
        ['bank_id', 'MB'],
        ['bank_name', 'MB BANK (Quân Đội)'],
        ['bank_account', '5428102008'],
        ['bank_owner', 'JERRY SHOP'],
        ['min_deposit', '20000'],
        ['theme_color', 'default'],
        ['container_width', 'standard']
    ];
    const sStmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    defaultSettings.forEach(s => sStmt.run(s[0], s[1]));
    sStmt.finalize();

    // Sản phẩm mẫu AI kèm kho mẫu
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, description) VALUES (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, ?)`,
                [DEFAULT_IMG, '• Tài khoản Muse AI 1 tỷ token dùng riêng tốc độ cao.\n• Bảo hành 1 đổi 1 suốt thời gian sử dụng.\n• Tự động giao acc ngay sau thanh toán.'],
                function() {
                    const pid = 1;
                    db.run(`INSERT INTO product_variants (id, product_id, name, price) VALUES 
                        (1, ?, 'Tài khoản thường (Email | Mật khẩu)', 35000),
                        (2, ?, 'Tài khoản kèm Cookie (Đăng nhập tức thì)', 45000)`, [pid, pid], () => {
                        const invStmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
                        ['muse_vip01@gmail.com|JerryShop#992', 'muse_vip02@gmail.com|JerryShop#881', 'muse_vip03@gmail.com|JerryShop#774'].forEach(a => invStmt.run(pid, 1, 'Tài khoản thường (Email | Mật khẩu)', a));
                        ['muse_cookie01@gmail.com|Pass@123|session=eyJh...', 'muse_cookie02@gmail.com|Pass@456|session=eyJh...'].forEach(a => invStmt.run(pid, 2, 'Tài khoản kèm Cookie (Đăng nhập tức thì)', a));
                        invStmt.finalize();
                    });
                }
            );
        }
    });
});

function verifyAdmin(req, res, next) {
    const adminId = req.headers['x-admin-id'] || req.body.adminId;
    if (!adminId) return res.status(403).json({ error: 'Không có quyền truy cập!' });
    db.get(`SELECT role FROM users WHERE id = ?`, [adminId], (err, u) => {
        if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Chỉ Quản trị viên mới được thao tác!' });
        next();
    });
}

// ================= CÀI ĐẶT & GIAO DIỆN (SETTINGS) =================
app.get('/api/settings', (req, res) => {
    db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
        const obj = {};
        (rows || []).forEach(r => obj[r.key] = r.value);
        res.json(obj);
    });
});

app.post('/api/admin/settings', verifyAdmin, (req, res) => {
    const s = req.body.settings || {};
    const keys = Object.keys(s);
    if (!keys.length) return res.status(400).json({ error: 'Không có dữ liệu cài đặt' });
    db.serialize(() => {
        const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
        keys.forEach(k => stmt.run(k, String(s[k])));
        stmt.finalize(() => res.json({ message: 'Đã lưu cài đặt giao diện và hệ thống thành công!' }));
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
    const sql = `SELECT p.*,
        (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 0) as total_stock,
        (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id AND i.is_sold = 1) as total_sold
        FROM products p ORDER BY p.id DESC`;
    db.all(sql, [], (err, prods) => {
        if (!prods || !prods.length) return res.json([]);
        db.all(`SELECT pv.*, (SELECT COUNT(*) FROM inventory i WHERE i.variant_id = pv.id AND i.is_sold = 0) as stock FROM product_variants pv ORDER BY pv.id ASC`, [], (vErr, variants) => {
            const map = {};
            (variants || []).forEach(v => { (map[v.product_id] = map[v.product_id] || []).push(v); });
            res.json(prods.map(p => {
                const vars = map[p.id] || [];
                const minPrice = vars.length ? Math.min(...vars.map(v => v.price)) : (p.price || 0);
                return { ...p, variants: vars, min_price: minPrice, total_stock: Number(p.total_stock || 0) };
            }));
        });
    });
});

// ================= MUA HÀNG (TẠO ĐƠN HÀNG GỘP TẤT CẢ ACC) =================
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!userId || !productId || !variantId) return res.status(400).json({ error: 'Thiếu thông tin đặt hàng!' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(400).json({ error: 'Vui lòng đăng nhập trước khi mua!' });
        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (pErr, product) => {
            if (!product) return res.status(400).json({ error: 'Sản phẩm không tồn tại!' });
            db.get(`SELECT * FROM product_variants WHERE id = ? AND product_id = ?`, [variantId, productId], (vErr, variant) => {
                if (!variant) return res.status(400).json({ error: 'Tùy chọn không hợp lệ!' });

                const unitPrice = Number(variant.price || 0);
                const totalCost = unitPrice * qty;
                if (user.balance < totalCost) return res.status(400).json({ error: `Số dư ví không đủ! Cần ${totalCost.toLocaleString()}đ nhưng ví có ${user.balance.toLocaleString()}đ.` });

                db.all(`SELECT * FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 LIMIT ?`, [productId, variantId, qty], (invErr, items) => {
                    if (!items || items.length < qty) return res.status(400).json({ error: `Kho [${variant.name}] chỉ còn ${items ? items.length : 0} acc, không đủ số lượng ${qty}!` });

                    const ids = items.map(i => i.id);
                    const placeholders = ids.map(() => '?').join(',');
                    const now = new Date();
                    const dateStr = String(now.getFullYear()).slice(2) + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
                    const orderCode = `DH-${dateStr}-${Math.floor(1000 + Math.random() * 9000)}`;

                    db.serialize(() => {
                        db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalCost, userId]);
                        db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, quantity, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [orderCode, userId, productId, variantId, product.name, variant.name, qty, totalCost],
                            function(oErr) {
                                if (oErr) return res.status(500).json({ error: 'Lỗi khi tạo đơn hàng!' });
                                const orderId = this.lastID;
                                db.run(`UPDATE inventory SET is_sold = 1, order_id = ?, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
                                    [orderId, userId, ...ids],
                                    (upErr) => {
                                        if (upErr) return res.status(500).json({ error: 'Lỗi bàn giao tài khoản!' });
                                        res.json({
                                            message: `Thanh toán thành công ${qty} tài khoản!`,
                                            orderCode, orderId, productName: product.name, variantName: variant.name,
                                            totalCost, quantity: qty, accounts: items.map(i => i.account_data)
                                        });
                                    }
                                );
                            }
                        );
                    });
                });
            });
        });
    });
});

// LỊCH SỬ ĐƠN HÀNG: GỘP TẤT CẢ ACC THEO ĐƠN HÀNG
app.get('/api/orders/:userId', (req, res) => {
    db.all(`SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC`, [req.params.userId], (err, orders) => {
        if (!orders || !orders.length) return res.json([]);
        db.all(`SELECT id, order_id, account_data FROM inventory WHERE buyer_id = ? AND is_sold = 1 ORDER BY id ASC`, [req.params.userId], (iErr, items) => {
            const map = {};
            (items || []).forEach(it => { (map[it.order_id] = map[it.order_id] || []).push(it.account_data); });
            res.json(orders.map(o => ({ ...o, accounts: map[o.id] || [] })));
        });
    });
});

// Tra cứu đơn hàng nhanh (không cần login)
app.get('/api/order-lookup/:code', (req, res) => {
    const code = req.params.code.trim().toUpperCase();
    db.get(`SELECT * FROM orders WHERE order_code = ?`, [code], (err, order) => {
        if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng với mã này!' });
        db.all(`SELECT account_data FROM inventory WHERE order_id = ?`, [order.id], (iErr, items) => {
            res.json({ ...order, accounts: (items || []).map(i => i.account_data) });
        });
    });
});

// ================= NẠP TIỀN & WEBHOOK SEPAY =================
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const num = parseInt(amount);
    if (!num || num < 20000) return res.status(400).json({ error: 'Định mức nạp tối thiểu là 20.000đ!' });
    db.run(`INSERT INTO transactions (user_id, type, amount, info, status) VALUES (?, 'deposit', ?, 'TEMP', 'pending')`, [userId, num], function(err) {
        const txId = this.lastID;
        const code = `NAP${txId + 100}`;
        db.run(`UPDATE transactions SET info = ? WHERE id = ?`, [code, txId], () => res.json({ txId, code, amount: num }));
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
    const amount = parseInt(req.body.transferAmount || req.body.amount || (req.body.data && req.body.data[0]?.amount) || 0);
    const match = content.match(/NAP\d+/);
    if (!match) return res.json({ success: false, message: 'Không tìm thấy mã NAP' });

    const code = match[0];
    db.get(`SELECT * FROM transactions WHERE info = ? AND status = 'pending'`, [code], (err, tx) => {
        if (!tx) return res.json({ success: false, message: 'Đơn không tồn tại hoặc đã xử lý' });
        const addAmount = amount >= 20000 ? amount : tx.amount;
        db.serialize(() => {
            db.run(`UPDATE transactions SET status = 'completed', amount = ? WHERE id = ?`, [addAmount, tx.id]);
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [addAmount, tx.user_id]);
            res.json({ success: true, message: `Đã cộng ${addAmount}đ cho mã ${code}` });
        });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => res.json(rows || []));
});

// ================= ADMIN API =================
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    const s = {};
    db.get(`SELECT COUNT(*) as totalUsers FROM users`, (e1, r1) => {
        s.totalUsers = r1 ? r1.totalUsers : 0;
        db.get(`SELECT COUNT(*) as totalOrders, COALESCE(SUM(total_price), 0) as totalRevenue FROM orders`, (e2, r2) => {
            s.totalOrders = r2 ? r2.totalOrders : 0;
            s.totalRevenue = r2 ? r2.totalRevenue : 0;
            db.get(`SELECT COUNT(*) as totalSold FROM inventory WHERE is_sold = 1`, (e3, r3) => {
                s.totalSold = r3 ? r3.totalSold : 0;
                db.get(`SELECT COUNT(*) as totalStock FROM inventory WHERE is_sold = 0`, (e4, r4) => {
                    s.totalStock = r4 ? r4.totalStock : 0;
                    db.get(`SELECT COUNT(*) as pendingTx FROM transactions WHERE status = 'pending'`, (e5, r5) => {
                        s.pendingTx = r5 ? r5.pendingTx : 0;
                        res.json(s);
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
    if (!varList.length) return res.status(400).json({ error: 'Phải có ít nhất 1 tùy chọn và giá bán!' });

    db.run(`INSERT INTO products (name, old_price, image, description) VALUES (?, ?, ?, ?)`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, description || ''],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi lưu sản phẩm!' });
            const pid = this.lastID;
            const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
            varList.forEach(v => stmt.run(pid, v.name.trim(), parseInt(v.price) || 0));
            stmt.finalize(() => res.json({ message: 'Đã thêm sản phẩm thành công!', id: pid }));
        }
    );
});

app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, old_price, image, description, variants } = req.body;
    const pid = req.params.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên không được để trống!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];

    db.run(`UPDATE products SET name = ?, old_price = ?, image = ?, description = ? WHERE id = ?`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, description || '', pid],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi cập nhật!' });
            db.run(`DELETE FROM product_variants WHERE product_id = ?`, [pid], () => {
                const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
                varList.forEach(v => stmt.run(pid, v.name.trim(), parseInt(v.price) || 0));
                stmt.finalize(() => res.json({ message: 'Đã lưu thay đổi sản phẩm!' }));
            });
        }
    );
});

app.delete('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const pid = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM inventory WHERE product_id = ? AND is_sold = 0`, [pid]);
        db.run(`DELETE FROM product_variants WHERE product_id = ?`, [pid]);
        db.run(`DELETE FROM products WHERE id = ?`, [pid], () => res.json({ message: 'Đã xóa sản phẩm!' }));
    });
});

// NẠP KHO VỚI BỘ LỌC CHỐNG TRÙNG ACC 2 LỚP
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variantId, accountsText } = req.body;
    if (!productId || !variantId || !accountsText || !accountsText.trim()) {
        return res.status(400).json({ error: 'Vui lòng chọn tùy chọn và dán danh sách tài khoản!' });
    }

    db.get(`SELECT * FROM product_variants WHERE id = ? AND product_id = ?`, [variantId, productId], (vErr, variant) => {
        if (!variant) return res.status(400).json({ error: 'Tùy chọn không tồn tại!' });

        const rawLines = accountsText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) return res.status(400).json({ error: 'Danh sách dán vào trống!' });

        const uniqueSet = new Set();
        const uniqueLines = [];
        rawLines.forEach(l => { if (!uniqueSet.has(l)) { uniqueSet.add(l); uniqueLines.push(l); } });

        db.all(`SELECT account_data FROM inventory WHERE product_id = ?`, [productId], (dbErr, existingItems) => {
            const dbSet = new Set((existingItems || []).map(i => i.account_data));
            const toInsert = uniqueLines.filter(l => !dbSet.has(l));

            if (!toInsert.length) {
                return res.status(400).json({ error: `Tất cả ${rawLines.length} acc dán vào đều đã tồn tại trong kho hoặc bị trùng lặp! Không có acc mới nào được thêm.` });
            }

            const stmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold) VALUES (?, ?, ?, ?, 0)`);
            toInsert.forEach(acc => stmt.run(productId, variantId, variant.name, acc));
            stmt.finalize(() => {
                const totalDup = rawLines.length - toInsert.length;
                res.json({
                    success: true,
                    message: `Đã nạp thành công ${toInsert.length} tài khoản mới vào kho! (Đã tự động loại bỏ ${totalDup} tài khoản bị trùng lặp).`,
                    addedCount: toInsert.length, duplicateCount: totalDup
                });
            });
        });
    });
});

app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const { productId, variantId } = req.query;
    let sql = `SELECT i.*, p.name as product_name, u.username as buyer_name FROM inventory i LEFT JOIN products p ON i.product_id = p.id LEFT JOIN users u ON i.buyer_id = u.id WHERE 1=1`;
    const params = [];
    if (productId) { sql += ` AND i.product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND i.variant_id = ?`; params.push(variantId); }
    sql += ` ORDER BY i.is_sold ASC, i.id DESC LIMIT 400`;
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.get('/api/admin/export-stock', verifyAdmin, (req, res) => {
    const { productId } = req.query;
    let sql = `SELECT account_data FROM inventory WHERE is_sold = 0`;
    const params = [];
    if (productId) { sql += ` AND product_id = ?`; params.push(productId); }
    db.all(sql, params, (err, rows) => res.type('text/plain').send((rows || []).map(r => r.account_data).join('\n')));
});

app.delete('/api/admin/inventory/:id', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], () => res.json({ message: 'Đã xóa tài khoản khỏi kho!' }));
});

app.post('/api/admin/clean-sold-stock', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM inventory WHERE is_sold = 1`, function() {
        res.json({ message: `Đã dọn dẹp ${this.changes || 0} tài khoản đã bán khỏi kho!` });
    });
});

app.get('/api/admin/users', verifyAdmin, (req, res) => {
    db.all(`SELECT id, username, balance, role, created_at, (SELECT COUNT(*) FROM orders WHERE user_id = users.id) as orders_count FROM users ORDER BY id DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/balance', verifyAdmin, (req, res) => {
    const { userId, amount } = req.body;
    const val = parseInt(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Số tiền không hợp lệ!' });
    db.run(`UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?`, [val, userId], () => res.json({ message: 'Đã cập nhật số dư thành viên!' }));
});

app.get('/api/admin/transactions', verifyAdmin, (req, res) => {
    db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/approve-tx', verifyAdmin, (req, res) => {
    const { txId, action } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'pending'`, [txId], (err, tx) => {
        if (!tx) return res.status(400).json({ error: 'Giao dịch không tồn tại hoặc đã xử lý!' });
        if (action === 'cancel') {
            db.run(`UPDATE transactions SET status = 'cancelled' WHERE id = ?`, [txId], () => res.json({ message: 'Đã hủy đơn nạp tiền!' }));
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
