const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ================= CẤU HÌNH KẾT NỐI TURSO CLOUD DATABASE (LƯU TRỮ VĨNH VIỄN) =================
// 1. URL database trên Turso Cloud của bạn (khởi tạo theo tài khoản phamminhsy - shop-ai-db):
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'libsql://shop-ai-db-phamminhsy.turso.io';

// 2. Auth Token lấy từ Turso Cloud (Bấm 3 chấm [⋮] cạnh shop-ai-db -> Create Token -> Copy):
// Bạn có thể cài đặt biến môi trường TURSO_AUTH_TOKEN trên Render hoặc điền trực tiếp vào chuỗi bên dưới:
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

// Bộ chuyển đổi LibSQL (Turso) sang chuẩn API sqlite3 để tương thích 100% với hệ thống
function createLibsqlDbAdapter(client) {
    function normalizeArgs(params, cb) {
        let actualParams = [];
        let actualCb = null;
        if (typeof params === 'function') {
            actualCb = params;
        } else if (Array.isArray(params)) {
            actualParams = params;
            actualCb = cb;
        } else if (params !== undefined && params !== null) {
            actualParams = [params];
            actualCb = cb;
        } else {
            actualCb = cb;
        }
        return { actualParams, actualCb };
    }

    return {
        serialize(fn) { if (typeof fn === 'function') fn(); },
        run(sql, params, cb) {
            const { actualParams, actualCb } = normalizeArgs(params, cb);
            client.execute({ sql, args: actualParams }).then(res => {
                const lastID = res.lastInsertRowid !== null && res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : 0;
                const changes = res.rowsAffected !== null && res.rowsAffected !== undefined ? Number(res.rowsAffected) : 0;
                if (actualCb) actualCb.call({ lastID, changes }, null);
            }).catch(err => {
                if (actualCb) actualCb.call({ lastID: 0, changes: 0 }, err);
            });
        },
        get(sql, params, cb) {
            const { actualParams, actualCb } = normalizeArgs(params, cb);
            client.execute({ sql, args: actualParams }).then(res => {
                const row = res.rows && res.rows.length ? res.rows[0] : undefined;
                if (actualCb) actualCb(null, row);
            }).catch(err => {
                if (actualCb) actualCb(err, undefined);
            });
        },
        all(sql, params, cb) {
            const { actualParams, actualCb } = normalizeArgs(params, cb);
            client.execute({ sql, args: actualParams }).then(res => {
                const rows = res.rows ? Array.from(res.rows) : [];
                if (actualCb) actualCb(null, rows);
            }).catch(err => {
                if (actualCb) actualCb(err, []);
            });
        },
        prepare(sql) {
            const queue = [];
            return {
                run(...args) {
                    let cb = null;
                    let p = args;
                    if (args.length && typeof args[args.length - 1] === 'function') {
                        cb = args.pop();
                        p = args;
                    }
                    if (p.length === 1 && Array.isArray(p[0])) p = p[0];
                    queue.push({ sql, args: p, cb });
                },
                finalize(cb) {
                    (async () => {
                        for (const item of queue) {
                            try {
                                const res = await client.execute({ sql: item.sql, args: item.args });
                                if (item.cb) item.cb.call({ lastID: Number(res.lastInsertRowid || 0), changes: Number(res.rowsAffected || 0) }, null);
                            } catch (e) {
                                if (item.cb) item.cb.call({ lastID: 0, changes: 0 }, e);
                            }
                        }
                        if (cb) cb(null);
                    })();
                }
            };
        }
    };
}

let db = null;
let isUsingTurso = false;

// 1. Thử kết nối Turso Cloud nếu có Auth Token
if (TURSO_AUTH_TOKEN && TURSO_DATABASE_URL) {
    try {
        let libsql = null;
        try { libsql = require('@libsql/client'); } catch (e) {}

        if (libsql && libsql.createClient) {
            const client = libsql.createClient({
                url: TURSO_DATABASE_URL,
                authToken: TURSO_AUTH_TOKEN
            });
            db = createLibsqlDbAdapter(client);
            isUsingTurso = true;
            console.log(`>>> [TURSO CLOUD] ĐÃ KẾT NỐI CSDL TURSO THÀNH CÔNG: ${TURSO_DATABASE_URL} <<<`);
            console.log(`>>> [TURSO CLOUD] MỌI DỮ LIỆU ĐƯỢC LƯU VĨNH VIỄN, KHÔNG BỊ MẤT KHI SỬA CODE GITHUB! <<<`);
        }
    } catch (tursoErr) {
        console.error('>>> [TURSO ERROR] Lỗi kết nối Turso:', tursoErr.message);
    }
}

// 2. Fallback sang SQLite3 nội bộ nếu chưa điền Auth Token hoặc chạy offline
if (!db) {
    const sqlite3 = require('sqlite3').verbose();
    const localDbPath = path.join(__dirname, 'database.sqlite');
    db = new sqlite3.Database(localDbPath);
    console.log(`>>> [DATABASE NỘI BỘ] Đang sử dụng SQLite local: ${localDbPath} <<<`);
    if (!TURSO_AUTH_TOKEN) {
        console.log(`>>> [LƯU Ý QUAN TRỌNG] Bạn chưa điền TURSO_AUTH_TOKEN! Khi Render build lại từ GitHub, dữ liệu local sẽ bị reset.`);
        console.log(`>>> Hãy thêm biến môi trường TURSO_AUTH_TOKEN trên Render để kích hoạt Turso Cloud vĩnh viễn! <<<`);
    }
}
const DEFAULT_IMG = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';
const DEFAULT_GUIDE = `1. Đăng nhập: Mở trang web chính thức của dịch vụ, nhập chính xác Email và Mật khẩu được giao.
2. Lưu ý tài khoản: Vui lòng đổi mật khẩu và liên kết thông tin cá nhân ngay nếu là tài khoản cấp riêng.
3. Tài khoản Cookie: Nếu định dạng dạng Cookie (json/string), dùng tiện ích Cookie Editor hoặc J2Team Cookies trên Chrome để Import rồi F5 tải lại trang.
4. Hỗ trợ bảo hành: Liên hệ trực tiếp Zalo hỗ trợ của shop kèm mã đơn hàng nếu tài khoản phát sinh lỗi trong thời gian bảo hành của sản phẩm.`;

const DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000; // Đúng 10 phút (600.000ms)

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

    // 3. Sản phẩm (Có cột warranty riêng cho từng sản phẩm để Admin tùy chỉnh)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, old_price INTEGER DEFAULT 0,
        image TEXT, warranty TEXT DEFAULT 'Bảo hành 12h', description TEXT, guide TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE products ADD COLUMN guide TEXT`, () => {});
    db.run(`ALTER TABLE products ADD COLUMN warranty TEXT DEFAULT 'Bảo hành 12h'`, () => {});

    // 4. Tùy chọn sản phẩm động
    db.run(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, name TEXT, price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);

    // 5. Đơn hàng (Gộp toàn bộ acc trong 1 lần mua)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, user_id INTEGER,
        product_id INTEGER, variant_id INTEGER, product_name TEXT, variant_name TEXT,
        warranty TEXT, quantity INTEGER DEFAULT 1, total_price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE orders ADD COLUMN warranty TEXT`, () => {});

    // 6. Kho hàng (Có batch_code, batch_time, created_at để phân tách rõ từng lần nạp: ngày, giờ, phút)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, variant_id INTEGER,
        variant_name TEXT, account_data TEXT, is_sold INTEGER DEFAULT 0,
        order_id INTEGER, buyer_id INTEGER, sold_at DATETIME,
        batch_code TEXT, batch_time TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE inventory ADD COLUMN order_id INTEGER`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN buyer_id INTEGER`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN sold_at DATETIME`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN batch_code TEXT`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN batch_time TEXT`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});

    // Quản lý lần nạp kho (Batch)
    db.run(`CREATE TABLE IF NOT EXISTS stock_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_code TEXT UNIQUE,
        batch_time TEXT,
        product_id INTEGER,
        variant_id INTEGER,
        variant_name TEXT,
        account_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Gán mã đợt ban đầu cho các acc cũ chưa có đợt
    db.run(`UPDATE inventory SET batch_code = 'DOT-BAN-DAU', batch_time = 'Ban đầu' WHERE batch_code IS NULL OR batch_code = ''`, () => {});

    // 7. Giao dịch nạp tiền (Có expires_at để tự động hủy và xóa mã nạp sau 10 phút)
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'deposit',
        amount INTEGER, info TEXT, status TEXT DEFAULT 'pending',
        expires_at INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE transactions ADD COLUMN expires_at INTEGER`, () => {});

    // Tự động bảo vệ và chữa lành kho inventory
    db.run(`UPDATE inventory SET variant_id = (SELECT id FROM product_variants pv WHERE pv.product_id = inventory.product_id ORDER BY pv.id ASC LIMIT 1) 
            WHERE product_id IN (SELECT id FROM products) 
            AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants))`, () => {});

    // Tài khoản Admin mặc định: admin / 123456
    db.run(`INSERT OR IGNORE INTO users (username, email, phone, password, balance, role) VALUES ('admin', 'admin@jerryshop.vn', '0982900374', '123456', 500000, 'admin')`);

    // Cài đặt shop mặc định (Đã bỏ toàn bộ mã giảm giá và bảo hành chung trên giao diện)
    const defaultSettings = [
        ['site_name', 'JERRY <span class="text-yellow-300">SHOP</span>'],
        ['site_slogan', 'Tài Khoản AI Giá Siêu Rẻ'],
        ['site_logo', ''],
        ['site_domain', ''],
        ['site_hotline', '0982.900.374'],
        ['site_zalo', '0982900374'],
        ['site_notice', 'Jerry Shop - Hệ thống giao tài khoản AI tự động 24/7 nhanh chóng, uy tín'],
        ['site_banner_title', 'Bấm trực tiếp vào sản phẩm để chọn gói và số lượng mua!'],
        ['site_banner_desc', 'Hệ thống phân phối tài khoản cấp sẵn dùng riêng, tự động bàn giao ngay sau 3 giây thanh toán.'],
        ['bank_id', 'MB'],
        ['bank_name', 'MB BANK (Quân Đội)'],
        ['bank_account', '5428102008'],
        ['bank_owner', 'JERRY SHOP'],
        ['min_deposit', '20000'],
        ['maintenance_mode', '0'],
        ['maintenance_message', 'Hệ thống đang tạm bảo trì để nâng cấp và cập nhật dữ liệu. Quý khách vui lòng quay lại sau ít phút!']
    ];
    const sStmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    defaultSettings.forEach(s => sStmt.run(s[0], s[1]));
    sStmt.finalize();

    // Làm sạch thông báo cũ nếu còn dính chữ mã giảm giá hoặc bảo hành chung
    db.run(`UPDATE settings SET value = 'Jerry Shop - Hệ thống giao tài khoản AI tự động 24/7 nhanh chóng, uy tín' WHERE key = 'site_notice' AND value LIKE '%Bảo hành%'`);
    db.run(`UPDATE settings SET value = 'Hệ thống phân phối tài khoản cấp sẵn dùng riêng, tự động bàn giao ngay sau 3 giây thanh toán.' WHERE key = 'site_banner_desc' AND (value LIKE '%JERRY10%' OR value LIKE '%Bảo hành%')`);

    // Sản phẩm mẫu
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            db.run(`INSERT INTO products (id, name, old_price, image, warranty, description, guide) VALUES (1, 'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng', 350000, ?, 'Bảo hành 12h 1 đổi 1', ?, ?)`,
                [DEFAULT_IMG, '• Tài khoản Muse AI 1 tỷ token dùng riêng tốc độ cao.\n• Tự động giao acc ngay sau thanh toán.', DEFAULT_GUIDE],
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

// ================= TỰ ĐỘNG HỦY & XÓA MÃ NẠP TIỀN QUÁ 10 PHÚT =================
// Khi quá 10 phút mà khách không nạp, hệ thống xóa luôn giao dịch chờ đó để:
// 1. Không còn nằm ở trạng thái chờ ("⏳ Chờ") mãi mãi.
// 2. Không ghi nhận mã nạp cũ đó nữa nếu chuyển khoản muộn sau 10 phút.
function cleanupExpiredDeposits(callback) {
    const now = Date.now();
    const sql = `
        DELETE FROM transactions 
        WHERE status = 'pending' 
        AND (
            (expires_at IS NOT NULL AND expires_at <= ?) 
            OR (expires_at IS NULL AND datetime(created_at, '+10 minutes') <= datetime('now'))
        )
    `;
    db.run(sql, [now], function(err) {
        if (typeof callback === 'function') callback(err, this ? this.changes : 0);
    });
}

// Quét tự động mỗi 10 giây
setInterval(() => {
    cleanupExpiredDeposits();
}, 10000);

// ================= HEALTHCHECK & KEEP-ALIVE CHỐNG NGỦ ĐÔNG RENDER =================
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
});

setInterval(() => {
    db.get(`SELECT value FROM settings WHERE key = 'site_domain'`, (err, row) => {
        const targetUrl = (row && row.value && row.value.trim()) ? row.value.trim() : (process.env.RENDER_EXTERNAL_URL || '');
        if (!targetUrl || !targetUrl.startsWith('http')) return;
        const pingUrl = targetUrl.replace(/\/+$/, '') + '/api/ping';
        const client = pingUrl.startsWith('https') ? https : http;
        client.get(pingUrl, (res) => { res.resume(); }).on('error', () => {});
    });
}, 8 * 60 * 1000); // Tự động giữ ấm server mỗi 8 phút

function verifyAdmin(req, res, next) {
    const adminId = req.headers['x-admin-id'] || req.body.adminId;
    if (!adminId) return res.status(403).json({ error: 'Không có quyền truy cập!' });
    db.get(`SELECT role FROM users WHERE id = ?`, [adminId], (err, u) => {
        if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Chỉ Quản trị viên mới được thao tác!' });
        next();
    });
}

// CÀI ĐẶT HỆ THỐNG & TÊN MIỀN
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
        stmt.finalize(() => res.json({ message: 'Đã lưu cài đặt hệ thống thành công!' }));
    });
});

app.post('/api/admin/maintenance', verifyAdmin, (req, res) => {
    const { enabled, message } = req.body;
    const modeVal = enabled ? '1' : '0';
    db.serialize(() => {
        db.run(`INSERT INTO settings (key, value) VALUES ('maintenance_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [modeVal]);
        if (message !== undefined) {
            db.run(`INSERT INTO settings (key, value) VALUES ('maintenance_message', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(message)]);
        }
        res.json({
            success: true,
            maintenance_mode: modeVal,
            message: enabled ? 'Đã BẬT chế độ bảo trì web (Chỉ Admin mới truy cập được)!' : 'Đã TẮT chế độ bảo trì, trang web hoạt động bình thường!'
        });
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
                res.json({ id: this.lastID, username: u, email: em, phone: ph, balance: 0, role: 'user', created_at: new Date().toISOString() });
            }
        );
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu!' });
    const u = username.trim().toLowerCase();
    db.get(`SELECT id, username, email, phone, balance, role, created_at FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND password = ?`, [u, u, password], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Sai tên đăng nhập/email hoặc mật khẩu!' });
        res.json(row);
    });
});

app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT id, username, email, phone, balance, role, created_at FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Không tìm thấy người dùng!' });
        res.json(row);
    });
});

// ================= LIVE ORDER TICKER (CHỈ HIỆN SẢN PHẨM THẬT CỦA SHOP) =================
app.get('/api/live-activities', (req, res) => {
    db.all(`SELECT id, name FROM products`, [], (pErr, prods) => {
        const realProdNames = (prods && prods.length) 
            ? prods.map(p => p.name) 
            : ['Tài khoản Muse AI có sẵn 1 tỷ token'];

        const sql = `
            SELECT o.id, o.order_code, o.product_name, o.variant_name, o.quantity, o.created_at, u.username
            FROM orders o 
            LEFT JOIN users u ON o.user_id = u.id 
            ORDER BY o.id DESC LIMIT 15
        `;
        db.all(sql, [], (err, rows) => {
            const sampleUsers = ['huy***26', 'linh***99', 'thanh***88', 'minh***04', 'tuan***72', 'duc***15', 'hoang***93', 'anh***68', 'phuong***32'];
            const sampleTimes = ['2 phút trước', '5 phút trước', '9 phút trước', '14 phút trước', '21 phút trước', '30 phút trước'];

            if (!rows || !rows.length) {
                const generated = sampleUsers.slice(0, 5).map((u, i) => ({
                    id: i + 1,
                    masked_user: u,
                    product_name: realProdNames[i % realProdNames.length],
                    quantity: 1,
                    time_ago: sampleTimes[i % sampleTimes.length]
                }));
                return res.json(generated);
            }

            res.json(rows.map((r, i) => {
                const u = r.username || 'Khách';
                const masked = u.length > 3 ? u.substring(0, 2) + '***' + u.slice(-2) : u + '***';
                return {
                    id: r.id,
                    order_code: r.order_code,
                    masked_user: masked,
                    product_name: r.product_name || realProdNames[0],
                    variant_name: r.variant_name || '',
                    quantity: r.quantity || 1,
                    time_ago: sampleTimes[i % sampleTimes.length]
                };
            }));
        });
    });
});

// ================= SẢN PHẨM & TÙY CHỌN (CÓ BẢO HÀNH RIÊNG CHO TỪNG SẢN PHẨM) =================
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
                    warranty: (p.warranty !== undefined && p.warranty !== null) ? p.warranty : '',
                    guide: p.guide || DEFAULT_GUIDE,
                    variants: vars,
                    min_price: minPrice,
                    total_stock: Number(p.total_stock || 0)
                };
            }));
        });
    });
});

// ================= MUA HÀNG (ĐÃ BỎ MÃ GIẢM GIÁ, LƯU CHẾ ĐỘ BẢO HÀNH RIÊNG CỦA SẢN PHẨM) =================
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!userId || !productId || !variantId) return res.status(400).json({ error: 'Thiếu thông tin đặt hàng!' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản!' });
        db.get(`SELECT value FROM settings WHERE key = 'maintenance_mode'`, (mErr, mRow) => {
            if (mRow && mRow.value === '1' && user.role !== 'admin') {
                return res.status(503).json({ error: 'Trang web hiện đang tạm bảo trì để nâng cấp. Vui lòng quay lại sau ít phút!' });
            }

        db.get(`SELECT p.name as product_name, p.warranty as product_warranty, p.guide as product_guide, pv.name as variant_name, pv.price 
                FROM product_variants pv 
                JOIN products p ON pv.product_id = p.id 
                WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, itemInfo) => {
            if (!itemInfo) return res.status(404).json({ error: 'Gói sản phẩm không tồn tại!' });

            const totalPrice = Math.max(0, itemInfo.price * qty);
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
                    db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, warranty, quantity, total_price)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [orderCode, userId, productId, variantId, itemInfo.product_name, itemInfo.variant_name, itemInfo.product_warranty || '', qty, totalPrice],
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
                                        productId: productId,
                                        productName: itemInfo.product_name,
                                        warranty: itemInfo.product_warranty || '',
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
});

// ================= ĐỔI BẢO HÀNH 1-CLICK DÀNH CHO ADMIN =================
app.post('/api/admin/warranty/exchange', verifyAdmin, (req, res) => {
    const { orderId, oldAccountId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Thiếu mã đơn hàng!' });

    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng!' });

        db.get(`SELECT id, account_data FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 LIMIT 1`,
            [order.product_id, order.variant_id],
            (iErr, newAcc) => {
                if (!newAcc) return res.status(400).json({ error: 'Kho hiện đã hết tài khoản dự phòng của gói này để đổi!' });

                db.serialize(() => {
                    if (oldAccountId) {
                        db.run(`UPDATE inventory SET is_sold = 2 WHERE id = ?`, [oldAccountId]);
                    }
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
    const sql = `SELECT o.*, COALESCE(NULLIF(o.warranty, ''), p.warranty, '') as product_warranty, p.guide as product_guide 
                 FROM orders o LEFT JOIN products p ON o.product_id = p.id 
                 WHERE o.user_id = ? ORDER BY o.id DESC`;
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
                warranty: o.product_warranty || '',
                guide: o.product_guide || DEFAULT_GUIDE,
                accounts: accMap[o.id] || []
            })));
        });
    });
});

app.get('/api/order-lookup/:code', (req, res) => {
    const code = req.params.code.trim();
    const sql = `SELECT o.*, COALESCE(NULLIF(o.warranty, ''), p.warranty, '') as product_warranty, p.guide as product_guide 
                 FROM orders o LEFT JOIN products p ON o.product_id = p.id 
                 WHERE UPPER(o.order_code) = UPPER(?) LIMIT 1`;
    db.get(sql, [code], (err, o) => {
        if (!o) return res.status(404).json({ error: 'Không tìm thấy đơn hàng với mã này!' });
        db.all(`SELECT account_data FROM inventory WHERE order_id = ? ORDER BY id ASC`, [o.id], (iErr, accRows) => {
            res.json({
                ...o,
                warranty: o.product_warranty || '',
                guide: o.product_guide || DEFAULT_GUIDE,
                accounts: (accRows || []).map(a => a.account_data)
            });
        });
    });
});

// ================= NẠP TIỀN VIETQR (GIỚI HẠN ĐÚNG 10 PHÚT, QUÁ 10 PHÚT HỦY & XÓA LUÔN) =================
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const val = parseInt(amount);
    if (!val || val <= 0) return res.status(400).json({ error: 'Số tiền nạp không hợp lệ!' });

    cleanupExpiredDeposits(() => {
        db.get(`SELECT value FROM settings WHERE key = 'min_deposit'`, (err, row) => {
            const minDep = row ? parseInt(row.value) : 20000;
            if (val < minDep) return res.status(400).json({ error: `Số tiền nạp tối thiểu là ${minDep.toLocaleString()}đ!` });

            // Xóa các mã nạp đang chờ cũ của chính user này để tránh tồn đọng nhiều mã chờ
            db.run(`DELETE FROM transactions WHERE user_id = ? AND status = 'pending'`, [userId], () => {
                const code = 'NAP' + Math.floor(1000 + Math.random() * 9000);
                const expiresAt = Date.now() + DEPOSIT_TIMEOUT_MS;
                db.run(`INSERT INTO transactions (user_id, type, amount, info, status, expires_at) VALUES (?, 'deposit', ?, ?, 'pending', ?)`,
                    [userId, val, code, expiresAt],
                    function(tErr) {
                        res.json({ txId: this.lastID, code, amount: val, expiresAt });
                    }
                );
            });
        });
    });
});

app.get('/api/deposit/check/:txId', (req, res) => {
    cleanupExpiredDeposits(() => {
        db.get(`SELECT * FROM transactions WHERE id = ?`, [req.params.txId], (err, tx) => {
            if (!tx) {
                return res.status(404).json({ status: 'expired', error: 'Mã nạp tiền đã quá hạn 10 phút hoặc đã bị hủy bỏ!' });
            }
            if (tx.status === 'pending' && tx.expires_at && tx.expires_at <= Date.now()) {
                db.run(`DELETE FROM transactions WHERE id = ?`, [tx.id], () => {
                    res.status(404).json({ status: 'expired', error: 'Mã nạp tiền đã quá 10 phút và đã bị hủy!' });
                });
                return;
            }
            res.json(tx);
        });
    });
});

// Hủy và xóa ngay mã nạp khi hết 10 phút hoặc khi người dùng bấm hủy
app.post('/api/deposit/cancel', (req, res) => {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: 'Thiếu mã giao dịch!' });
    db.run(`DELETE FROM transactions WHERE id = ? AND status = 'pending'`, [txId], function(err) {
        res.json({ success: true, message: 'Đã hủy và xóa mã nạp tiền này!' });
    });
});

app.post('/api/deposit/notify-paid', (req, res) => {
    const { txId } = req.body;
    cleanupExpiredDeposits(() => {
        db.get(`SELECT * FROM transactions WHERE id = ?`, [txId], (err, tx) => {
            if (!tx) return res.status(404).json({ error: 'Mã nạp này đã hết hạn 10 phút và không còn được ghi nhận!' });
            res.json({ message: 'Đã gửi thông báo xác nhận chuyển khoản tới hệ thống! Vui lòng hoàn tất trong thời hạn 10 phút.' });
        });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    cleanupExpiredDeposits(() => {
        db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [req.params.userId], (err, rows) => res.json(rows || []));
    });
});

// ================= ADMIN APIS =================

// KIỂM TRA TRẠNG THÁI KẾT NỐI TURSO CLOUD DATABASE
app.get('/api/admin/db-status', verifyAdmin, (req, res) => {
    res.json({
        isUsingTurso,
        databaseUrl: isUsingTurso ? TURSO_DATABASE_URL : 'Local database.sqlite (Cần gắn TURSO_AUTH_TOKEN để lưu vĩnh viễn)',
        hasToken: Boolean(TURSO_AUTH_TOKEN)
    });
});

app.get('/api/admin/stats', verifyAdmin, (req, res) => {
    cleanupExpiredDeposits(() => {
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

                            // TÁCH RIÊNG SỐ ACC ĐÃ BÁN THEO TỪNG SẢN PHẨM & TỪNG GÓI TÙY CHỌN (GÓI 1 TỶ, GÓI 31 TỶ...)
                            const breakdownSql = `
                                SELECT 
                                    p.id as product_id, p.name as product_name, p.image as product_image,
                                    pv.id as variant_id, pv.name as variant_name, pv.price as variant_price,
                                    COUNT(CASE WHEN i.is_sold = 1 THEN 1 END) as sold_count,
                                    COUNT(CASE WHEN i.is_sold = 0 THEN 1 END) as stock_count,
                                    COUNT(i.id) as total_count,
                                    COALESCE(SUM(CASE WHEN i.is_sold = 1 THEN pv.price ELSE 0 END), 0) as sold_revenue
                                FROM products p
                                JOIN product_variants pv ON pv.product_id = p.id
                                LEFT JOIN inventory i ON i.product_id = p.id AND i.variant_id = pv.id
                                GROUP BY p.id, pv.id
                                ORDER BY p.id ASC, pv.id ASC
                            `;
                            db.all(breakdownSql, [], (e6, bRows) => {
                                s.soldBreakdown = bRows || [];
                                res.json(s);
                            });
                        });
                    });
                });
            });
        });
    });
});

// QUẢN LÝ DÒNG TIỀN (CASH FLOW)
app.get('/api/admin/cashflow', verifyAdmin, (req, res) => {
    cleanupExpiredDeposits(() => {
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
});

// LỊCH SỬ BÁN HÀNG DÀNH CHO ADMIN
app.get('/api/admin/sales-orders', verifyAdmin, (req, res) => {
    const { productId, variantId } = req.query;
    let sql = `
        SELECT o.*, COALESCE(NULLIF(o.warranty, ''), p.warranty, '') as product_warranty,
               u.username as buyer_username, u.email as buyer_email, u.phone as buyer_phone
        FROM orders o 
        LEFT JOIN products p ON o.product_id = p.id
        LEFT JOIN users u ON o.user_id = u.id 
        WHERE 1=1
    `;
    const params = [];
    if (productId) { sql += ` AND o.product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND o.variant_id = ?`; params.push(variantId); }
    sql += ` ORDER BY o.id DESC LIMIT 300`;
    db.all(sql, params, (err, orders) => {
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
                warranty: o.product_warranty || '',
                accounts: accMap[o.id] || []
            })));
        });
    });
});

app.post('/api/admin/products', verifyAdmin, (req, res) => {
    const { name, old_price, image, warranty, description, guide, variants } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Phải có ít nhất 1 tùy chọn và giá bán!' });

    db.run(`INSERT INTO products (name, old_price, image, warranty, description, guide) VALUES (?, ?, ?, ?, ?, ?)`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, (warranty || '').trim(), description || '', guide || DEFAULT_GUIDE],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi khi lưu sản phẩm!' });
            const pid = this.lastID;
            const stmt = db.prepare(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`);
            varList.forEach(v => stmt.run(pid, v.name.trim(), parseInt(v.price) || 0));
            stmt.finalize(() => res.json({ message: 'Đã thêm sản phẩm thành công!', id: pid }));
        }
    );
});

// SỬA SẢN PHẨM: BẢO TOÀN VARIANT ID, CẬP NHẬT CHẾ ĐỘ BẢO HÀNH RIÊNG & BẢO TOÀN KHO INVENTORY
app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, old_price, image, warranty, description, guide, variants } = req.body;
    const pid = req.params.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên không được để trống!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Sản phẩm phải có ít nhất 1 tùy chọn giá!' });

    db.run(`UPDATE products SET name = ?, old_price = ?, image = ?, warranty = ?, description = ?, guide = ? WHERE id = ?`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, (warranty || '').trim(), description || '', guide || DEFAULT_GUIDE, pid],
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
                                    () => res.json({ message: 'Đã lưu thay đổi sản phẩm & chế độ bảo hành thành công!' })
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

// NẠP KHO CHỐNG TRÙNG ACC & TÁCH RIÊNG THEO LẦN NẠP (MẤY GIỜ, MẤY PHÚT, NGÀY NẠP)
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variantId, accountsText } = req.body;
    if (!productId || !variantId || !accountsText || !accountsText.trim()) {
        return res.status(400).json({ error: 'Vui lòng chọn sản phẩm, tùy chọn gói và dán danh sách tài khoản!' });
    }

    db.get(`SELECT pv.*, p.name as product_name FROM product_variants pv JOIN products p ON pv.product_id = p.id WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, variant) => {
        if (!variant) return res.status(400).json({ error: 'Tùy chọn gói sản phẩm không tồn tại!' });

        const rawLines = accountsText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) return res.status(400).json({ error: 'Danh sách tài khoản dán vào trống!' });

        // 1. Lọc trùng nội bộ trong danh sách vừa dán vào
        const uniqueSet = new Set();
        const uniqueLines = [];
        rawLines.forEach(l => {
            if (!uniqueSet.has(l)) {
                uniqueSet.add(l);
                uniqueLines.push(l);
            }
        });

        // 2. Lọc trùng với database: Kiểm tra tất cả tài khoản đã tồn tại trong gói tùy chọn này của sản phẩm (kể cả chưa bán lẫn đã bán)
        db.all(`SELECT account_data FROM inventory WHERE product_id = ? AND variant_id = ?`, [productId, variantId], (dbErr, existingItems) => {
            const dbSet = new Set((existingItems || []).map(i => (i.account_data || '').trim()));
            const toInsert = uniqueLines.filter(l => !dbSet.has(l));

            if (!toInsert.length) {
                return res.status(400).json({
                    error: `Tất cả ${rawLines.length} tài khoản vừa nhập đều ĐÃ TỒN TẠI trong gói [${variant.name}] hoặc bị trùng lặp! Không có tài khoản mới nào được thêm.`
                });
            }

            // Tạo thông tin LẦN NẠP chuẩn xác: mấy giờ, mấy phút, ngày nạp
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} - ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
            const dateCode = `${pad(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const batchCode = `DOT-${dateCode}-${Math.floor(100 + Math.random() * 900)}`;

            db.serialize(() => {
                db.run(`INSERT OR IGNORE INTO stock_batches (batch_code, batch_time, product_id, variant_id, variant_name, account_count) VALUES (?, ?, ?, ?, ?, ?)`,
                    [batchCode, timeStr, productId, variantId, variant.name, toInsert.length]);

                const stmt = db.prepare(`INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold, batch_code, batch_time, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`);
                toInsert.forEach(acc => stmt.run(productId, variantId, variant.name, acc, batchCode, timeStr));
                stmt.finalize(() => {
                    const totalDup = rawLines.length - toInsert.length;
                    res.json({
                        success: true,
                        message: `Đã nạp thành công ${toInsert.length} tài khoản mới vào Lần nạp [${timeStr}]! (Đã tự động loại bỏ ${totalDup} tài khoản bị trùng lặp).`,
                        batchCode,
                        batchTime: timeStr,
                        addedCount: toInsert.length,
                        duplicateCount: totalDup
                    });
                });
            });
        });
    });
});

// LẤY DANH SÁCH KHO TÀI KHOẢN (CÓ THÔNG TIN PHÂN THEO SẢN PHẨM, GÓI VÀ LẦN NẠP)
app.get('/api/admin/inventory', verifyAdmin, (req, res) => {
    const { productId, variantId, batchCode, status, search } = req.query;
    let sql = `
        SELECT i.*, p.name as product_name, p.image as product_image,
               u.username as buyer_name, u.email as buyer_email, o.order_code
        FROM inventory i 
        LEFT JOIN products p ON i.product_id = p.id 
        LEFT JOIN users u ON i.buyer_id = u.id 
        LEFT JOIN orders o ON i.order_id = o.id
        WHERE 1=1
    `;
    const params = [];
    if (productId) { sql += ` AND i.product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND i.variant_id = ?`; params.push(variantId); }
    if (batchCode) { sql += ` AND i.batch_code = ?`; params.push(batchCode); }
    if (status === 'unsold') { sql += ` AND i.is_sold = 0`; }
    else if (status === 'sold') { sql += ` AND i.is_sold = 1`; }
    if (search && search.trim()) {
        sql += ` AND (i.account_data LIKE ? OR o.order_code LIKE ? OR u.username LIKE ? OR i.batch_code LIKE ? OR i.batch_time LIKE ?)`;
        const s = `%${search.trim()}%`;
        params.push(s, s, s, s, s);
    }
    sql += ` ORDER BY i.id DESC LIMIT 1500`;
    
    db.all(sql, params, (err, rows) => {
        let countSql = `SELECT 
                    COUNT(*) as total, 
                    SUM(CASE WHEN is_sold = 0 THEN 1 ELSE 0 END) as unsold,
                    SUM(CASE WHEN is_sold = 1 THEN 1 ELSE 0 END) as sold 
                FROM inventory WHERE 1=1`;
        const countParams = [];
        if (productId) { countSql += ` AND product_id = ?`; countParams.push(parseInt(productId)); }
        if (variantId) { countSql += ` AND variant_id = ?`; countParams.push(parseInt(variantId)); }

        db.get(countSql, countParams, (cErr, counts) => {
            res.json({
                items: rows || [],
                counts: {
                    total: counts ? (counts.total || 0) : 0,
                    unsold: counts ? (counts.unsold || 0) : 0,
                    sold: counts ? (counts.sold || 0) : 0
                }
            });
        });
    });
});

// XÓA MỘT LẦN NẠP KHO (BATCH)
app.delete('/api/admin/inventory/batch/:batchCode', verifyAdmin, (req, res) => {
    const { batchCode } = req.params;
    if (!batchCode) return res.status(400).json({ error: 'Thiếu mã lần nạp!' });
    db.serialize(() => {
        // Chỉ xóa tài khoản chưa bán trong lần nạp này để bảo toàn lịch sử đơn hàng
        db.run(`DELETE FROM inventory WHERE batch_code = ? AND is_sold = 0`, [batchCode], function(err) {
            const deletedCount = this.changes || 0;
            db.get(`SELECT COUNT(*) as remaining FROM inventory WHERE batch_code = ?`, [batchCode], (err2, row) => {
                const remaining = row ? row.remaining : 0;
                if (remaining === 0) {
                    db.run(`DELETE FROM stock_batches WHERE batch_code = ?`, [batchCode], () => {});
                }
                res.json({
                    success: true,
                    message: `Đã xóa ${deletedCount} tài khoản chưa bán trong lần nạp [${batchCode}]!${remaining > 0 ? ` (Giữ lại ${remaining} tài khoản đã bán để bảo vệ đơn hàng của khách).` : ''}`
                });
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
    const { productId, variantId, batchCode, status } = req.query;
    let sql = `SELECT account_data FROM inventory WHERE 1=1`;
    const params = [];
    if (status === 'sold') sql += ` AND is_sold = 1`;
    else if (status === 'all') {}
    else sql += ` AND is_sold = 0`;
    if (productId) { sql += ` AND product_id = ?`; params.push(productId); }
    if (variantId) { sql += ` AND variant_id = ?`; params.push(variantId); }
    if (batchCode) { sql += ` AND batch_code = ?`; params.push(batchCode); }
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

// QUẢN LÝ KHÁCH HÀNG: TÌM KIẾM ĐA NĂNG & ĐỔI MẬT KHẨU CHO KHÁCH
app.get('/api/admin/users', verifyAdmin, (req, res) => {
    const search = (req.query.search || '').trim();
    let sql = `SELECT id, username, email, phone, password, balance, role, created_at, (SELECT COUNT(*) FROM orders WHERE user_id = users.id) as orders_count FROM users WHERE 1=1`;
    const params = [];
    if (search) {
        sql += ` AND (username LIKE ? OR email LIKE ? OR phone LIKE ? OR CAST(id AS TEXT) LIKE ?)`;
        const s = `%${search}%`;
        params.push(s, s, s, s);
    }
    sql += ` ORDER BY id DESC`;
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/balance', verifyAdmin, (req, res) => {
    const { userId, amount } = req.body;
    const val = parseInt(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Số tiền không hợp lệ!' });
    db.run(`UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?`, [val, userId], () => res.json({ message: 'Đã cập nhật số dư thành viên!' }));
});

app.post('/api/admin/users/password', verifyAdmin, (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || String(newPassword).trim().length < 4) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 4 ký tự!' });
    }
    const cleanPass = String(newPassword).trim();
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [cleanPass, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Lỗi khi cập nhật mật khẩu!' });
        res.json({ message: 'Đã đổi mật khẩu mới cho khách hàng thành công!' });
    });
});

app.get('/api/admin/transactions', verifyAdmin, (req, res) => {
    cleanupExpiredDeposits(() => {
        db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC`, [], (err, rows) => res.json(rows || []));
    });
});

app.post('/api/admin/approve-tx', verifyAdmin, (req, res) => {
    const { txId, action } = req.body;
    cleanupExpiredDeposits(() => {
        db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'pending'`, [txId], (err, tx) => {
            if (!tx) return res.status(400).json({ error: 'Giao dịch đã quá hạn 10 phút, không tồn tại hoặc đã xử lý!' });
            if (action === 'cancel') {
                // Xóa luôn đơn nạp bị hủy để không còn tồn đọng
                db.run(`DELETE FROM transactions WHERE id = ?`, [txId], () => res.json({ message: 'Đã hủy và xóa đơn nạp tiền!' }));
            } else {
                db.serialize(() => {
                    db.run(`UPDATE transactions SET status = 'completed' WHERE id = ?`, [txId]);
                    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [tx.amount, tx.user_id]);
                    res.json({ message: 'Đã duyệt nạp và cộng tiền cho khách!' });
                });
            }
        });
    });
});

// ================= WEBHOOK TỰ ĐỘNG NẠP TIỀN (CHỈ GHI NHẬN MÃ CÒN HẠN TRONG 10 PHÚT) =================
function processIncomingBankTransfer(contentOrDescription, amount, res) {
    if (!contentOrDescription) return res.status(400).json({ error: 'Không tìm thấy nội dung chuyển khoản!' });
    const text = String(contentOrDescription);
    const amt = parseInt(amount) || 0;

    const match = text.match(/NAP\d+/i);
    const code = match ? match[0].toUpperCase() : null;

    if (!code) {
        console.log(`[WEBHOOK] Không tìm thấy mã NAP trong nội dung: "${text}"`);
        return res.json({ success: false, message: 'Nội dung không chứa mã NAP hợp lệ' });
    }

    // Dọn dẹp toàn bộ các mã nạp đã quá hạn 10 phút trước khi kiểm tra
    cleanupExpiredDeposits(() => {
        db.get(`SELECT * FROM transactions WHERE UPPER(info) = ? AND status = 'pending'`, [code], (err, tx) => {
            if (!tx || (tx.expires_at && tx.expires_at <= Date.now())) {
                if (tx) db.run(`DELETE FROM transactions WHERE id = ?`, [tx.id]);
                console.log(`[WEBHOOK TỪ CHỐI] Mã ${code} không tồn tại hoặc đã quá hạn 10 phút!`);
                return res.json({ success: false, message: `Mã ${code} đã quá hạn 10 phút hoặc không tồn tại, hệ thống không ghi nhận!` });
            }

            const actualAmount = amt > 0 ? amt : tx.amount;
            db.serialize(() => {
                db.run(`UPDATE transactions SET status = 'completed', amount = ? WHERE id = ?`, [actualAmount, tx.id]);
                db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [actualAmount, tx.user_id]);
                console.log(`[WEBHOOK THÀNH CÔNG] Đã tự động cộng ${actualAmount}đ cho User #${tx.user_id} (Mã: ${code})!`);
                res.json({ success: true, message: `Tự động cộng ${actualAmount}đ thành công cho mã ${code}` });
            });
        });
    });
}

// 1. SePay Webhook (sepay.vn - Cổng VietQR tự động)
app.post(['/api/webhook/sepay', '/api/sepay/webhook'], (req, res) => {
    const data = req.body || {};
    const content = data.content || data.description || '';
    const amount = data.transferAmount || data.amount || 0;
    processIncomingBankTransfer(content, amount, res);
});

// 2. Casso Webhook (casso.vn - Kết nối ngân hàng tự động)
app.post('/api/webhook/casso', (req, res) => {
    const data = req.body || {};
    const records = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : [data]);
    if (records.length) {
        const first = records[0];
        processIncomingBankTransfer(first.description || first.content, first.amount, res);
    } else {
        res.json({ success: false, message: 'Dữ liệu casso trống' });
    }
});

// 3. ShopeePay / Web2M / Universal Webhook
app.post(['/api/webhook/shopeepay', '/api/webhook/web2m', '/api/webhook/payment', '/api/webhook'], (req, res) => {
    const data = req.body || {};
    const content = data.comment || data.content || data.description || data.msg || '';
    const amount = data.amount || data.transferAmount || data.money || 0;
    processIncomingBankTransfer(content, amount, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>>> JERRY SHOP ĐANG CHẠY TẠI: http://localhost:${PORT} <<<`));
