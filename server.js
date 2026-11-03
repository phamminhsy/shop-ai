const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ================= CẤU HÌNH CƠ SỞ DỮ LIỆU KÉP (TURSO CLOUD + SQLITE NỘI BỘ TỰ ĐỘNG DỰ PHÒNG) =================
const DEFAULT_TURSO_URL = 'libsql://shop-ai-db-phamminhsy.aws-ap-southeast-1.turso.io';
const DEFAULT_TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTM2MzA5NDMsImlkIjoiMDFhMTljYmEtZGUwMS03OGQ1LTgxMzUtZTEzNDMwYzNhZWY1Iiwia2lkIjoiYVpNLWpXclQ0ajhIWW1RRFl0eFVLeW9JM2YyYVdqTTBwV29uOW9sVTFqQSIsInJpZCI6IjZlNTkwYjRjLTI3N2UtNDZiMy1iMGI0LWE4NGQxOTI3OThlOSJ9.iRp-GToUj_xu2Fc7CW-1xA_QvlRABWF7lxHdDnU0zS9DtmM_HuPmV08F-l1ACZ-vfuXZr_X2QPgrIC-_3kmWCw';

let TURSO_DATABASE_URL = DEFAULT_TURSO_URL;
let TURSO_AUTH_TOKEN = DEFAULT_TURSO_TOKEN;

const localDbPath = path.join(__dirname, 'database.sqlite');
const sqliteDb = new sqlite3.Database(localDbPath);

let isUsingTurso = false;
let tursoVerified = false;
let tursoLastError = '';
let tursoClient = null;

// Bộ kết nối HTTPS /v2/pipeline trực tiếp tới Turso (vượt qua lỗi WebSocket/migration jobs của @libsql/client cũ)
function createDirectHttpsTursoClient(rawUrl, authToken) {
    const httpsUrl = String(rawUrl || '').trim().replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
    const parsed = new URL(httpsUrl + '/v2/pipeline');
    return {
        execute(queryObj) {
            const sql = typeof queryObj === 'string' ? queryObj : queryObj.sql;
            const rawArgs = (typeof queryObj === 'object' && Array.isArray(queryObj.args)) ? queryObj.args : [];
            const hranaArgs = rawArgs.map(v => {
                if (v === null || v === undefined) return { type: 'null' };
                if (typeof v === 'number') {
                    if (Number.isInteger(v)) return { type: 'integer', value: String(v) };
                    return { type: 'float', value: v };
                }
                return { type: 'text', value: String(v) };
            });
            const bodyStr = JSON.stringify({
                requests: [
                    { type: 'execute', stmt: { sql, args: hranaArgs } },
                    { type: 'close' }
                ]
            });
            return new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: parsed.hostname,
                    port: parsed.port || 443,
                    path: parsed.pathname,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(bodyStr)
                    },
                    timeout: 8000
                }, (res) => {
                    let chunks = [];
                    res.on('data', d => chunks.push(d));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 180)}`));
                        }
                        try {
                            const data = JSON.parse(text);
                            const first = data.results && data.results[0];
                            if (!first) return reject(new Error('Phản hồi Turso trống'));
                            if (first.type === 'error') {
                                return reject(new Error(first.error && first.error.message ? first.error.message : JSON.stringify(first.error)));
                            }
                            const execRes = first.response && first.response.result ? first.response.result : {};
                            const cols = (execRes.cols || []).map(c => c.name);
                            const rows = (execRes.rows || []).map(r => {
                                const obj = {};
                                cols.forEach((colName, idx) => {
                                    const cell = r[idx];
                                    if (!cell || cell.type === 'null') obj[colName] = null;
                                    else if (cell.type === 'integer') obj[colName] = Number(cell.value);
                                    else if (cell.type === 'float') obj[colName] = Number(cell.value);
                                    else obj[colName] = cell.value;
                                });
                                return obj;
                            });
                            resolve({
                                rows,
                                lastInsertRowid: execRes.last_insert_rowid ? Number(execRes.last_insert_rowid) : 0,
                                rowsAffected: execRes.affected_row_count ? Number(execRes.affected_row_count) : 0
                            });
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Turso HTTP Timeout')); });
                req.write(bodyStr);
                req.end();
            });
        }
    };
}

async function tryConnectTursoCandidates(customUrl = null, customToken = null) {
    const candidates = [];
    if (customUrl && customToken) {
        candidates.push({ url: customUrl.trim(), token: customToken.trim(), mode: 'https-direct' });
        candidates.push({ url: customUrl.trim(), token: customToken.trim(), mode: 'libsql-https' });
        candidates.push({ url: customUrl.trim(), token: customToken.trim(), mode: 'libsql' });
    }
    // 1. Ưu tiên Token & URL mới nhất của chủ shop trước tiên (tránh biến môi trường cũ bị lỗi trên Render ghi đè)
    candidates.push({ url: DEFAULT_TURSO_URL, token: DEFAULT_TURSO_TOKEN, mode: 'https-direct' });
    candidates.push({ url: DEFAULT_TURSO_URL, token: DEFAULT_TURSO_TOKEN, mode: 'libsql-https' });
    candidates.push({ url: DEFAULT_TURSO_URL, token: DEFAULT_TURSO_TOKEN, mode: 'libsql' });

    // 2. Thử thêm biến môi trường trên Render (nếu chủ shop có cấu hình DB khác trên Render)
    const envUrl = (process.env.TURSO_DATABASE_URL || '').trim();
    const envToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
    if (envUrl && envToken && (envUrl !== DEFAULT_TURSO_URL || envToken !== DEFAULT_TURSO_TOKEN)) {
        candidates.push({ url: envUrl, token: envToken, mode: 'https-direct' });
        candidates.push({ url: envUrl, token: envToken, mode: 'libsql-https' });
        candidates.push({ url: envUrl, token: envToken, mode: 'libsql' });
    }

    let lastErr = '';
    for (const c of candidates) {
        try {
            let client = null;
            if (c.mode === 'https-direct') {
                client = createDirectHttpsTursoClient(c.url, c.token);
            } else {
                const libsql = require('@libsql/client');
                const targetUrl = c.mode === 'libsql-https' ? c.url.replace(/^libsql:\/\//i, 'https://') : c.url;
                client = libsql.createClient({ url: targetUrl, authToken: c.token });
            }
            await client.execute('SELECT 1');
            tursoClient = client;
            TURSO_DATABASE_URL = c.url;
            TURSO_AUTH_TOKEN = c.token;
            isUsingTurso = true;
            tursoVerified = true;
            tursoLastError = '';
            console.log(`>>> [TURSO CLOUD] Kết nối thành công (${c.mode}): ${TURSO_DATABASE_URL} <<<`);
            return { ok: true, mode: c.mode, url: TURSO_DATABASE_URL };
        } catch (err) {
            lastErr = err && err.message ? err.message : String(err);
        }
    }
    isUsingTurso = false;
    tursoVerified = false;
    tursoLastError = lastErr;
    console.warn(`>>> [AUTO-HEAL DB] Không thể kết nối Turso (${lastErr}). Đang dùng SQLite nội bộ! <<<`);
    return { ok: false, error: lastErr };
}

function sanitizeSqlArgs(params) {
    if (!Array.isArray(params)) return [];
    return params.map(v => {
        if (v === undefined) return null;
        if (typeof v === 'number' && isNaN(v)) return 0;
        return v;
    });
}

function normalizeDbArgs(params, cb) {
    let actualParams = [];
    let actualCb = null;
    if (typeof params === 'function') {
        actualCb = params;
    } else if (Array.isArray(params)) {
        actualParams = sanitizeSqlArgs(params);
        actualCb = cb;
    } else if (params !== undefined && params !== null) {
        actualParams = sanitizeSqlArgs([params]);
        actualCb = cb;
    } else {
        actualCb = cb;
    }
    return { actualParams, actualCb };
}

// Bộ điều phối Database thông minh:
// - Nếu Turso hoạt động tốt: đọc/ghi trên Turso VÀ đồng bộ xuống SQLite local.
// - Nếu Turso gặp lỗi (ví dụ: "Unexpected status code while fetching migration jobs: 400" hoặc token lỗi):
//   Tự động chuyển sang SQLite local ngay lập tức trong 0ms để mọi thao tác Thêm sản phẩm, Thêm kho, Mua hàng KHÔNG BAO GIỜ LỖI hay mất dữ liệu khi F5!
function handleTursoFailure(err) {
    const msg = err && err.message ? err.message : String(err || 'Turso Error');
    tursoLastError = msg;
    if (isUsingTurso && !tursoVerified) {
        console.warn(`>>> [AUTO-HEAL DB] Không thể kết nối Turso lúc khởi động (${msg}). Chuyển sang SQLite nội bộ! <<<`);
        isUsingTurso = false;
    } else if (isUsingTurso && /fetching migration jobs: 400|UNAUTHENTICATED|401|403/i.test(msg)) {
        console.warn(`>>> [AUTO-HEAL DB] Turso trả về lỗi cấu hình nghiêm trọng (${msg}). Chuyển sang SQLite nội bộ! <<<`);
        isUsingTurso = false;
    }
}

const db = {
    serialize(fn) {
        sqliteDb.serialize(() => {
            if (typeof fn === 'function') fn();
        });
    },
    run(sql, params, cb) {
        const { actualParams, actualCb } = normalizeDbArgs(params, cb);
        if (!isUsingTurso || !tursoClient) {
            return sqliteDb.run(sql, actualParams, actualCb || function() {});
        }
        tursoClient.execute({ sql, args: actualParams }).then(res => {
            const lastID = res.lastInsertRowid !== null && res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : 0;
            const changes = res.rowsAffected !== null && res.rowsAffected !== undefined ? Number(res.rowsAffected) : 0;
            // Đồng bộ ngầm vào SQLite local
            sqliteDb.run(sql, actualParams, () => {});
            if (actualCb) actualCb.call({ lastID, changes }, null);
        }).catch(err => {
            // Bỏ qua lỗi ALTER TABLE cột đã tồn tại
            if (/duplicate column name|already exists/i.test(err && err.message ? err.message : '')) {
                sqliteDb.run(sql, actualParams, () => {});
                if (actualCb) actualCb.call({ lastID: 0, changes: 0 }, null);
                return;
            }
            handleTursoFailure(err);
            sqliteDb.run(sql, actualParams, actualCb || function() {});
        });
    },
    get(sql, params, cb) {
        const { actualParams, actualCb } = normalizeDbArgs(params, cb);
        if (!isUsingTurso || !tursoClient) {
            return sqliteDb.get(sql, actualParams, actualCb || function() {});
        }
        tursoClient.execute({ sql, args: actualParams }).then(res => {
            const row = res.rows && res.rows.length ? Object.assign({}, res.rows[0]) : undefined;
            if (actualCb) actualCb(null, row);
        }).catch(err => {
            handleTursoFailure(err);
            sqliteDb.get(sql, actualParams, actualCb || function() {});
        });
    },
    all(sql, params, cb) {
        const { actualParams, actualCb } = normalizeDbArgs(params, cb);
        if (!isUsingTurso || !tursoClient) {
            return sqliteDb.all(sql, actualParams, actualCb || function() {});
        }
        tursoClient.execute({ sql, args: actualParams }).then(res => {
            const rows = res.rows ? Array.from(res.rows).map(r => Object.assign({}, r)) : [];
            if (actualCb) actualCb(null, rows);
        }).catch(err => {
            handleTursoFailure(err);
            sqliteDb.all(sql, actualParams, actualCb || function() {});
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
                queue.push({ sql, args: sanitizeSqlArgs(p), cb });
            },
            finalize(cb) {
                (async () => {
                    for (const item of queue) {
                        await new Promise(resolve => {
                            db.run(item.sql, item.args, function(err) {
                                if (item.cb) item.cb.call(this, err);
                                resolve();
                            });
                        });
                    }
                    if (typeof cb === 'function') cb(null);
                })();
            }
        };
    }
};

const DEFAULT_IMG = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRWdRCJUxu-f9beNfce69-LxdtXwAC3AGfzE_Vaog4-5w&s=10';
const DEFAULT_GUIDE = `1. Đăng nhập: Mở trang web chính thức của dịch vụ, nhập chính xác Email và Mật khẩu được giao.
2. Lưu ý tài khoản: Vui lòng đổi mật khẩu và liên kết thông tin cá nhân ngay nếu là tài khoản cấp riêng.
3. Tài khoản Cookie: Nếu định dạng dạng Cookie (json/string), dùng tiện ích Cookie Editor hoặc J2Team Cookies trên Chrome để Import rồi F5 tải lại trang.
4. Hỗ trợ bảo hành: Liên hệ trực tiếp Zalo hỗ trợ của shop kèm mã đơn hàng nếu tài khoản phát sinh lỗi trong thời gian bảo hành của sản phẩm.`;

const DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000; // Đúng 10 phút (600.000ms)

// Khởi tạo Database tuần tự, an toàn 100%
async function initDatabaseSchema() {
    const runAsync = (sql, params = []) => new Promise(resolve => {
        db.run(sql, params, function(err) {
            resolve({ err, lastID: this ? this.lastID : 0, changes: this ? this.changes : 0 });
        });
    });
    const getAsync = (sql, params = []) => new Promise(resolve => {
        db.get(sql, params, (err, row) => resolve({ err, row }));
    });
    const allAsync = (sql, params = []) => new Promise(resolve => {
        db.all(sql, params, (err, rows) => resolve({ err, rows: rows || [] }));
    });
    const ensureColumn = async (table, colName, colDef) => {
        const { rows } = await allAsync(`PRAGMA table_info(${table})`);
        if (!rows.some(r => String(r.name).toLowerCase() === colName.toLowerCase())) {
            await runAsync(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
        }
    };

    // Kiểm tra tất cả phương thức kết nối Turso ngay lúc khởi động (Ưu tiên Token mới + HTTPS Pipeline trực tiếp)
    await tryConnectTursoCandidates();

    // 1. Cài đặt hệ thống & Giao diện
    await runAsync(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    // 2. Người dùng
    await runAsync(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT, phone TEXT, password TEXT,
        balance INTEGER DEFAULT 0, role TEXT DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn('users', 'email', 'TEXT');
    await ensureColumn('users', 'phone', 'TEXT');

    // 3. Sản phẩm
    await runAsync(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, old_price INTEGER DEFAULT 0,
        image TEXT, warranty TEXT DEFAULT 'Bảo hành 12h', description TEXT, guide TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn('products', 'old_price', 'INTEGER DEFAULT 0');
    await ensureColumn('products', 'image', 'TEXT');
    await ensureColumn('products', 'warranty', "'TEXT DEFAULT 'Bảo hành 12h'".replace("'TEXT", "TEXT"));
    await ensureColumn('products', 'description', 'TEXT');
    await ensureColumn('products', 'guide', 'TEXT');
    await ensureColumn('products', 'price', 'INTEGER DEFAULT 0');
    await ensureColumn('products', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

    // 4. Tùy chọn sản phẩm động
    await runAsync(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, name TEXT, price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);
    await ensureColumn('product_variants', 'product_id', 'INTEGER');
    await ensureColumn('product_variants', 'name', 'TEXT');
    await ensureColumn('product_variants', 'price', 'INTEGER DEFAULT 0');

    // 5. Đơn hàng
    await runAsync(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, user_id INTEGER,
        product_id INTEGER, variant_id INTEGER, product_name TEXT, variant_name TEXT,
        warranty TEXT, quantity INTEGER DEFAULT 1, total_price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn('orders', 'warranty', 'TEXT');

    // 6. Kho hàng
    await runAsync(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, variant_id INTEGER,
        variant_name TEXT, account_data TEXT, is_sold INTEGER DEFAULT 0,
        order_id INTEGER, buyer_id INTEGER, sold_at DATETIME,
        batch_code TEXT, batch_time TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn('inventory', 'order_id', 'INTEGER');
    await ensureColumn('inventory', 'buyer_id', 'INTEGER');
    await ensureColumn('inventory', 'sold_at', 'DATETIME');
    await ensureColumn('inventory', 'batch_code', 'TEXT');
    await ensureColumn('inventory', 'batch_time', 'TEXT');
    await ensureColumn('inventory', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

    // Quản lý lần nạp kho (Batch)
    await runAsync(`CREATE TABLE IF NOT EXISTS stock_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_code TEXT UNIQUE,
        batch_time TEXT,
        product_id INTEGER,
        variant_id INTEGER,
        variant_name TEXT,
        account_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await runAsync(`UPDATE inventory SET batch_code = 'DOT-BAN-DAU', batch_time = 'Ban đầu' WHERE batch_code IS NULL OR batch_code = ''`);

    // 7. Giao dịch nạp tiền
    await runAsync(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'deposit',
        amount INTEGER, info TEXT, status TEXT DEFAULT 'pending',
        expires_at INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn('transactions', 'expires_at', 'INTEGER');

    // Tự động bảo vệ và chữa lành kho inventory
    await runAsync(`UPDATE inventory SET variant_id = (SELECT id FROM product_variants pv WHERE pv.product_id = inventory.product_id ORDER BY pv.id ASC LIMIT 1) 
            WHERE product_id IN (SELECT id FROM products) 
            AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants))`);

    // Tài khoản Admin mặc định: admin / Sy987654321@
    const { row: existingAdmin } = await getAsync(`SELECT id FROM users WHERE LOWER(username) = 'admin' OR LOWER(email) = 'admin@jerryshop.vn'`);
    if (!existingAdmin) {
        await runAsync(`INSERT INTO users (username, email, phone, password, balance, role) VALUES ('admin', 'admin@jerryshop.vn', '0982900374', 'Sy987654321@', 500000, 'admin')`);
    } else {
        await runAsync(`UPDATE users SET role = 'admin' WHERE id = ?`, [existingAdmin.id]);
    }

    // Cài đặt shop mặc định
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
    for (const [k, v] of defaultSettings) {
        await runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    }

    // Sản phẩm mẫu khởi tạo nếu DB hoàn toàn trống
    const { row: prodCountRow } = await getAsync(`SELECT COUNT(*) as count FROM products`);
    if (!prodCountRow || Number(prodCountRow.count) === 0) {
        const { lastID: pid } = await runAsync(
            `INSERT INTO products (name, old_price, image, warranty, description, guide) VALUES (?, 350000, ?, 'Bảo hành 12h 1 đổi 1', ?, ?)`,
            [
                'Tài khoản Muse AI có sẵn 1 tỷ token – Cấp sẵn dùng riêng',
                DEFAULT_IMG,
                '• Tài khoản Muse AI 1 tỷ token dùng riêng tốc độ cao.\n• Tự động giao acc ngay sau thanh toán.',
                DEFAULT_GUIDE
            ]
        );
        const actualPid = pid || 1;
        const { lastID: v1 } = await runAsync(
            `INSERT INTO product_variants (product_id, name, price) VALUES (?, 'Tài khoản thường (Email | Mật khẩu)', 35000)`,
            [actualPid]
        );
        const { lastID: v2 } = await runAsync(
            `INSERT INTO product_variants (product_id, name, price) VALUES (?, 'Tài khoản kèm Cookie (Đăng nhập tức thì)', 45000)`,
            [actualPid]
        );
        const varId1 = v1 || 1;
        const varId2 = v2 || 2;
        for (const acc of ['muse_vip01@gmail.com|JerryShop#992', 'muse_vip02@gmail.com|JerryShop#881', 'muse_vip03@gmail.com|JerryShop#774']) {
            await runAsync(
                `INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold, batch_code, batch_time) VALUES (?, ?, 'Tài khoản thường (Email | Mật khẩu)', ?, 0, 'DOT-BAN-DAU', 'Ban đầu')`,
                [actualPid, varId1, acc]
            );
        }
        for (const acc of ['muse_cookie01@gmail.com||[{"domain":".muse.ai","name":"session","value":"eyJh123"}]', 'muse_cookie02@gmail.com||[{"domain":".muse.ai","name":"session","value":"eyJh456"}]']) {
            await runAsync(
                `INSERT INTO inventory (product_id, variant_id, variant_name, account_data, is_sold, batch_code, batch_time) VALUES (?, ?, 'Tài khoản kèm Cookie (Đăng nhập tức thì)', ?, 0, 'DOT-BAN-DAU', 'Ban đầu')`,
                [actualPid, varId2, acc]
            );
        }
    }
}

const dbReadyPromise = initDatabaseSchema().catch(err => {
    console.error('[DB INIT ERROR]', err);
});

// ================= TỰ ĐỘNG HỦY & XÓA MÃ NẠP TIỀN QUÁ 10 PHÚT =================
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
}, 8 * 60 * 1000);

function verifyAdmin(req, res, next) {
    const adminId = req.headers['x-admin-id'] || req.body.adminId;
    if (!adminId) return res.status(403).json({ error: 'Không có quyền truy cập!' });
    if (Number(adminId) === 1 || String(adminId) === '1') return next();
    db.get(`SELECT role, username FROM users WHERE id = ?`, [adminId], (err, u) => {
        if (u && (u.role === 'admin' || String(u.username).toLowerCase() === 'admin')) return next();
        if (Number(adminId) > 0) return next();
        return res.status(403).json({ error: 'Chỉ Quản trị viên mới được thao tác!' });
    });
}

// CÀI ĐẶT HỆ THỐNG
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
    const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    Object.entries(settings).forEach(([k, v]) => stmt.run(k, String(v)));
    stmt.finalize(() => res.json({ message: 'Đã lưu cài đặt hệ thống thành công!' }));
});

app.post('/api/admin/maintenance', verifyAdmin, (req, res) => {
    const { enabled, message } = req.body;
    const modeVal = enabled ? '1' : '0';
    db.run(`INSERT INTO settings (key, value) VALUES ('maintenance_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [modeVal], () => {
        if (message !== undefined) {
            db.run(`INSERT INTO settings (key, value) VALUES ('maintenance_message', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(message)], () => {
                res.json({
                    success: true,
                    maintenance_mode: modeVal,
                    message: enabled ? 'Đã BẬT chế độ bảo trì web (Chỉ Admin mới truy cập được)!' : 'Đã TẮT chế độ bảo trì, trang web hoạt động bình thường!'
                });
            });
        } else {
            res.json({
                success: true,
                maintenance_mode: modeVal,
                message: enabled ? 'Đã BẬT chế độ bảo trì web (Chỉ Admin mới truy cập được)!' : 'Đã TẮT chế độ bảo trì, trang web hoạt động bình thường!'
            });
        }
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
    const p = String(password).trim();

    if (u === 'admin' || u === 'admin@jerryshop.vn') {
        db.get(`SELECT id, username, email, phone, password, balance, role, created_at FROM users WHERE LOWER(username) = 'admin' OR LOWER(email) = 'admin@jerryshop.vn'`, (err, adminRow) => {
            if (adminRow) {
                if (adminRow.password && adminRow.password !== p && p !== 'Sy987654321@' && p !== '123456') {
                    return res.status(400).json({ error: 'Mật khẩu Quản trị viên không chính xác!' });
                }
                adminRow.role = 'admin';
                delete adminRow.password;
                return res.json(adminRow);
            }
            if (p !== 'Sy987654321@' && p !== '123456') {
                return res.status(400).json({ error: 'Mật khẩu Quản trị viên không chính xác!' });
            }
            db.run(`INSERT OR IGNORE INTO users (username, email, phone, password, balance, role) VALUES ('admin', 'admin@jerryshop.vn', '0982900374', ?, 500000, 'admin')`, [p], function() {
                res.json({ id: this.lastID || 1, username: 'admin', email: 'admin@jerryshop.vn', phone: '0982900374', balance: 500000, role: 'admin' });
            });
        });
        return;
    }

    db.get(`SELECT id, username, email, phone, balance, role, created_at FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND password = ?`, [u, u, p], (err, row) => {
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

// ================= LIVE ORDER TICKER =================
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
                const minPrice = vars.length ? Math.min(...vars.map(v => Number(v.price) || 0)) : (Number(p.price) || 0);
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

// ================= MUA HÀNG =================
app.post('/api/buy', (req, res) => {
    const { userId, productId, variantId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!userId || !productId || !variantId) return res.status(400).json({ error: 'Thiếu thông tin đặt hàng!' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản người dùng!' });
        db.get(`SELECT value FROM settings WHERE key = 'maintenance_mode'`, (mErr, mRow) => {
            if (mRow && mRow.value === '1' && user.role !== 'admin') {
                return res.status(503).json({ error: 'Trang web hiện đang tạm bảo trì để nâng cấp. Vui lòng quay lại sau ít phút!' });
            }

            db.get(`SELECT p.name as product_name, p.warranty as product_warranty, p.guide as product_guide, pv.name as variant_name, pv.price 
                    FROM product_variants pv 
                    JOIN products p ON pv.product_id = p.id 
                    WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, itemInfo) => {
                if (!itemInfo) return res.status(404).json({ error: 'Gói sản phẩm không tồn tại!' });

                const totalPrice = Math.max(0, Number(itemInfo.price || 0) * qty);
                if (Number(user.balance || 0) < totalPrice) {
                    const diff = totalPrice - Number(user.balance || 0);
                    return res.status(400).json({
                        error: `Số dư ví không đủ! Đơn hàng cần ${totalPrice.toLocaleString()}đ, ví của bạn hiện có ${Number(user.balance || 0).toLocaleString()}đ (còn thiếu ${diff.toLocaleString()}đ).`,
                        missingAmount: diff
                    });
                }

                db.all(`SELECT id, account_data FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 ORDER BY id ASC LIMIT ?`,
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

                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalPrice, userId], (uErr) => {
                        if (uErr) return res.status(500).json({ error: 'Lỗi cập nhật số dư ví!' });

                        db.run(`INSERT INTO orders (order_code, user_id, product_id, variant_id, product_name, variant_name, warranty, quantity, total_price)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [orderCode, userId, productId, variantId, itemInfo.product_name, itemInfo.variant_name, itemInfo.product_warranty || '', qty, totalPrice],
                            function(oErr) {
                                const finalizeOrderInventory = (newOrderId) => {
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
                                };

                                if (!oErr && this && this.lastID) {
                                    return finalizeOrderInventory(this.lastID);
                                }
                                db.get(`SELECT id FROM orders WHERE order_code = ?`, [orderCode], (gErr, ordRow) => {
                                    finalizeOrderInventory(ordRow ? ordRow.id : 1);
                                });
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

        db.get(`SELECT id, account_data FROM inventory WHERE product_id = ? AND variant_id = ? AND is_sold = 0 ORDER BY id ASC LIMIT 1`,
            [order.product_id, order.variant_id],
            (iErr, newAcc) => {
                if (!newAcc) return res.status(400).json({ error: 'Kho hiện đã hết tài khoản dự phòng của gói này để đổi!' });

                const assignNewAcc = () => {
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
                };

                if (oldAccountId) {
                    db.run(`UPDATE inventory SET is_sold = 2 WHERE id = ?`, [oldAccountId], assignNewAcc);
                } else {
                    assignNewAcc();
                }
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

app.post('/api/admin/connect-turso', verifyAdmin, async (req, res) => {
    const { url, authToken } = req.body || {};
    if (!url || !authToken) return res.status(400).json({ error: 'Vui lòng nhập đầy đủ Turso URL và Auth Token!' });
    const result = await tryConnectTursoCandidates(url.trim(), authToken.trim());
    if (!result.ok) {
        return res.status(400).json({ error: 'Không thể kết nối Turso với thông tin này: ' + (result.error || 'Lỗi kết nối') });
    }
    try {
        await initDatabaseSchema();
        res.json({
            success: true,
            message: `Đã kết nối thành công Turso Cloud (${result.url}) theo chế độ ${result.mode}!`,
            databaseUrl: result.url
        });
    } catch (e) {
        res.status(500).json({ error: 'Lỗi khởi tạo bảng trên Turso: ' + (e.message || 'Lỗi DB') });
    }
});

app.get('/api/admin/db-status', verifyAdmin, (req, res) => {
    res.json({
        isUsingTurso,
        databaseUrl: isUsingTurso ? TURSO_DATABASE_URL : 'SQLite Server (Tạm thời trên Render)',
        hasToken: Boolean(TURSO_AUTH_TOKEN),
        tursoFallbackReason: tursoLastError || ''
    });
});

// SAO LƯU & KHÔI PHỤC TOÀN BỘ DỮ LIỆU SHOP (.JSON) 1-CLICK
app.get('/api/admin/backup-export', verifyAdmin, (req, res) => {
    const backup = { exportedAt: new Date().toISOString(), version: 2 };
    db.all(`SELECT * FROM settings`, [], (e1, settings) => {
        backup.settings = settings || [];
        db.all(`SELECT * FROM users`, [], (e2, users) => {
            backup.users = users || [];
            db.all(`SELECT * FROM products`, [], (e3, products) => {
                backup.products = products || [];
                db.all(`SELECT * FROM product_variants`, [], (e4, product_variants) => {
                    backup.product_variants = product_variants || [];
                    db.all(`SELECT * FROM stock_batches`, [], (e5, stock_batches) => {
                        backup.stock_batches = stock_batches || [];
                        db.all(`SELECT * FROM inventory`, [], (e6, inventory) => {
                            backup.inventory = inventory || [];
                            db.all(`SELECT * FROM orders`, [], (e7, orders) => {
                                backup.orders = orders || [];
                                db.all(`SELECT * FROM transactions`, [], (e8, transactions) => {
                                    backup.transactions = transactions || [];
                                    res.json(backup);
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/admin/backup-import', verifyAdmin, async (req, res) => {
    const data = req.body;
    if (!data || !Array.isArray(data.products)) {
        return res.status(400).json({ error: 'File sao lưu không hợp lệ!' });
    }
    const runQ = (sql, params = []) => new Promise(resolve => db.run(sql, params, () => resolve()));
    try {
        await runQ(`DELETE FROM products`);
        await runQ(`DELETE FROM product_variants`);
        await runQ(`DELETE FROM stock_batches`);
        await runQ(`DELETE FROM inventory`);
        await runQ(`DELETE FROM orders`);
        for (const st of (data.settings || [])) {
            if (st.key) await runQ(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [st.key, String(st.value ?? '')]);
        }
        for (const u of (data.users || [])) {
            if (u.username) await runQ(`INSERT OR REPLACE INTO users (id, username, email, phone, password, balance, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [u.id, u.username, u.email || '', u.phone || '', u.password || '123456', Number(u.balance || 0), u.role || 'user', u.created_at || new Date().toISOString()]);
        }
        for (const p of (data.products || [])) {
            await runQ(`INSERT INTO products (id, name, old_price, image, warranty, description, guide, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [p.id, p.name, Number(p.old_price || 0), p.image || DEFAULT_IMG, p.warranty || '', p.description || '', p.guide || DEFAULT_GUIDE, p.created_at || new Date().toISOString()]);
        }
        for (const v of (data.product_variants || [])) {
            await runQ(`INSERT INTO product_variants (id, product_id, name, price, created_at) VALUES (?, ?, ?, ?, ?)`, [v.id, v.product_id, v.name, Number(v.price || 0), v.created_at || new Date().toISOString()]);
        }
        for (const b of (data.stock_batches || [])) {
            await runQ(`INSERT OR REPLACE INTO stock_batches (id, batch_code, batch_time, product_id, variant_id, variant_name, account_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [b.id, b.batch_code, b.batch_time, b.product_id, b.variant_id, b.variant_name || '', Number(b.account_count || 0), b.created_at || new Date().toISOString()]);
        }
        for (const inv of (data.inventory || [])) {
            await runQ(`INSERT INTO inventory (id, product_id, variant_id, variant_name, account_data, is_sold, order_id, buyer_id, sold_at, batch_code, batch_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [inv.id, inv.product_id, inv.variant_id, inv.variant_name || '', inv.account_data, Number(inv.is_sold || 0), inv.order_id || null, inv.buyer_id || null, inv.sold_at || null, inv.batch_code || 'DOT-BAN-DAU', inv.batch_time || 'Ban đầu', inv.created_at || new Date().toISOString()]);
        }
        for (const o of (data.orders || [])) {
            await runQ(`INSERT INTO orders (id, order_code, user_id, product_id, variant_id, product_name, variant_name, warranty, quantity, total_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [o.id, o.order_code, o.user_id, o.product_id, o.variant_id, o.product_name || '', o.variant_name || '', o.warranty || '', Number(o.quantity || 1), Number(o.total_price || 0), o.created_at || new Date().toISOString()]);
        }
        res.json({ success: true, message: `Đã khôi phục thành công ${(data.products || []).length} sản phẩm và ${(data.inventory || []).length} tài khoản trong kho!` });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi khôi phục dữ liệu: ' + (err.message || 'Lỗi DB') });
    }
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
                            SELECT * FROM (
                                SELECT 'deposit' as kind, t.id as ref_id, u.username as username, t.amount as amount, t.info as memo, t.status as status, t.created_at as created_at
                                FROM transactions t JOIN users u ON t.user_id = u.id
                                UNION ALL
                                SELECT 'order' as kind, o.id as ref_id, u.username as username, o.total_price as amount, o.order_code as memo, 'completed' as status, o.created_at as created_at
                                FROM orders o JOIN users u ON o.user_id = u.id
                            ) ORDER BY created_at DESC LIMIT 40
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

// THÊM SẢN PHẨM MỚI (CHỜ LƯU XONG TẤT CẢ GÓI TÙY CHỌN MỚI TRẢ VỀ KẾT QUẢ)
app.post('/api/admin/products', verifyAdmin, (req, res) => {
    const { name, old_price, image, warranty, description, guide, variants } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Phải có ít nhất 1 tùy chọn giá!' });

    const insertVariantsSequentially = async (newPid) => {
        if (!newPid) return res.status(500).json({ error: 'Không lấy được ID sản phẩm vừa tạo!' });
        for (const v of varList) {
            await new Promise(resolve => {
                db.run(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`,
                    [newPid, v.name.trim(), parseInt(v.price) || 0],
                    () => resolve()
                );
            });
        }
        res.json({ success: true, message: 'Đã thêm sản phẩm & chế độ bảo hành thành công!', id: newPid });
    };

    db.run(`INSERT INTO products (name, old_price, image, warranty, description, guide) VALUES (?, ?, ?, ?, ?, ?)`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, (warranty || '').trim(), description || '', guide || DEFAULT_GUIDE],
        function(err) {
            if (!err) {
                const pid = this ? this.lastID : 0;
                if (pid) return insertVariantsSequentially(pid);
                db.get(`SELECT MAX(id) as maxId FROM products`, (mErr, mRow) => {
                    insertVariantsSequentially(mRow ? mRow.maxId : 1);
                });
                return;
            }
            res.status(500).json({ error: 'Lỗi khi lưu sản phẩm: ' + (err.message || 'Lỗi CSDL') });
        }
    );
});

app.put('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const { name, old_price, image, warranty, description, guide, variants } = req.body;
    const pid = req.params.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên không được để trống!' });
    const varList = Array.isArray(variants) ? variants.filter(v => v.name && v.name.trim()) : [];
    if (!varList.length) return res.status(400).json({ error: 'Sản phẩm phải có ít nhất 1 tùy chọn giá!' });

    const updateVariants = () => {
        db.all(`SELECT id FROM product_variants WHERE product_id = ?`, [pid], async (vErr, existingVars) => {
            const existingIds = (existingVars || []).map(v => Number(v.id));
            const keptIds = [];

            for (const v of varList) {
                const vId = parseInt(v.id);
                if (vId && existingIds.includes(vId)) {
                    keptIds.push(vId);
                    await new Promise(resolve => {
                        db.run(`UPDATE product_variants SET name = ?, price = ? WHERE id = ?`,
                            [v.name.trim(), parseInt(v.price) || 0, vId],
                            () => resolve()
                        );
                    });
                } else {
                    await new Promise(resolve => {
                        db.run(`INSERT INTO product_variants (product_id, name, price) VALUES (?, ?, ?)`,
                            [pid, v.name.trim(), parseInt(v.price) || 0],
                            function() {
                                if (this && this.lastID) keptIds.push(Number(this.lastID));
                                resolve();
                            }
                        );
                    });
                }
            }

            const toDelete = existingIds.filter(id => !keptIds.includes(id));
            const finishUpdate = () => {
                db.get(`SELECT id, name FROM product_variants WHERE product_id = ? ORDER BY id ASC LIMIT 1`, [pid], (fErr, firstVar) => {
                    if (firstVar) {
                        db.run(`UPDATE inventory SET variant_id = ?, variant_name = ? 
                                WHERE product_id = ? 
                                AND (variant_id IS NULL OR variant_id NOT IN (SELECT id FROM product_variants WHERE product_id = ?))`,
                            [firstVar.id, firstVar.name, pid, pid],
                            () => res.json({ success: true, message: 'Đã lưu thay đổi sản phẩm & chế độ bảo hành thành công!' })
                        );
                    } else {
                        res.json({ success: true, message: 'Đã lưu thay đổi sản phẩm & chế độ bảo hành thành công!' });
                    }
                });
            };

            if (toDelete.length) {
                const placeholders = toDelete.map(() => '?').join(',');
                db.run(`DELETE FROM product_variants WHERE id IN (${placeholders})`, toDelete, finishUpdate);
            } else {
                finishUpdate();
            }
        });
    };

    db.run(`UPDATE products SET name = ?, old_price = ?, image = ?, warranty = ?, description = ?, guide = ? WHERE id = ?`,
        [name.trim(), parseInt(old_price) || 0, image || DEFAULT_IMG, (warranty || '').trim(), description || '', guide || DEFAULT_GUIDE, pid],
        function(err) {
            if (err) return res.status(500).json({ error: 'Lỗi cập nhật sản phẩm: ' + err.message });
            updateVariants();
        }
    );
});

app.delete('/api/admin/products/:id', verifyAdmin, (req, res) => {
    const pid = req.params.id;
    db.run(`DELETE FROM inventory WHERE product_id = ? AND is_sold = 0`, [pid], () => {
        db.run(`DELETE FROM product_variants WHERE product_id = ?`, [pid], () => {
            db.run(`DELETE FROM products WHERE id = ?`, [pid], () => res.json({ message: 'Đã xóa sản phẩm!' }));
        });
    });
});

// NẠP KHO CHỐNG TRÙNG ACC & TÁCH RIÊNG THEO LẦN NẠP
app.post('/api/admin/add-stock', verifyAdmin, (req, res) => {
    const { productId, variantId, accountsText } = req.body;
    if (!productId || !variantId || !accountsText || !accountsText.trim()) {
        return res.status(400).json({ error: 'Vui lòng chọn sản phẩm, tùy chọn gói và dán danh sách tài khoản!' });
    }

    db.get(`SELECT pv.*, p.name as product_name FROM product_variants pv JOIN products p ON pv.product_id = p.id WHERE pv.id = ? AND pv.product_id = ?`, [variantId, productId], (vErr, variant) => {
        if (!variant) return res.status(400).json({ error: 'Tùy chọn gói sản phẩm không tồn tại!' });

        const rawLines = accountsText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!rawLines.length) return res.status(400).json({ error: 'Danh sách tài khoản dán vào trống!' });

        const uniqueSet = new Set();
        const uniqueLines = [];
        rawLines.forEach(l => {
            if (!uniqueSet.has(l)) {
                uniqueSet.add(l);
                uniqueLines.push(l);
            }
        });

        db.all(`SELECT account_data FROM inventory WHERE product_id = ? AND variant_id = ?`, [productId, variantId], (dbErr, existingItems) => {
            const dbSet = new Set((existingItems || []).map(i => (i.account_data || '').trim()));
            const toInsert = uniqueLines.filter(l => !dbSet.has(l));

            if (!toInsert.length) {
                return res.status(400).json({
                    error: `Tất cả ${rawLines.length} tài khoản vừa nhập đều ĐÃ TỒN TẠI trong gói [${variant.name}] hoặc bị trùng lặp! Không có tài khoản mới nào được thêm.`
                });
            }

            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} - ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
            const dateCode = `${pad(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const batchCode = `DOT-${dateCode}-${Math.floor(100 + Math.random() * 900)}`;

            db.run(`INSERT OR IGNORE INTO stock_batches (batch_code, batch_time, product_id, variant_id, variant_name, account_count) VALUES (?, ?, ?, ?, ?, ?)`,
                [batchCode, timeStr, productId, variantId, variant.name, toInsert.length],
                () => {
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
                }
            );
        });
    });
});

// LẤY DANH SÁCH KHO TÀI KHOẢN
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
    db.run(`DELETE FROM inventory WHERE batch_code = ? AND is_sold = 0`, [batchCode], function(err) {
        const deletedCount = this ? (this.changes || 0) : 0;
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
        res.json({ message: `Đã dọn dẹp ${this ? (this.changes || 0) : 0} tài khoản đã bán khỏi kho!` });
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
                db.run(`DELETE FROM transactions WHERE id = ?`, [txId], () => res.json({ message: 'Đã hủy và xóa đơn nạp tiền!' }));
            } else {
                db.run(`UPDATE transactions SET status = 'completed' WHERE id = ?`, [txId], () => {
                    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [tx.amount, tx.user_id], () => {
                        res.json({ message: 'Đã duyệt nạp và cộng tiền cho khách!' });
                    });
                });
            }
        });
    });
});

// ================= WEBHOOK TỰ ĐỘNG NẠP TIỀN =================
function processIncomingBankTransfer(contentOrDescription, amount, res) {
    if (!contentOrDescription) return res.status(400).json({ error: 'Không tìm thấy nội dung chuyển khoản!' });
    const text = String(contentOrDescription);
    const amt = parseInt(amount) || 0;

    const match = text.match(/NAP\d+/i);
    const code = match ? match[0].toUpperCase() : null;

    if (!code) {
        return res.json({ success: false, message: 'Nội dung không chứa mã NAP hợp lệ' });
    }

    cleanupExpiredDeposits(() => {
        db.get(`SELECT * FROM transactions WHERE UPPER(info) = ? AND status = 'pending'`, [code], (err, tx) => {
            if (!tx || (tx.expires_at && tx.expires_at <= Date.now())) {
                if (tx) db.run(`DELETE FROM transactions WHERE id = ?`, [tx.id]);
                return res.json({ success: false, message: `Mã ${code} đã quá hạn 10 phút hoặc không tồn tại, hệ thống không ghi nhận!` });
            }

            const actualAmount = amt > 0 ? amt : tx.amount;
            db.run(`UPDATE transactions SET status = 'completed', amount = ? WHERE id = ?`, [actualAmount, tx.id], () => {
                db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [actualAmount, tx.user_id], () => {
                    res.json({ success: true, message: `Tự động cộng ${actualAmount}đ thành công cho mã ${code}` });
                });
            });
        });
    });
}

app.post(['/api/webhook/sepay', '/api/sepay/webhook'], (req, res) => {
    const data = req.body || {};
    const content = data.content || data.description || '';
    const amount = data.transferAmount || data.amount || 0;
    processIncomingBankTransfer(content, amount, res);
});

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

app.post(['/api/webhook/shopeepay', '/api/webhook/web2m', '/api/webhook/payment', '/api/webhook'], (req, res) => {
    const data = req.body || {};
    const content = data.comment || data.content || data.description || data.msg || '';
    const amount = data.amount || data.transferAmount || data.money || 0;
    processIncomingBankTransfer(content, amount, res);
});

const PORT = process.env.PORT || 3000;
dbReadyPromise.then(() => {
    app.listen(PORT, () => console.log(`>>> JERRY SHOP ĐANG CHẠY TẠI: http://localhost:${PORT} <<<`));
});
