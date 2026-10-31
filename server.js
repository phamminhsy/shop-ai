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
const DEFAULT_GUIDE = `1. Đăng nhập: Mở trang web chính thức của dịch vụ, nhập chính xác Email và Mật khẩu được giao.
2. Lưu ý tài khoản: Vui lòng đổi mật khẩu và liên kết thông tin cá nhân ngay nếu là tài khoản cấp riêng.
3. Tài khoản Cookie: Nếu định dạng dạng Cookie (json/string), dùng tiện ích Cookie Editor hoặc J2Team Cookies trên Chrome để Import rồi F5 tải lại trang.
4. Chính sách bảo hành: Jerry Shop bảo hành 1 đổi 1 suốt thời gian sử dụng. Nếu gặp sự cố, vui lòng liên hệ Zalo 0982.900.374 kèm mã đơn hàng để được hỗ trợ tức thì!`;

// Khởi tạo Database
db.serialize(() => {
    // 1. Cài đặt hệ thống & Giao diện (Customizer)
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    // 2. Người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT, phone TEXT, password TEXT,
        balance INTEGER DEFAULT 0, role TEXT DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, () => {});

    // 3. Sản phẩm
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, old_price INTEGER DEFAULT 0,
        image TEXT, description TEXT, guide TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE products ADD COLUMN guide TEXT`, () => {});

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

    // Tự động bảo vệ và chữa lành kho inventory
    db.run(`UPDATE inventory SET variant_id = (SELECT id FROM product_variants pv WHERE pv.product_id = inventory.product_id ORDER BY pv.id ASC LIMIT 1) 
            WHERE product_id IN (SELECT id FROM products) 
            AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants))`, () => {});

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
        ['min_deposit', '20000']
    ];
    const sStmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    defaultSettings.forEach(s => sStmt.run(s[0], s[1]));
    sStmt.finalize();

    // Sản phẩm mẫu
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, description, guide) VALUES (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, ?, ?)`,
                [DEFAULT_IMG, '• Tài khoản Muse AI 1 tỷ token dùng riêng tốc độ cao.\n• Bảo hành 1 đổi 1 suốt thời gian sử dụng.\n• Tự động giao acc ngay sau thanh toán.', DEFAULT_GUIDE],
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

// CÀI ĐẶT
app.get('/api/settings', (req, res) => {
    db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
        const obj = {};
        (rows || []).forEach(r => obj[r.key] = r.value);
        res.json(obj);
    });
});

app.post('/api/admin/settings', verifyAdmin, (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Dữ liệu không hợp lệ!' });
    db.serialize(() => {
        const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
        Object.entries(settings).forEach(([k, v]) => stmt.run(k, String(v)));
        stmt.finalize(() => res.json({ message: 'Đã lưu cài đặt giao diện thành công!' }));
    });
});

// AUTHENTICATION
app.post('/api/register', (req, res) => {
    const { username, email, phone, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Vui lòng nhập đủ Tên đăng nhập, Email và Mật khẩu!' });
    const u = username.trim();
    const em = email.trim().toLowerCase();
    const ph = (phone || '').trim();

    if (u.length < 3) return res.status(400).json({ error: 'Tên đăng nhập phải có ít nhất 3 ký tự!' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Địa chỉ Email không đúng định dạng!' });
    if (password.length < 4) return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự!' });

    db.get(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)`, [u, em], (err, exist) => {
        if (exist) return res.status(400).json({ error: 'Tên đăng nhập hoặc Email này đã có người đăng ký!' });
        db.run(`INSERT INTO users (username, email, phone, password, balance, role) VALUES (?, ?, ?, ?, 0, 'user')`,
            [u, em, ph, password],
            function(iErr) {
                if (iErr) return res.status(500).json({ error: 'Lỗi đăng ký tài khoản!' });
                res.json({ id: this.lastID, username: u, email: em, phone: ph, balance: 0, role: 'user' });
            }
        );
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu!' });
    const u = username.trim().toLowerCase();
    db.get(`SELECT id, username, email, phone, balance, role FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND password = ?`, [u, u, password], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Sai tên đăng nhập/email hoặc mật khẩu!' });
        res.json(row);
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, email, phone, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Không tìm thấy người dùng!' });
        res.json(row);
    });
});

// SẢN PHẨM & TÙY CHỌN
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
                return {
                    ...p,
                    guide: p.guide || DEFAULT_GUIDE,
                    variants: vars,
                    min_price: minPrice,
                    total_stock: Number(p.total_stock || 0)
                };
            }));
        });
    });
});

// MUA HÀNG
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!userId || !productId || !variantId) return res.status(400).json({ error: 'Thiếu thông tin đặt hàng!' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản!' });

        db.get(`SELECT p.name as product_name, p.guide as product_guide, pv.name as variant_name, pv.price 
                FROM product_variants pv 
                JOIN products p ON pv.product_id = p.id 
                WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, itemInfo) => {
            if (!itemInfo) return res.status(404).json({ error: 'Gói sản phẩm không tồn tại!' });

            const totalPrice = itemInfo.price * qty;
            if (user.balance < totalPrice) {
                return res.status(400).json({ error: `Số dư không đủ! Bạn cần ${totalPrice.toLocaleString()}đ nhưng ví chỉ còn ${user.balance.toLocaleString()}đ. Vui lòng nạp thêm tiền.` });
            }

            db.all(`SELECT id, account_data FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 LIMIT ?`,
                [productId, variantId, qty], (iErr, items) => {
                if (!items || items.length < qty) {
                    return res.status(400).json({ error: `Rất tiếc, kho chỉ còn ${items ? items.length : 0} tài khoản, không đủ ${qty} tài khoản bạn cần mua!` });
                }

                const d = new Date();
                const yy = String(d.getFullYear()).slice(-2);
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const rand = Math.floor(1000 + Math.random() * 9000);
                const orderCode = `DH-${yy}${mm}${dd}-${rand}`;

                db.serialize(() => {
                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalPrice, userId]);
                    db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, quantity, total_price)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [orderCode, userId, productId, variantId, itemInfo.product_name, itemInfo.variant_name, qty, totalPrice],
                        function(oErr) {
                            const newOrderId = this.lastID;
                            const itemIds = items.map(x => x.id);
                            const placeholders = itemIds.map(() => '?').join(',');

                            db.run(`UPDATE inventory SET is_sold = 1, order_id = ?, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
                                [newOrderId, userId, ...itemIds],
                                () => {
                                    res.json({
                                        success: true,
                                        message: `Thanh toán thành công ${qty} tài khoản!`,
                                        orderId: newOrderId,
                                        orderCode: orderCode,
                                        productName: itemInfo.product_name,
                                        productGuide: itemInfo.product_guide || DEFAULT_GUIDE,
                                        variantName: itemInfo.variant_name,
                                        quantity: qty,
                                        totalPrice: totalPrice,
                                        accounts: items.map(x => x.account_data)
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

// LỊCH SỬ ĐƠN HÀNG
app.get('/api/orders/:userId', (req, res) => {
    const sql = `SELECT o.*, p.guide as product_guide FROM orders o LEFT JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC`;
    db.all(sql, [req.params.userId], (err, orders) => {
        if (!orders || !orders.length) return res.json([]);
        const orderIds = orders.map(o => o.id);
        const placeholders = orderIds.map(() => '?').join(',');
        db.all(`SELECT id, order_id, account_data FROM inventory WHERE order_id IN (${placeholders}) ORDER BY id ASC`, orderIds, (iErr, accRows) => {
            const accMap = {};
            (accRows || []).forEach(a => {
                if (!accMap[a.order_id]) accMap[a.order_id] = [];
                accMap[a.order_id].push(a.account_data);
            });
            res.json(orders.map(o => ({
                ...o,
                guide: o.product_guide || DEFAULT_GUIDE,
                accounts: accMap[o.id] || []
            })));
        });
    });
});

app.get('/api/order-lookup/:code', (req, res) => {
    const code = req.params.code.trim();
    const sql = `SELECT o.*, p.guide as product_guide FROM orders o LEFT JOIN products p ON o.product_id = p.id WHERE UPPER(o.order_code) = UPPER(?) LIMIT 1`;
    db.get(sql, [code], (err, o) => {
        if (!o) return res.status(404).json({ error: 'Không tìm thấy đơn hàng với mã này!' });
        db.all(`SELECT account_data FROM inventory WHERE order_id = ? ORDER BY id ASC`, [o.id], (iErr, accRows) => {
            res.json({
                ...o,
                guide: o.product_guide || DEFAULT_GUIDE,
                accounts: (accRows || []).map(a => a.account_data)
            });
        });
    });
});

// NẠP TIỀN VIETQR
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const val = parseInt(amount);
    if (!val || val <= 0) return res.status(400).json({ error: 'Số tiền nạp không hợp lệ!' });

    db.get(`SELECT value FROM settings WHERE key = 'min_deposit'`, (err, row) => {
        const minDep = row ? parseInt(row.value) : 20000;
        if (val < minDep) return res.status(400).json({ error: `Số tiền nạp tối thiểu là ${minDep.toLocaleString()}đ!` });

        const code = 'NAP' + Math.floor(1000 + Math.random() * 9000);
        db.run(`INSERT INTO transactions (user_id, type, amount, info, status) VALUES (?, 'deposit', ?, ?, 'pending')`,
            [userId, val, code],
            function(tErr) {
                res.json({ txId: this.lastID, code, amount: val });
            }
        );
    });
});

app.get('/api/deposit/check/:txId', (req, res) => {
    db.get(`SELECT * FROM transactions WHERE id = ?`, [req.params.txId], (err, tx) => {
        if (!tx) return res.status(404).json({ error: 'Giao dịch không tồn tại!' });
        res.json(tx);
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [req.params.userId], (err, rows) => res.json(rows || []));
});

// ADMIN APIS
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
    const { name, old_price, image, description, guide, variants } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Phải có ít nhất 1 tùy chọn và giá bán!' });

    db.run(`INSERT INTO products (name, old_price, image, description, guide) VALUES (?, ?, ?, ?, ?)`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, description || '', guide || DEFAULT_GUIDE],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi lưu sản phẩm!' });
            const pid = this.lastID;
            const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
            varList.forEach(v => stmt.run(pid, v.name.trim(), parseInt(v.price) || 0));
            stmt.finalize(() => res.json({ message: 'Đã thêm sản phẩm thành công!', id: pid }));
        }
    );
});

// SỬA SẢN PHẨM: BẢO TOÀN VARIANT ID & TỰ ĐỘNG CHỮA LÀNH KHO INVENTORY
app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, old_price, image, description, guide, variants } = req.body;
    const pid = req.params.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên không được để trống!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Sản phẩm phải có ít nhất 1 tùy chọn giá!' });

    db.run(`UPDATE products SET name = ?, old_price = ?, image = ?, description = ?, guide = ? WHERE id = ?`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, description || '', guide || DEFAULT_GUIDE, pid],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi cập nhật sản phẩm!' });

            db.all(`SELECT id FROM product_variants WHERE product_id = ?`, [pid], (vErr, existingVars) => {
                const existingIds = (existingVars || []).map(v => v.id);
                const keptIds = [];

                const updatePromises = varList.map(v => {
                    return new Promise(resolve => {
                        const vId = parseInt(v.id);
                        if (vId && existingIds.includes(vId)) {
                            keptIds.push(vId);
                            db.run(`UPDATE product_variants SET name = ?, price = ? WHERE id = ?`,
                                [v.name.trim(), parseInt(v.price) || 0, vId],
                                () => resolve(vId)
                            );
                        } else {
                            db.run(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`,
                                [pid, v.name.trim(), parseInt(v.price) || 0],
                                function() {
                                    keptIds.push(this.lastID);
                                    resolve(this.lastID);
                                }
                            );
                        }
                    });
                });

                Promise.all(updatePromises).then(() => {
                    const toDelete = existingIds.filter(id => !keptIds.includes(id));
                    const completeUpdate = () => {
                        db.get(`SELECT id FROM product_variants WHERE product_id = ? ORDER BY id ASC LIMIT 1`, [pid], (fErr, firstVar) => {
                            if (firstVar) {
                                db.run(`UPDATE inventory SET variant_id = ? 
                                        WHERE product_id = ? 
                                        AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants WHERE product_id = ?))`,
                                    [firstVar.id, pid, pid],
                                    () => res.json({ message: 'Đã lưu thay đổi sản phẩm & bảo toàn kho tài khoản thành công!' })
                                );
                            } else {
                                res.json({ message: 'Đã lưu thay đổi sản phẩm!' });
                            }
                        });
                    };

                    if (toDelete.length) {
                        const placeholders = toDelete.map(() => '?').join(',');
                        db.run(`DELETE FROM product_variants WHERE id IN (${placeholders})`, toDelete, completeUpdate);
                    } else {
                        completeUpdate();
                    }
                });
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

// NẠP KHO CHỐNG TRÙNG ACC
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
    sql += ` ORDER BY i.is_sold ASC, i.id DESC LIMIT 500`;
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

// XÓA HÀNG LOẠT (BULK DELETE)
app.post('/api/admin/inventory/delete-bulk', verifyAdmin, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Chưa chọn tài khoản nào để xóa!' });
    const validIds = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
    if (!validIds.length) return res.status(400).json({ error: 'Danh sách ID không hợp lệ!' });

    const placeholders = validIds.map(() => '?').join(',');
    db.run(`DELETE FROM inventory WHERE id IN (${placeholders})`, validIds, function(err) {
        if (err) return res.status(500).json({ error: 'Lỗi khi xóa tài khoản!' });
        res.json({ message: `Đã xóa thành công ${this.changes} tài khoản được chọn khỏi kho!` });
    });
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
    db.all(`SELECT id, username, email, phone, balance, role, created_at, (SELECT COUNT(*) FROM orders WHERE user_id = users.id) as orders_count FROM users ORDER BY id DESC`, [], (err, rows) => res.json(rows || []));
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
