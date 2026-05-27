// api/index.js — lapakID Backend
// Features: IDs, Like, Promo, Payment, Settings, Notifications, Reports, Wishlist, Bans, Reset Database

const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://n4taza_db:N44E8WEKlOJLZIHQ@cluster0.pdfnlfb.mongodb.net/?appName=Cluster0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'lapakid_admin_secret_2026';
const DB_NAME = 'lapakid';

let cachedClient = null;
let cachedDb = null;

async function getDB() {
  if (cachedDb && cachedClient && cachedClient.topology?.isConnected?.()) {
    return cachedDb;
  }
  if (cachedClient) {
    try { await cachedClient.close(); } catch (_) {}
    cachedClient = null;
    cachedDb = null;
  }
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 30000,
    retryWrites: true,
    retryReads: true,
  });
  await client.connect();
  cachedClient = client;
  cachedDb = client.db(DB_NAME);
  return cachedDb;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-token');
}
function ok(res, data)         { res.status(200).json({ success: true,  ...data }); }
function created(res, data)    { res.status(201).json({ success: true,  ...data }); }
function fail(res, code, msg)  { res.status(code).json({ success: false, message: msg }); }

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
function isAdmin(req) {
  const tok = req.headers['x-admin-token'];
  return tok === ADMIN_TOKEN;
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function qs(url) {
  try {
    const i = url.indexOf('?');
    return i === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
  } catch { return {}; }
}
function parts(url) {
  return url.split('?')[0].replace(/^\/api\/?/, '').split('/').filter(Boolean);
}

async function ensureSettings(db) {
  const col = db.collection('settings');
  const existing = await col.find().toArray();
  const existingKeys = new Set(existing.map(s => s.key));
  
  const defaults = {
    prices: { low: 125000, medium: 450000, high: 850000, legend: 1350000 },
    adminFee: { qris: 0, google: 5000 },
    siteInfo: { name: 'lapakID', description: 'Koleksi ID Premium', contact: '' },
    music: { enabled: false, list: [] },
    banners: [],
    popup: { active: false, title: '', desc: '', code: '', imageUrl: '' }
  };
  
  for (const [key, value] of Object.entries(defaults)) {
    if (!existingKeys.has(key)) {
      await col.insertOne({ key, value });
    }
  }
}

module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawPath = req.url.split('?')[0];
  if (rawPath === '/' || rawPath === '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>lapakID — Koleksi ID Premium</title>
<meta property="og:title" content="lapakID — Koleksi ID Premium"/>
<meta property="og:description" content="Koleksi ID premium pilihan. Tersedia dalam 4 tier: Low, Medium, High, dan Legend. Beli dengan aman, bergaransi, dan proses cepat."/>
<meta property="og:image" content="https://files.catbox.moe/em51di.png"/>
<meta property="og:url" content="https://nataza.vercel.app/"/>
<meta property="og:type" content="website"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="https://files.catbox.moe/em51di.png"/>
<link rel="icon" type="image/png" href="https://files.catbox.moe/em51di.png"/>
<meta http-equiv="refresh" content="0;url=/index.html"/>
<script>window.location.replace('/index.html');</script>
</head>
<body></body>
</html>`);
  }

  let db;
  try {
    db = await getDB();
    await ensureSettings(db);
  } catch (err) {
    console.error('[MongoDB]', err.message);
    return fail(res, 503, 'Database tidak dapat terhubung: ' + err.message);
  }

  const [r0, r1, r2] = parts(req.url);
  const M = req.method.toUpperCase();

  try {
    // ── admin/login ──────────────────────────────────────────────────────────
    if (r0==='admin' && r1==='login' && M==='POST') {
      const b = await readBody(req);
      if (b.token === ADMIN_TOKEN) return ok(res, { token: ADMIN_TOKEN });
      return fail(res, 401, 'Token admin salah');
    }

    // ── IDs ──────────────────────────────────────────────────────────────────
    if (r0==='ids') {
      if (r1==='popular' && M==='GET') {
        const d = await db.collection('ids')
          .find({ sold: { $ne: true }, likes: { $gt: 0 } })
          .sort({ likes: -1 }).limit(12).toArray();
        return ok(res, { data: d });
      }
      if (r1==='stats' && M==='GET') {
        const col = db.collection('ids');
        const [tot, sold, byT, likeT] = await Promise.all([
          col.countDocuments(),
          col.countDocuments({ sold: true }),
          col.aggregate([{ $group: { _id:'$tier', count:{$sum:1},
            sold:{ $sum:{ $cond:[{$eq:['$sold',true]},1,0] } },
            likes:{ $sum:'$likes' } }}]).toArray(),
          col.aggregate([{ $group: { _id:null, t:{$sum:'$likes'} }}]).toArray(),
        ]);
        const byTier = {};
        byT.forEach(t => { byTier[t._id] = { count:t.count, sold:t.sold, likes:t.likes }; });
        return ok(res, { data: { total:tot, sold, available:tot-sold, totalLikes:likeT[0]?.t||0, byTier } });
      }
      if (!r1 && M==='GET') {
        const q = qs(req.url);
        const f = {};
        if (q.tier && q.tier!=='all') f.tier = q.tier;
        if (q.sold==='true') f.sold = true;
        else if (q.sold==='false') f.sold = { $ne: true };
        if (q.search) f.number = { $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), $options:'i' };
        let sort = { addedAt:-1 };
        if (q.sort==='likes') sort = { likes:-1 };
        if (q.sort==='number') sort = { number:1 };
        const d = await db.collection('ids').find(f).sort(sort).toArray();
        return ok(res, { data: d });
      }
      if (!r1 && M==='POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!b.number || !b.tier) return fail(res, 400, 'number dan tier wajib');
        if (await db.collection('ids').findOne({ number: String(b.number) }))
          return fail(res, 409, 'ID sudah ada');
        const doc = {
          number: String(b.number),
          tier: b.tier,
          sold: false,
          likes: 0,
          note: b.note || '',
          addedAt: new Date(),
        };
        await db.collection('ids').insertOne(doc);
        return created(res, { data: doc });
      }
      if (r1==='bulk' && M==='POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!Array.isArray(b.ids) || !b.tier) return fail(res, 400, 'ids[] dan tier wajib');
        const docs = b.ids.map(n => ({
          number: String(n).trim(),
          tier: b.tier,
          sold: false,
          likes: 0,
          note: b.note || '',
          addedAt: new Date(),
        }));
        const ex = await db.collection('ids').find({ number:{$in:docs.map(d=>d.number)} }).toArray();
        const exSet = new Set(ex.map(e=>e.number));
        const ins = docs.filter(d => !exSet.has(d.number));
        if (ins.length) await db.collection('ids').insertMany(ins);
        return created(res, { inserted:ins.length, skipped:docs.length-ins.length });
      }
      if (r1 && !r2 && M==='GET') {
        const doc = await db.collection('ids').findOne({ number: r1 });
        if (!doc) return fail(res, 404, 'ID tidak ditemukan');
        return ok(res, { data: doc });
      }
      if (r1 && !r2 && M==='PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        const upd = {};
        for (const k of ['tier','sold','note','likes']) if (b[k]!==undefined) upd[k]=b[k];
        const r = await db.collection('ids').updateOne({ number:r1 }, { $set:upd });
        if (!r.matchedCount) return fail(res, 404, 'ID tidak ditemukan');
        return ok(res, { message: 'Diupdate' });
      }
      if (r1 && !r2 && M==='DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const r = await db.collection('ids').deleteOne({ number:r1 });
        if (!r.deletedCount) return fail(res, 404, 'ID tidak ditemukan');
        return ok(res, { message: 'Dihapus' });
      }
    }

    // ── LIKE ─────────────────────────────────────────────────────────────────
    if (r0==='like') {
      if (r1==='check' && r2 && M==='GET') {
        const ip = getIP(req);
        const [banned, liked] = await Promise.all([
          db.collection('bans').findOne({ ip, active:true }),
          db.collection('likes').findOne({ ip, idNumber:r2 }),
        ]);
        return ok(res, { liked:!!liked, banned:!!banned });
      }
      if (r1 && r1!=='check' && !r2 && M==='POST') {
        const ip = getIP(req);
        const number = r1;
        if (await db.collection('bans').findOne({ ip, active:true }))
          return fail(res, 429, 'IP kamu diblokir karena spam like. Hubungi admin.');
        if (await db.collection('likes').findOne({ ip, idNumber:number }))
          return fail(res, 409, 'Kamu sudah menyukai ID ini');
        const since = new Date(Date.now() - 5*60*1000);
        const cnt = await db.collection('likes').countDocuments({ ip, likedAt:{ $gte:since } });
        if (cnt >= 10) {
          await db.collection('bans').updateOne(
            { ip },
            { $set:{ ip, bannedAt:new Date(), reason:'spam_like', active:true } },
            { upsert:true }
          );
          return fail(res, 429, 'Spam terdeteksi. IP kamu diblokir.');
        }
        if (!(await db.collection('ids').findOne({ number })))
          return fail(res, 404, 'ID tidak ditemukan');
        await db.collection('likes').insertOne({ ip, idNumber:number, likedAt:new Date() });
        const upd = await db.collection('ids').findOneAndUpdate(
          { number }, { $inc:{ likes:1 } }, { returnDocument:'after' }
        );
        return ok(res, { likes: upd.likes });
      }
    }

    // ── PROMO ─────────────────────────────────────────────────────────────────
    if (r0==='promo' && r1==='validate' && M==='POST') {
      const b = await readBody(req);
      if (!b.code) return fail(res, 400, 'Kode promo wajib');
      const p = await db.collection('promos').findOne({ code:b.code.toUpperCase().trim(), active:true });
      if (!p) return fail(res, 404, 'Kode promo tidak valid atau tidak aktif');
      if (p.expiresAt && new Date() > new Date(p.expiresAt)) return fail(res, 410, 'Kode promo kadaluarsa');
      if (p.maxUses != null && p.uses >= p.maxUses) return fail(res, 410, 'Kode promo habis');
      return ok(res, { discount:p.discount, code:p.code, description:p.description||'' });
    }
    if (r0==='promos') {
      if (!r1 && M==='GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        return ok(res, { data: await db.collection('promos').find().sort({ createdAt:-1 }).toArray() });
      }
      if (!r1 && M==='POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!b.code || b.discount==null) return fail(res, 400, 'code dan discount wajib');
        const doc = {
          code: b.code.toUpperCase().trim(),
          discount: Math.min(88, Math.max(1, Number(b.discount))),
          maxUses: b.maxUses ? Number(b.maxUses) : null,
          uses: 0,
          active: true,
          description: b.description || '',
          expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
          createdAt: new Date(),
        };
        await db.collection('promos').insertOne(doc);
        return created(res, { data: doc });
      }
      if (r1 && !r2 && M==='PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        const upd = {};
        if (b.discount!=null)   upd.discount = Math.min(88,Math.max(1,Number(b.discount)));
        if (b.active!=null)     upd.active = Boolean(b.active);
        if (b.maxUses!=null)    upd.maxUses = Number(b.maxUses);
        if (b.expiresAt!=null)  upd.expiresAt = new Date(b.expiresAt);
        if (b.description!=null) upd.description = b.description;
        let oid; try { oid=new ObjectId(r1); } catch { return fail(res,400,'ID tidak valid'); }
        await db.collection('promos').updateOne({ _id:oid }, { $set:upd });
        return ok(res, { message:'Promo diupdate' });
      }
      if (r1 && !r2 && M==='DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        let oid; try { oid=new ObjectId(r1); } catch { return fail(res,400,'ID tidak valid'); }
        await db.collection('promos').deleteOne({ _id:oid });
        return ok(res, { message:'Promo dihapus' });
      }
    }

    // ── SETTINGS ─────────────────────────────────────────────────────────────
    if (r0==='settings') {
      if (!r1 && M==='GET') {
        const rows = await db.collection('settings').find().toArray();
        const map = {};
        rows.forEach(s => { map[s.key] = s.value; });
        return ok(res, { data: map });
      }
      if (r1 && M==='PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (b.value === undefined) return fail(res, 400, 'value wajib');
        await db.collection('settings').updateOne(
          { key: r1 },
          { $set: { value: b.value } },
          { upsert: true }
        );
        return ok(res, { message: `Setting '${r1}' disimpan` });
      }
    }

    // ── NOTIFICATIONS ────────────────────────────────────────────────────────
    if (r0 === 'notifications') {
      if (!r1 && M === 'GET') {
        const notifs = await db.collection('notifications')
          .find({ active: true })
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();
        return ok(res, { data: notifs });
      }
      if (!r1 && M === 'POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!b.title || !b.message) return fail(res, 400, 'title dan message wajib');
        const doc = {
          title: b.title,
          message: b.message,
          type: b.type || 'info',
          active: b.active !== false,
          readBy: [],
          createdAt: new Date()
        };
        await db.collection('notifications').insertOne(doc);
        return created(res, { data: doc });
      }
      if (r1 === 'broadcast' && M === 'POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!b.title || !b.message) return fail(res, 400, 'title dan message wajib');
        const notification = {
          title: b.title,
          message: b.message,
          type: b.type || 'info',
          active: true,
          readBy: [],
          createdAt: new Date()
        };
        await db.collection('notifications').insertOne(notification);
        return ok(res, { message: 'Broadcast terkirim ke semua user', data: notification });
      }
      if (r1 === 'read' && M === 'PUT') {
        return ok(res, { message: 'Notifikasi ditandai dibaca' });
      }
      if (r1 && M === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        let oid;
        try { oid = new ObjectId(r1); } catch { return fail(res, 400, 'ID tidak valid'); }
        await db.collection('notifications').deleteOne({ _id: oid });
        return ok(res, { message: 'Notifikasi dihapus' });
      }
    }

    // ── REPORTS ──────────────────────────────────────────────────────────────
    if (r0 === 'reports') {
      if (!r1 && M === 'POST') {
        const ip = getIP(req);
        const b = await readBody(req);
        if (!b.name || !b.message) return fail(res, 400, 'name dan message wajib');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existing = await db.collection('reports').countDocuments({ ip, createdAt: { $gte: today } });
        if (existing >= 1) return fail(res, 429, 'Hanya bisa kirim 1 pesan per hari');
        const doc = {
          name: b.name.substring(0, 50),
          message: b.message.substring(0, 500),
          ip: ip,
          read: false,
          replied: false,
          reply: null,
          repliedAt: null,
          createdAt: new Date()
        };
        await db.collection('reports').insertOne(doc);
        return created(res, { message: 'Pesan terkirim' });
      }
      if (r1 === 'reply-check' && M === 'GET') {
        const q = qs(req.url);
        const name = q.name;
        if (!name) return fail(res, 400, 'name required');
        const reply = await db.collection('reports').findOne(
          { name: name, replied: true },
          { sort: { repliedAt: -1 } }
        );
        if (reply && reply.reply) {
          return ok(res, { hasReply: true, replyText: reply.reply, repliedAt: reply.repliedAt });
        }
        return ok(res, { hasReply: false });
      }
      if (!r1 && M === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const reports = await db.collection('reports')
          .find()
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray();
        return ok(res, { data: reports });
      }
      if (r1 && r2 === 'reply' && M === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const b = await readBody(req);
        if (!b.reply) return fail(res, 400, 'reply wajib');
        let oid;
        try { oid = new ObjectId(r1); } catch { return fail(res, 400, 'ID tidak valid'); }
        await db.collection('reports').updateOne(
          { _id: oid },
          { $set: { reply: b.reply, replied: true, repliedAt: new Date(), read: true } }
        );
        return ok(res, { message: 'Balasan terkirim' });
      }
      if (r1 && M === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        let oid;
        try { oid = new ObjectId(r1); } catch { return fail(res, 400, 'ID tidak valid'); }
        await db.collection('reports').deleteOne({ _id: oid });
        return ok(res, { message: 'Laporan dihapus' });
      }
    }

    // ── WISHLIST (by IP) ─────────────────────────────────────────────────────
    if (r0 === 'wishlist') {
      const clientIp = getIP(req);
      
      if (!r1 && M === 'GET') {
        const wishlist = await db.collection('wishlist').findOne({ ip: clientIp });
        return ok(res, { data: wishlist?.ids || [] });
      }
      
      if (r1 && M === 'POST') {
        const idNumber = r1;
        await db.collection('wishlist').updateOne(
          { ip: clientIp },
          { $addToSet: { ids: idNumber }, $setOnInsert: { ip: clientIp, createdAt: new Date() } },
          { upsert: true }
        );
        return ok(res, { message: 'Ditambahkan ke wishlist', id: idNumber });
      }
      
      if (r1 && M === 'DELETE') {
        const idNumber = r1;
        await db.collection('wishlist').updateOne(
          { ip: clientIp },
          { $pull: { ids: idNumber } }
        );
        return ok(res, { message: 'Dihapus dari wishlist', id: idNumber });
      }
      
      if (r1 === 'check' && r2 && M === 'GET') {
        const idNumber = r2;
        const wishlist = await db.collection('wishlist').findOne({ ip: clientIp, ids: idNumber });
        return ok(res, { wished: !!wishlist });
      }
    }

    // ── PAYMENT ──────────────────────────────────────────────────────────────
    if (r0 === 'payment' && !r1 && M === 'POST') {
      const b = await readBody(req);
      const { idNumber, method, buyer, phone, promoCode } = b;
      if (!idNumber || !method || !buyer || !phone) {
        return fail(res, 400, 'idNumber, method, buyer, nomor WhatsApp wajib diisi');
      }
      const idDoc = await db.collection('ids').findOne({ number: String(idNumber) });
      if (!idDoc) return fail(res, 404, 'ID tidak ditemukan');
      if (idDoc.sold) return fail(res, 409, 'ID sudah terjual');
      const settings = await db.collection('settings').find().toArray();
      const settingsMap = {};
      settings.forEach(s => { settingsMap[s.key] = s.value; });
      const prices = settingsMap.prices || {};
      const fees = settingsMap.adminFee || {};
      const base = prices[idDoc.tier] || 0;
      let disc = 0, promoUsed = null;
      if (promoCode) {
        const pr = await db.collection('promos').findOne({ code: promoCode.toUpperCase().trim(), active: true });
        if (pr && (pr.maxUses == null || pr.uses < pr.maxUses) && (!pr.expiresAt || new Date() < new Date(pr.expiresAt))) {
          disc = pr.discount;
          promoUsed = pr.code;
          await db.collection('promos').updateOne({ code: pr.code }, { $inc: { uses: 1 } });
        }
      }
      const methodKey = method.toLowerCase();
      const adminFee = fees[methodKey] || 0;
      const finalPrice = Math.round(base * (1 - disc / 100)) + adminFee;
      const payment = {
        idNumber: String(idNumber),
        tier: idDoc.tier,
        price: base,
        method: method,
        buyer: buyer,
        phone: phone,
        promoCode: promoUsed,
        discount: disc,
        adminFee: adminFee,
        finalPrice: finalPrice,
        status: 'pending',
        createdAt: new Date()
      };
      const ins = await db.collection('payments').insertOne(payment);
      return created(res, { data: { ...payment, _id: ins.insertedId } });
    }

    if (r0 === 'payments') {
      if (!r1 && M === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const payments = await db.collection('payments')
          .find()
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
        return ok(res, { data: payments });
      }
      if (r1 && r2 === 'confirm' && M === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        let oid;
        try { oid = new ObjectId(r1); } catch { return fail(res, 400, 'ID tidak valid'); }
        const payment = await db.collection('payments').findOne({ _id: oid });
        if (!payment) return fail(res, 404, 'Pembayaran tidak ditemukan');
        if (payment.status === 'confirmed') return fail(res, 409, 'Sudah dikonfirmasi');
        await db.collection('payments').updateOne(
          { _id: oid },
          { $set: { status: 'confirmed', confirmedAt: new Date() } }
        );
        await db.collection('ids').updateOne(
          { number: payment.idNumber },
          { $set: { sold: true, soldAt: new Date() } }
        );
        await db.collection('notifications').insertOne({
          title: 'Pembayaran Dikonfirmasi',
          message: `Pembelian ID ${payment.idNumber} telah dikonfirmasi. Terima kasih ${payment.buyer}!`,
          type: 'success',
          active: true,
          readBy: [],
          createdAt: new Date()
        });
        return ok(res, { message: 'Pembayaran dikonfirmasi, ID ditandai terjual' });
      }
    }

    // ── BANS ─────────────────────────────────────────────────────────────────
    if (r0 === 'bans') {
      if (!r1 && M === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const bans = await db.collection('bans').find({ active: true }).sort({ bannedAt: -1 }).toArray();
        return ok(res, { data: bans });
      }
      if (r1 && M === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const ip = decodeURIComponent(r1);
        await db.collection('bans').updateOne(
          { ip },
          { $set: { active: false, unbannedAt: new Date() } }
        );
        return ok(res, { message: `IP ${ip} di-unban` });
      }
    }

    // ── RESET DATABASE ───────────────────────────────────────────────────────
    if (r0 === 'reset' && r1 === 'database' && M === 'DELETE') {
      if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
      try {
        const collectionsToReset = ['ids', 'payments', 'likes', 'notifications', 'reports', 'bans', 'promos', 'wishlist'];
        const results = {};
        for (const colName of collectionsToReset) {
          const col = db.collection(colName);
          const count = await col.countDocuments();
          const result = await col.deleteMany({});
          results[colName] = { deleted: result.deletedCount, total: count };
        }
        console.log('[RESET] Database reset by admin:', results);
        return ok(res, { 
          message: 'Database berhasil direset',
          details: results,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('[RESET ERROR]', err);
        return fail(res, 500, 'Gagal reset database: ' + err.message);
      }
    }

    return fail(res, 404, `Route tidak ditemukan: ${M} /api/${[r0, r1, r2].filter(Boolean).join('/')}`);

  } catch (err) {
    console.error('[Error]', req.method, req.url, err.message);
    cachedClient = null;
    cachedDb = null;
    return fail(res, 500, 'Server error: ' + err.message);
  }
};
