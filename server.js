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
4. Chính sách bảo hành: Jerry Shop bảo hành login và bảo hành tạo video trong vòng 12h kể từ lúc nhận tài khoản. Hỗ trợ 1 đổi 1 nhanh chóng qua Zalo 0982.900.374 nếu lỗi phát sinh trong thời gian bảo hành.`;

// Khởi tạo Database
db.serialize(() => {
    // 1. Cài đặt hệ thống & Giao diện
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    // 2. Người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT, phone TEXT, password TEXT,
        balance INTEGER DEFAULT 0, role TEXT DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, () => {});

    // Bảng lưu mã OTP quên mật khẩu (hạn 5 phút)
    db.run(`CREATE TABLE IF NOT EXISTS password_resets (
        email TEXT PRIMARY KEY, otp TEXT, expires_at DATETIME
    )`);

    // Bảng mã giảm giá (Coupons / Voucher)
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE,
        discount_type TEXT DEFAULT 'percent', discount_value INTEGER DEFAULT 10,
        min_order INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 500, used_count INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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
        quantity INTEGER DEFAULT 1, total_price INTEGER DEFAULT 0, discount_amount INTEGER DEFAULT 0,
        coupon_code TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE orders ADD COLUMN coupon_code TEXT`, () => {});

    // 6. Kho hàng
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, variant_id INTEGER,
        variant_name TEXT, account_data TEXT, is_sold INTEGER DEFAULT 0,
        order_id INTEGER, buyer_id INTEGER, sold_at DATETIME
    )`);
    db.run(`ALTER TABLE inventory ADD COLUMN order_id INTEGER`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN buyer_id INTEGER`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN sold_at DATETIME`, () => {});

    // 7. Giao dịch nạp tiền
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'deposit',
        amount INTEGER, info TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tự động bảo vệ và chữa lành kho inventory: Nếu có acc nào bị mất variant_id do lần sửa cũ, nối lại ngay với variant đầu tiên
    db.run(`UPDATE inventory SET variant_id = (SELECT id FROM product_variants pv WHERE pv.product_id = inventory.product_id ORDER BY pv.id ASC LIMIT 1) 
            WHERE product_id IN (SELECT id FROM products) 
            AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants))`, () => {});

    // Tài khoản Admin mặc định: admin / 123456
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) VALUES ('admin', '123456', 500000, 'admin')`);

    // Tạo sẵn 2 mã giảm giá chào mừng
    db.run(`INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, min_order, max_uses) VALUES ('JERRY10', 'percent', 10, 0, 500)`);
    db.run(`INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, min_order, max_uses) VALUES ('CHAOBAN', 'fixed', 5000, 30000, 500)`);

    // Cài đặt shop mặc định
    const defaultSettings = [
        ['site_name', 'JERRY <span class="text-yellow-300">SHOP</span>'],
        ['site_slogan', 'Tài Khoản AI Giá Siêu Rẻ'],
        ['site_logo', ''],
        ['site_hotline', '0982.900.374'],
        ['site_zalo', '0982900374'],
        ['site_notice', 'Jerry Shop - Giao tài khoản AI tự động 24/7 • Bảo hành login và tạo video 12h'],
        ['site_banner_title', 'Bấm trực tiếp vào sản phẩm để chọn gói và số lượng mua!'],
        ['site_banner_desc', 'Hệ thống phân phối tài khoản cấp sẵn dùng riêng, tự động bàn giao ngay sau 3 giây thanh toán. Bảo hành 12h uy tín 1 đổi 1.'],
        ['bank_id', 'MB'],
        ['bank_name', 'MB BANK (Quân Đội)'],
        ['bank_account', '5428102008'],
        ['bank_owner', 'JERRY SHOP'],
        ['min_deposit', '20000'],
        ['popup_banner_active', '1'],
        ['popup_banner_title', '🎉 ƯU ĐÃI CHÀO BẠN MỚI TẠI JERRY SHOP!'],
        ['popup_banner_content', 'Nhập ngay mã giảm giá [JERRY10] khi mua để được giảm 10% cho mọi đơn hàng. Chúc bạn có trải nghiệm tuyệt vời!']
    ];
    const sStmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    defaultSettings.forEach(s => sStmt.run(s[0], s[1]));
    sStmt.finalize();

    // Sản phẩm mẫu
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, description, guide) VALUES (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, ?, ?)`,
                [DEFAULT_IMG, '• Tài khoản Muse AI 1 tỷ token dùng riêng tốc độ cao.\n• Bảo hành login và tạo video trong vòng 12h.\n• Tự động giao acc ngay sau thanh toán.', DEFAULT_GUIDE],
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

// ================= AUTHENTICATION =================
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

// QUÊN MẬT KHẨU: GỬI MÃ OTP ĐẾN EMAIL
app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email || !email.trim()) return res.status(400).json({ error: 'Vui lòng nhập địa chỉ Email!' });
    const em = email.trim().toLowerCase();

    db.get(`SELECT id, username FROM users WHERE LOWER(email) = ?`, [em], (err, user) => {
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản nào khớp với Email này!' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

        db.run(`INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET otp = excluded.otp, expires_at = excluded.expires_at`,
            [em, otp, expiresAt],
            (rErr) => {
                if (rErr) return res.status(500).json({ error: 'Lỗi khi tạo mã OTP!' });
                res.json({
                    success: true,
                    message: `Mã OTP xác nhận gồm 6 chữ số đã được tạo cho email ${em}!`,
                    otpCode: otp
                });
            }
        );
    });
});

// ĐẶT LẠI MẬT KHẨU BẰNG OTP
app.post('/api/reset-password', (req, res) => {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: 'Vui lòng điền đủ Email, mã OTP và Mật khẩu mới!' });
    const em = email.trim().toLowerCase();
    const cleanOtp = otp.trim();

    if (newPassword.length < 4) return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 4 ký tự!' });

    db.get(`SELECT * FROM password_resets WHERE email = ?`, [em], (err, row) => {
        if (!row || row.otp !== cleanOtp) {
            return res.status(400).json({ error: 'Mã OTP không chính xác!' });
        }
        if (new Date(row.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Mã OTP đã hết hạn (chỉ có hiệu lực trong 5 phút). Vui lòng yêu cầu mã mới!' });
        }

        db.run(`UPDATE users SET password = ? WHERE LOWER(email) = ?`, [newPassword, em], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'Lỗi cập nhật mật khẩu!' });
            db.run(`DELETE FROM password_resets WHERE email = ?`, [em], () => {});
            res.json({ success: true, message: '🎉 Đổi mật khẩu thành công! Bây giờ bạn có thể đăng nhập bằng mật khẩu mới.' });
        });
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, email, phone, balance, role FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Không tìm thấy người dùng!' });
        res.json(row);
    });
});

// ================= MÃ GIẢM GIÁ (COUPON CODES) =================
app.post('/api/coupon/apply', (req, res) => {
    const { code, totalAmount } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'Vui lòng nhập mã giảm giá!' });
    const c = code.trim().toUpperCase();
    const total = parseInt(totalAmount) || 0;

    db.get(`SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1`, [c], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Mã giảm giá không hợp lệ hoặc đã hết hạn!' });
        if (row.max_uses && row.used_count >= row.max_uses) {
            return res.status(400).json({ error: 'Mã giảm giá này đã hết lượt sử dụng!' });
        }
        if (row.min_order && total < row.min_order) {
            return res.status(400).json({ error: `Mã này chỉ áp dụng cho đơn từ ${row.min_order.toLocaleString()}đ trở lên!` });
        }

        let discount = 0;
        if (row.discount_type === 'percent') {
            discount = Math.round((total * row.discount_value) / 100);
        } else {
            discount = row.discount_value;
        }
        discount = Math.min(discount, total);
        const finalTotal = Math.max(0, total - discount);

        res.json({
            valid: true,
            code: row.code,
            discountType: row.discount_type,
            discountValue: row.discount_value,
            discountAmount: discount,
            finalTotal: finalTotal,
            message: `Áp dụng mã ${row.code} thành công! Tiết kiệm: ${discount.toLocaleString()}đ.`
        });
    });
});

app.get('/api/admin/coupons', verifyAdmin, (req, res) => {
    db.all(`SELECT * FROM coupons ORDER BY id DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/admin/coupons', verifyAdmin, (req, res) => {
    const { code, discount_type, discount_value, min_order, max_uses } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'Vui lòng nhập mã code!' });
    const c = code.trim().toUpperCase();
    const type = discount_type === 'fixed' ? 'fixed' : 'percent';
    const val = parseInt(discount_value) || 10;
    const minO = parseInt(min_order) || 0;
    const maxU = parseInt(max_uses) || 500;

    db.run(`INSERT INTO coupons (code, discount_type, discount_value, min_order, max_uses) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET discount_type = excluded.discount_type, discount_value = excluded.discount_value, min_order = excluded.min_order, max_uses = excluded.max_uses, is_active = 1`,
        [c, type, val, minO, maxU],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi lưu mã giảm giá!' });
            res.json({ message: 'Đã lưu mã giảm giá thành công!' });
        }
    );
});

app.delete('/api/admin/coupons/:id', verifyAdmin, (req, res) => {
    db.run(`DELETE FROM coupons WHERE id = ?`, [req.params.id], () => res.json({ message: 'Đã xóa mã giảm giá!' }));
});

// ================= LIVE ORDER TICKER (HOẠT ĐỘNG MUA HÀNG THỜI GIAN THỰC) =================
app.get('/api/live-activities', (req, res) => {
    const sql = `
        SELECT o.id, o.order_code, o.product_name, o.variant_name, o.quantity, o.created_at, u.username
        FROM orders o 
        LEFT JOIN users u ON o.user_id = u.id 
        ORDER BY o.id DESC LIMIT 15
    `;
    db.all(sql, [], (err, rows) => {
        if (!rows || !rows.length) {
            // Dữ liệu mẫu thực tế nếu shop vừa khởi động
            return res.json([
                { id: 1, masked_user: 'huy***26', product_name: 'Tài khoản Muse AI 1 tỷ token', quantity: 1, time_ago: '1 phút trước' },
                { id: 2, masked_user: 'linh***99', product_name: 'Tài khoản ChatGPT Plus', quantity: 1, time_ago: '4 phút trước' },
                { id: 3, masked_user: 'thanh***88', product_name: 'Tài khoản Claude Pro', quantity: 2, time_ago: '8 phút trước' }
            ]);
        }
        res.json(rows.map(r => {
            const u = r.username || 'Khách';
            const masked = u.length > 3 ? u.substring(0, 2) + '***' + u.slice(-2) : u + '***';
            return {
                id: r.id,
                order_code: r.order_code,
                masked_user: masked,
                product_name: r.product_name,
                variant_name: r.variant_name,
                quantity: r.quantity,
                created_at: r.created_at
            };
        }));
    });
});

// ================= SẢN PHẨM & TÙY CHỌN =================
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

// ================= MUA HÀNG (ÁP DỤNG MÃ GIẢM GIÁ & TẠO ĐƠN) =================
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity, couponCode } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!userId || !productId || !variantId) return res.status(400).json({ error: 'Thiếu thông tin đặt hàng!' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản!' });

        db.get(`SELECT p.name as product_name, p.guide as product_guide, pv.name as variant_name, pv.price 
                FROM product_variants pv 
                JOIN products p ON pv.product_id = p.id 
                WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, itemInfo) => {
            if (!itemInfo) return res.status(404).json({ error: 'Gói sản phẩm không tồn tại!' });

            let subtotal = itemInfo.price * qty;
            let discountAmount = 0;
            let finalCoupon = null;

            const proceedPurchase = () => {
                const totalPrice = Math.max(0, subtotal - discountAmount);
                if (user.balance < totalPrice) {
                    const diff = totalPrice - user.balance;
                    return res.status(400).json({
                        error: `Số dư ví không đủ! Đơn hàng cần ${totalPrice.toLocaleString()}đ, ví của bạn hiện có ${user.balance.toLocaleString()}đ (còn thiếu ${diff.toLocaleString()}đ).`,
                        missingAmount: diff
                    });
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
                        if (finalCoupon) {
                            db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE UPPER(code) = ?`, [finalCoupon]);
                        }
                        db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, quantity, total_price, discount_amount, coupon_code)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [orderCode, userId, productId, variantId, itemInfo.product_name, itemInfo.variant_name, qty, totalPrice, discountAmount, finalCoupon || ''],
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
                                            discountAmount: discountAmount,
                                            accounts: items.map(x => x.account_data)
                                        });
                                    }
                                );
                            }
                        );
                    });
                });
            };

            if (couponCode && couponCode.trim()) {
                const c = couponCode.trim().toUpperCase();
                db.get(`SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1`, [c], (cErr, coupon) => {
                    if (coupon && (!coupon.max_uses || coupon.used_count < coupon.max_uses) && (!coupon.min_order || subtotal >= coupon.min_order)) {
                        if (coupon.discount_type === 'percent') {
                            discountAmount = Math.round((subtotal * coupon.discount_value) / 100);
                        } else {
                            discountAmount = coupon.discount_value;
                        }
                        discountAmount = Math.min(discountAmount, subtotal);
                        finalCoupon = coupon.code;
                    }
                    proceedPurchase();
                });
            } else {
                proceedPurchase();
            }
        });
    });
});

// ================= ĐỔI BẢO HÀNH 1-CLICK DÀNH CHO ADMIN =================
app.post('/api/admin/warranty/exchange', verifyAdmin, (req, res) => {
    const { orderId, oldAccountId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Thiếu mã đơn hàng!' });

    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng!' });

        // Tìm 1 acc mới còn trong kho của đúng sản phẩm và gói đó
        db.get(`SELECT id, account_data FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 LIMIT 1`,
            [order.product_id, order.variant_id],
            (iErr, newAcc) => {
                if (!newAcc) return res.status(400).json({ error: 'Kho hiện đã hết tài khoản dự phòng của gói này để đổi!' });

                db.serialize(() => {
                    // Nếu có chỉ định oldAccountId thì đánh dấu đã đổi
                    if (oldAccountId) {
                        db.run(`UPDATE inventory SET is_sold = 2 WHERE id = ?`, [oldAccountId]);
                    }
                    // Gán acc mới vào đơn hàng này
                    db.run(`UPDATE inventory SET is_sold = 1, order_id = ?, buyer_id = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [order.id, order.user_id, newAcc.id],
                        () => {
                            res.json({
                                success: true,
                                message: `Đã đổi 1 tài khoản mới thành công cho đơn #${order.order_code}!`,
                                newAccount: newAcc.account_data
                            });
                        }
                    );
                });
            }
        );
    });
});

// LỊCH SỬ ĐƠN HÀNG CỦA KHÁCH
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

app.post('/api/deposit/notify-paid', (req, res) => {
    const { txId } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ?`, [txId], (err, tx) => {
        if (!tx) return res.status(404).json({ error: 'Không tìm thấy giao dịch!' });
        res.json({ message: 'Đã gửi thông báo xác nhận chuyển khoản tới Admin! Hệ thống sẽ duyệt ngay.' });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [req.params.userId], (err, rows) => res.json(rows || []));
});

// ================= ADMIN APIS =================
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    const s = {};
    db.get(`SELECT COUNT(*) as totalUsers FROM users WHERE role != 'admin'`, (e1, r1) => {
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

// QUẢN LÝ DÒNG TIỀN (CASH FLOW)
app.get('/api/admin/cashflow', verifyAdmin, (req, res) => {
    const cf = {};
    db.get(`SELECT COALESCE(SUM(amount), 0) as totalDeposits FROM transactions WHERE status = 'completed'`, (e1, r1) => {
        cf.totalDeposits = r1 ? r1.totalDeposits : 0;
        db.get(`SELECT COALESCE(SUM(total_price), 0) as totalRevenue, COUNT(*) as totalOrders FROM orders`, (e2, r2) => {
            cf.totalRevenue = r2 ? r2.totalRevenue : 0;
            cf.totalOrders = r2 ? r2.totalOrders : 0;
            db.get(`SELECT COALESCE(SUM(balance), 0) as totalUserBalances FROM users WHERE role != 'admin'`, (e3, r3) => {
                cf.totalUserBalances = r3 ? r3.totalUserBalances : 0;
                db.get(`SELECT COALESCE(SUM(amount), 0) as pendingDepositSum, COUNT(*) as pendingDepositCount FROM transactions WHERE status = 'pending'`, (e4, r4) => {
                    cf.pendingDepositSum = r4 ? r4.pendingDepositSum : 0;
                    cf.pendingDepositCount = r4 ? r4.pendingDepositCount : 0;

                    const activitySql = `
                        SELECT 'deposit' as kind, t.id as ref_id, u.username, t.amount, t.info as memo, t.status, t.created_at
                        FROM transactions t JOIN users u ON t.user_id = u.id
                        UNION ALL
                        SELECT 'order' as kind, o.id as ref_id, u.username, o.total_price as amount, o.order_code as memo, 'completed' as status, o.created_at
                        FROM orders o JOIN users u ON o.user_id = u.id
                        ORDER BY created_at DESC LIMIT 40
                    `;
                    db.all(activitySql, [], (e5, rows) => {
                        cf.activities = rows || [];
                        res.json(cf);
                    });
                });
            });
        });
    });
});

// LỊCH SỬ BÁN HÀNG DÀNH CHO ADMIN
app.get('/api/admin/sales-orders', verifyAdmin, (req, res) => {
    const sql = `
        SELECT o.*, u.username as buyer_username, u.email as buyer_email, u.phone as buyer_phone
        FROM orders o 
        LEFT JOIN users u ON o.user_id = u.id 
        ORDER BY o.id DESC LIMIT 300
    `;
    db.all(sql, [], (err, orders) => {
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
                accounts: accMap[o.id] || []
            })));
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

// LẤY DANH SÁCH KHO TÀI KHOẢN (PHÂN LOẠI CHƯA BÁN / ĐÃ BÁN + THỜI GIAN BÁN)
app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const { productId, variantId, status, search } = req.query;
    let sql = `
        SELECT i.*, p.name as product_name, u.username as buyer_name, u.email as buyer_email, o.order_code
        FROM inventory i 
        LEFT JOIN products p ON i.product_id = p.id 
        LEFT JOIN users u ON i.buyer_id = u.id 
        LEFT JOIN orders o ON i.order_id = o.id
        WHERE 1=1
    `;
    const params = [];
    if (productId) { sql += ` AND i.product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND i.variant_id = ?`; params.push(variantId); }
    if (status === 'unsold') { sql += ` AND i.is_sold = 0`; }
    else if (status === 'sold') { sql += ` AND i.is_sold = 1`; }
    if (search && search.trim()) {
        sql += ` AND (i.account_data LIKE ? OR o.order_code LIKE ? OR u.username LIKE ?)`;
        const s = `%${search.trim()}%`;
        params.push(s, s, s);
    }
    sql += ` ORDER BY i.is_sold ASC, i.id DESC LIMIT 600`;
    
    db.all(sql, params, (err, rows) => {
        db.get(`SELECT 
                    COUNT(*) as total, 
                    SUM(CASE WHEN is_sold = 0 THEN 1 ELSE 0 END) as unsold,
                    SUM(CASE WHEN is_sold = 1 THEN 1 ELSE 0 END) as sold 
                FROM inventory ${productId ? 'WHERE product_id = ' + parseInt(productId) : ''}`, [], (cErr, counts) => {
            res.json({
                items: rows || [],
                counts: {
                    total: counts ? counts.total : 0,
                    unsold: counts ? counts.unsold : 0,
                    sold: counts ? counts.sold : 0
                }
            });
        });
    });
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
    const { productId, status } = req.query;
    let sql = `SELECT account_data FROM inventory WHERE 1=1`;
    const params = [];
    if (status === 'sold') sql += ` AND is_sold = 1`;
    else if (status === 'all') {}
    else sql += ` AND is_sold = 0`;
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
