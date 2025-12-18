// app.js (VERCEL OPTIMIZED: POOLING + PREMIUM EMAIL)
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./config/database');
const qrcode = require('qrcode');
const nodemailer = require('nodemailer');
const MySQLStore = require('express-mysql-session')(session);
const app = express();
const PORT = 3000;
const APP_DOMAIN = process.env.APP_DOMAIN || "localhost:3000";

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
const sessionStore = new MySQLStore({}, db);
app.use(session({
    key: 'session_cookie_name',
    secret: process.env.SESSION_SECRET || 'rahasia_default',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        maxAge: 3600000,
        sameSite: 'lax'
    }
}));

const requireLogin = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.send("<h1>403 Forbidden</h1><p>Anda bukan Admin!</p><a href='/'>Kembali</a>");
    }
    next();
};

// --- OPTIMASI EMAIL (POOLING) ---
// pool: true membuat koneksi tetap hidup, jadi kirim email kedua dst lebih cepat
const transporter = nodemailer.createTransport({
    pool: true,
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.GMAIL_USER || 'anjargaming06@gmail.com',
        pass: process.env.GMAIL_PASS || 'jtjyoqtnskprfmrj'
    },
    maxConnections: 5,
    maxMessages: 100
});
function autoExpireBookings() {
    const sql = `
        SELECT id, table_id, parking_slot_id
        FROM reservations
        WHERE status IN ('pending','confirmed')
        AND booking_end IS NOT NULL
        AND booking_end < DATE_ADD(NOW(), INTERVAL 7 HOUR)
        LIMIT 10
    `;

    db.query(sql, (err, results) => {
        if (err) return console.error(err);

        if (results.length > 0) {
            console.log(`⏰ Auto-expired ${results.length} booking(s)`);
        }

        results.forEach(b => {
            db.query("UPDATE reservations SET status='expired' WHERE id=?", [b.id]);
            db.query("UPDATE tables SET status='available' WHERE id=?", [b.table_id]);
            if (b.parking_slot_id)
                db.query("UPDATE parking_slots SET status='available' WHERE id=?", [b.parking_slot_id]);
        });
    });
}

app.use((req, res, next) => {
    autoExpireBookings();
    next();
});

app.get('/menu', (req, res) => {
    db.query("SELECT * FROM menus", (err, results) => {
        if (err) throw err;
        res.render('menu', { menus: results, user: req.session.userId ? req.session : null });
    });
});

app.get('/dashboard', requireLogin, (req, res) => {
    const sqlTables = "SELECT * FROM tables ORDER BY id ASC";
    const sqlParking = "SELECT * FROM parking_slots ORDER BY id ASC";
    db.query(sqlTables, (err, tablesResult) => {
        if (err) throw err;
        db.query(sqlParking, (err, parkingResult) => {
            if (err) throw err;
            const mobil = parkingResult.filter(slot => slot.type === 'car');
            const motor = parkingResult.filter(slot => slot.type === 'bike');
            res.render('dashboard', {
                tables: tablesResult, mobil: mobil, motor: motor, user: req.session
            });
        });
    });
});
// --- ROUTE HISTORY (RIWAYAT) ---
app.get('/history', requireLogin, (req, res) => {
    const userId = req.session.userId;

    // Ambil semua reservasi milik user ini, urutkan dari yang terbaru
    const sql = `SELECT * FROM reservations
                 WHERE user_id = ?
                 ORDER BY created_at DESC`;
    db.query(sql, [userId], (err, results) => {
        if (err) throw err;
        // Render halaman history
        res.render('history', {
            bookings: results,
            user: req.session
        });
    });
});
// Auth
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('login');
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err) { console.error(err); return res.render('login', { error: 'DB Error' }); }
        if (results.length === 0 || !bcrypt.compareSync(password, results[0].password)) {
            return res.render('login', { error: 'Email atau Password Salah!' });
        }
        req.session.userId = results[0].id;
        req.session.userName = results[0].name;
        req.session.role = results[0].role;
        req.session.save(err => { res.redirect('/dashboard'); });
    });
});

app.post('/register', (req, res) => {
    const { name, email, phone, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    const sql = "INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, 'customer')";
    db.query(sql, [name, email, phone, hashedPassword], (err, result) => {
        if (err) return res.render('login', { error: 'Email sudah terdaftar!' });
        res.render('login', { error: 'Registrasi Berhasil! Silakan Login.' });
    });
});

app.post('/auth/google', (req, res) => {
    const { email, name, phone } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err) return res.sendStatus(500);
        if (results.length > 0) {
            req.session.userId = results[0].id;
            req.session.userName = results[0].name;
            req.session.role = results[0].role;
            req.session.save(err => { res.sendStatus(200); });
        } else {
            const dummyPassword = bcrypt.hashSync("GOOGLE_ACCESS_TOKEN", 10);
            const sqlInsert = "INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, 'customer')";
            db.query(sqlInsert, [name, email, phone, dummyPassword], (err, result) => {
                if (err) return res.sendStatus(500);
                req.session.userId = result.insertId;
                req.session.userName = name;
                req.session.role = 'customer';
                req.session.save(err => { res.sendStatus(200); });
            });
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Booking
app.post('/book', requireLogin, (req, res) => {
    const { name, email, phone, date, time, table_id, parking_id } = req.body;
    const userId = req.session.userId;
    // === AUTO EXPIRE 90 MENIT ===
    const bookingStart = new Date(`${date}T${time}:00`);
    const bookingEnd = new Date(bookingStart.getTime() + 2 * 60000); // 90 menit

    const startTime = bookingStart.toTimeString().slice(0, 8);
    const endTime   = bookingEnd.toTimeString().slice(0, 8);

    const finalParkingId = parking_id === '' ? null : parking_id;
    const bookingId = "RES-" + Date.now();
    const sqlBooking = `INSERT INTO reservations
        (id, user_id, table_id, parking_slot_id, reservation_date, start_time, end_time, booking_start, booking_end,status, payment_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid')`;
    db.query(sqlBooking, [bookingId, userId, table_id, finalParkingId, date, startTime, endTime, bookingStart,
    bookingEnd], (err, result) => {
        if (err) return res.send("Gagal Reservasi.");
        db.query("UPDATE tables SET status = 'maintenance' WHERE id = ?", [table_id]);
        if (finalParkingId) db.query("UPDATE parking_slots SET status = 'maintenance' WHERE id = ?", [finalParkingId]);
        res.redirect('/pay/' + bookingId);
    });
});

app.get('/pay/:id', requireLogin, (req, res) => {
    const bookingId = req.params.id;
    const paymentString = "QRIS-PAYMENT-" + bookingId + "-RP50000";
    qrcode.toDataURL(paymentString, (err, url) => {
        if (err) return res.send("Error generating QRIS");
        res.render('payment', { booking: { id: bookingId }, qr_code: url });
    });
});

// --- CONFIRM PAY & SEND EMAIL (DESIGN FIX) ---
app.post('/pay/confirm/:id', requireLogin, (req, res) => {
    const bookingId = req.params.id;
    const sqlUpdate = "UPDATE reservations SET status = 'confirmed', payment_status = 'paid' WHERE id = ?";
    db.query(sqlUpdate, [bookingId], (err, result) => {
        if (err) return res.send("Gagal verifikasi pembayaran.");
        const sqlGet = `SELECT r.*, u.name, u.email FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`;
        db.query(sqlGet, [bookingId], async (err, results) => {
            if (results.length === 0) return res.redirect('/dashboard');
            const data = results[0];
            const datePretty = new Date(data.reservation_date).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            // DESAIN PREMIUM DIKEMBALIKAN
            const mailOptions = {
                from: '"DineDock System" <' + (process.env.GMAIL_USER || 'anjargaming06@gmail.com') + '>',
                to: data.email,
                subject: '✅ Payment Received: DineDock Booking ' + bookingId,
                html: `
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                        <div style="background-color: #111111; padding: 30px 20px; text-align: center; border-bottom: 4px solid #c5a059;">
                            <h2 style="color: #c5a059; margin: 0; letter-spacing: 2px;">PAYMENT SUCCESSFUL</h2>
                            <p style="color: #888; margin: 5px 0 0; font-size: 14px;">Terima kasih, pesanan Anda telah terkonfirmasi.</p>
                        </div>
                        <div style="padding: 30px;">
                            <p style="font-size: 16px; color: #333;">Halo <strong>${data.name}</strong>,</p>
                            <p style="color: #666; line-height: 1.6;">Pembayaran Booking Fee sebesar <strong>Rp 50.000</strong> telah kami terima.</p>
                            <table style="width: 100%; border-collapse: collapse; margin-top: 20px; background-color: #f9f9f9; border-radius: 5px;">
                                <tr><td style="padding: 15px; color: #666; border-bottom: 1px solid #eee;">Booking ID</td><td style="padding: 15px; font-weight: bold;">${bookingId}</td></tr>
                                <tr><td style="padding: 15px; color: #666; border-bottom: 1px solid #eee;">Tanggal</td><td style="padding: 15px; font-weight: bold;">${datePretty}</td></tr>
                                <tr><td style="padding: 15px; color: #666; border-bottom: 1px solid #eee;">Jam</td><td style="padding: 15px; font-weight: bold;">${data.start_time}</td></tr>
                                <tr><td style="padding: 15px; color: #666; border-bottom: 1px solid #eee;">Meja</td><td style="padding: 15px; font-weight: bold; color: #c5a059;">${data.table_id}</td></tr>
                            </table>
                            <div style="text-align: center; margin-top: 35px;">
                                <a href="https://${APP_DOMAIN}/ticket/${bookingId}" style="background-color: #c5a059; color: #000; padding: 14px 30px; text-decoration: none; font-weight: bold; border-radius: 50px; display: inline-block;">
                                    LIHAT E-TICKET
                                </a>
                            </div>
                        </div>
                    </div>
                `
            };
            // LOGIKA PENGIRIMAN
            try {
                console.log("⏳ Mengirim email...");
                // Kita tunggu email terkirim, tapi dengan batas toleransi waktu
                await transporter.sendMail(mailOptions);
                console.log("✅ Email terkirim!");
            } catch (error) {
                console.error("⚠️ Gagal kirim email (tapi lanjut):", error.message);
            }
            res.redirect('/ticket/' + bookingId);
        });
    });
});

app.get('/ticket/:id', requireLogin, (req, res) => {
    const bookingId = req.params.id;
    const sql = `SELECT r.*, u.name, u.email FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ? AND r.user_id = ?`;
    db.query(sql, [bookingId, req.session.userId], (err, results) => {
        if (err || results.length === 0) return res.send("Tiket tidak ditemukan!");
        const verifyUrl = `https://${APP_DOMAIN}/verify/${bookingId}`;
        qrcode.toDataURL(verifyUrl, (err, url) => {
            res.render('ticket', { booking: results[0], qr_code: url, user: req.session });
        });
    });
});

app.get('/verify/:id', (req, res) => {
    const bookingId = req.params.id;
    const sql = `SELECT r.*, u.name FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`;
    db.query(sql, [bookingId], (err, results) => {
        if (err || results.length === 0) return res.send("<h1>❌ QR Code Tidak Dikenali</h1>");
        res.render('verify', { booking: results[0], user: req.session.userId ? req.session : null });
    });
});

app.get('/admin', requireAdmin, (req, res) => {
    const sql = `SELECT r.*, u.name as user_name, u.phone as user_phone, DATE_FORMAT(r.reservation_date, '%d-%m-%Y') as reservation_date_fmt FROM reservations r JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC`;
    db.query(sql, (err, results) => {
        if (err) throw err;
        const paidBookings = results.filter(r => r.payment_status === 'paid');
        const totalRevenue = paidBookings.length * 50000;
        const totalGuests = results.length;
        let mobilCount = 0, motorCount = 0;
        results.forEach(r => {
            if (r.parking_slot_id) {
                if (r.parking_slot_id.startsWith('A')) mobilCount++;
                else if (r.parking_slot_id.startsWith('B')) motorCount++;
            }
        });
        const unpaidCount = results.filter(r => r.payment_status === 'unpaid').length;
        const paidCount = paidBookings.length;
        res.render('admin', {
            reservations: results,
            stats: { revenue: totalRevenue, guests: totalGuests, mobil: mobilCount, motor: motorCount, paid: paidCount, unpaid: unpaidCount }
        });
    });
});
app.post('/admin/checkin/:id', requireAdmin, (req, res) => {
    db.query("UPDATE reservations SET status = 'checked_in' WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/cancel/:id', requireAdmin, (req, res) => {
    const bookingId = req.params.id;
    db.query("SELECT * FROM reservations WHERE id = ?", [bookingId], (err, results) => {
        if(results.length > 0) {
            const booking = results[0];
            db.query("DELETE FROM reservations WHERE id = ?", [bookingId]);
            db.query("UPDATE tables SET status = 'available' WHERE id = ?", [booking.table_id]);
            if(booking.parking_slot_id) db.query("UPDATE parking_slots SET status = 'available' WHERE id = ?", [booking.parking_slot_id]);
        }
        res.redirect('/admin');
    });
});
app.get('/fix-db', (req, res) => {
    const initDatabase = require('./config/setup');
    initDatabase(); // Paksa jalankan fungsi update database
    res.send("<h1>🔄 Database Sedang Diupdate...</h1><p>Silakan tunggu 5-10 detik, lalu <a href='/menu'>Cek Halaman Menu</a>.</p>");
});
// SETUP
const initDatabase = require('./config/setup');
initDatabase();

// ⚠️ JANGAN listen di Vercel
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Server berjalan di Port ${PORT}`);
    });
}

module.exports = app;
