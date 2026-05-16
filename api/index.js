// api/index.js — lapakID Backend
// Fixed: Route structure dan koneksi MongoDB

const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://n4taza_db:N44E8WEKlOJLZIHQ@cluster0.pdfnlfb.mongodb.net/?appName=Cluster0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'lapakid_admin_secret_2026';
const DB_NAME = 'lapakid';

// ── MongoDB connection pool ───────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-token');
}

function ok(res, data) { 
  res.status(200).json({ success: true, ...data }); 
}

function created(res, data) { 
  res.status(201).json({ success: true, ...data }); 
}

function fail(res, code, msg) { 
  res.status(code).json({ success: false, message: msg }); 
}

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
    req.on('end', () => { 
      try { 
        resolve(raw ? JSON.parse(raw) : {}); 
      } catch { 
        resolve({}); 
      } 
    });
    req.on('error', () => resolve({}));
  });
}

function parsePath(url) {
  // Remove /api prefix and split
  const withoutPrefix = url.replace(/^\/api/, '');
  const pathParts = withoutPrefix.split('?')[0].split('/').filter(Boolean);
  return pathParts;
}

async function ensureSettings(db) {
  const col = db.collection('settings');
  if (!(await col.findOne({ key: 'prices' }))) {
    await col.insertMany([
      { key: 'prices', value: { low: 125000, medium: 450000, high: 850000, legend: 1350000 } },
      { key: 'adminFee', value: { google: 5000, file: 0, qris: 0 } },
      { key: 'siteInfo', value: { name: 'lapakID' } },
    ]);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let db;
  try {
    db = await getDB();
    await ensureSettings(db);
  } catch (err) {
    console.error('[MongoDB]', err.message);
    return fail(res, 503, 'Database tidak dapat terhubung: ' + err.message);
  }

  const pathParts = parsePath(req.url);
  const method = req.method.toUpperCase();

  try {
    // ── admin/login ──────────────────────────────────────────────────────────
    if (pathParts[0] === 'admin' && pathParts[1] === 'login' && method === 'POST') {
      const body = await readBody(req);
      if (body.token === ADMIN_TOKEN) {
        return ok(res, { token: ADMIN_TOKEN });
      }
      return fail(res, 401, 'Token admin salah');
    }

    // ── ids routes ───────────────────────────────────────────────────────────
    if (pathParts[0] === 'ids') {
      // GET /api/ids/stats
      if (pathParts[1] === 'stats' && method === 'GET') {
        const col = db.collection('ids');
        const [total, sold, likeAgg] = await Promise.all([
          col.countDocuments(),
          col.countDocuments({ sold: true }),
          col.aggregate([{ $group: { _id: null, total: { $sum: '$likes' } } }]).toArray()
        ]);
        
        return ok(res, { 
          data: { 
            total: total, 
            available: total - sold, 
            sold: sold, 
            totalLikes: likeAgg[0]?.total || 0 
          } 
        });
      }

      // GET /api/ids (list all IDs)
      if (!pathParts[1] && method === 'GET') {
        const ids = await db.collection('ids').find().sort({ addedAt: -1 }).toArray();
        return ok(res, { data: ids });
      }

      // POST /api/ids (add single ID)
      if (!pathParts[1] && method === 'POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const body = await readBody(req);
        if (!body.number || !body.tier) {
          return fail(res, 400, 'number dan tier wajib diisi');
        }
        
        const existing = await db.collection('ids').findOne({ number: String(body.number) });
        if (existing) {
          return fail(res, 409, 'ID sudah ada');
        }
        
        const newId = {
          number: String(body.number),
          tier: body.tier,
          sold: false,
          likes: 0,
          note: body.note || '',
          addedAt: new Date()
        };
        
        await db.collection('ids').insertOne(newId);
        return created(res, { data: newId });
      }

      // POST /api/ids/bulk
      if (pathParts[1] === 'bulk' && method === 'POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const body = await readBody(req);
        if (!Array.isArray(body.ids) || !body.tier) {
          return fail(res, 400, 'ids array dan tier wajib diisi');
        }
        
        const docs = body.ids.map(num => ({
          number: String(num).trim(),
          tier: body.tier,
          sold: false,
          likes: 0,
          note: body.note || '',
          addedAt: new Date()
        }));
        
        const existing = await db.collection('ids').find({ 
          number: { $in: docs.map(d => d.number) } 
        }).toArray();
        
        const existingNumbers = new Set(existing.map(e => e.number));
        const toInsert = docs.filter(d => !existingNumbers.has(d.number));
        
        let inserted = 0;
        if (toInsert.length) {
          const result = await db.collection('ids').insertMany(toInsert);
          inserted = result.insertedCount;
        }
        
        return created(res, { 
          inserted: inserted, 
          skipped: docs.length - inserted 
        });
      }

      // PUT /api/ids/:number
      if (pathParts[1] && method === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const number = pathParts[1];
        const body = await readBody(req);
        const update = {};
        
        if (body.sold !== undefined) update.sold = body.sold;
        if (body.tier !== undefined) update.tier = body.tier;
        if (body.note !== undefined) update.note = body.note;
        if (body.likes !== undefined) update.likes = body.likes;
        
        const result = await db.collection('ids').updateOne(
          { number: number },
          { $set: update }
        );
        
        if (result.matchedCount === 0) {
          return fail(res, 404, 'ID tidak ditemukan');
        }
        
        return ok(res, { message: 'ID berhasil diupdate' });
      }

      // DELETE /api/ids/:number
      if (pathParts[1] && method === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const number = pathParts[1];
        const result = await db.collection('ids').deleteOne({ number: number });
        
        if (result.deletedCount === 0) {
          return fail(res, 404, 'ID tidak ditemukan');
        }
        
        return ok(res, { message: 'ID berhasil dihapus' });
      }
    }

    // ── payments routes ───────────────────────────────────────────────────────
    if (pathParts[0] === 'payments') {
      // GET /api/payments
      if (!pathParts[1] && method === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const payments = await db.collection('payments')
          .find()
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
        
        return ok(res, { data: payments });
      }
    }

    // ── payment (single) routes ───────────────────────────────────────────────
    if (pathParts[0] === 'payment') {
      // POST /api/payment
      if (!pathParts[1] && method === 'POST') {
        const body = await readBody(req);
        const { idNumber, method: payMethod, buyer, email, promoCode } = body;
        
        if (!idNumber || !payMethod || !buyer || !email) {
          return fail(res, 400, 'idNumber, method, buyer, email wajib diisi');
        }
        
        const idDoc = await db.collection('ids').findOne({ number: String(idNumber) });
        if (!idDoc) {
          return fail(res, 404, 'ID tidak ditemukan');
        }
        
        if (idDoc.sold) {
          return fail(res, 409, 'ID sudah terjual');
        }
        
        // Get prices and fees
        const settings = await db.collection('settings').find().toArray();
        const prices = settings.find(s => s.key === 'prices')?.value || {};
        const fees = settings.find(s => s.key === 'adminFee')?.value || {};
        
        const basePrice = prices[idDoc.tier] || 0;
        let discount = 0;
        let promoUsed = null;
        
        if (promoCode) {
          const promo = await db.collection('promos').findOne({ 
            code: promoCode.toUpperCase().trim(), 
            active: true 
          });
          
          if (promo && (!promo.expiresAt || new Date() < new Date(promo.expiresAt))) {
            if (!promo.maxUses || promo.uses < promo.maxUses) {
              discount = promo.discount;
              promoUsed = promo.code;
              await db.collection('promos').updateOne(
                { code: promo.code },
                { $inc: { uses: 1 } }
              );
            }
          }
        }
        
        const adminFee = fees[payMethod] || 0;
        const finalPrice = Math.round(basePrice * (1 - discount / 100)) + adminFee;
        
        const payment = {
          idNumber: String(idNumber),
          tier: idDoc.tier,
          price: basePrice,
          method: payMethod,
          status: 'pending',
          buyer: buyer,
          email: email,
          promoCode: promoUsed,
          discount: discount,
          adminFee: adminFee,
          finalPrice: finalPrice,
          createdAt: new Date()
        };
        
        const result = await db.collection('payments').insertOne(payment);
        
        return created(res, { 
          data: { ...payment, _id: result.insertedId } 
        });
      }
      
      // PUT /api/payment/:id/confirm
      if (pathParts[2] === 'confirm' && method === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        let paymentId;
        try {
          paymentId = new ObjectId(pathParts[1]);
        } catch {
          return fail(res, 400, 'ID pembayaran tidak valid');
        }
        
        const payment = await db.collection('payments').findOne({ _id: paymentId });
        if (!payment) {
          return fail(res, 404, 'Pembayaran tidak ditemukan');
        }
        
        await db.collection('payments').updateOne(
          { _id: paymentId },
          { $set: { status: 'confirmed', confirmedAt: new Date() } }
        );
        
        await db.collection('ids').updateOne(
          { number: payment.idNumber },
          { $set: { sold: true, soldAt: new Date() } }
        );
        
        return ok(res, { message: 'Pembayaran berhasil dikonfirmasi' });
      }
    }

    // ── promos routes ─────────────────────────────────────────────────────────
    if (pathParts[0] === 'promos') {
      // GET /api/promos
      if (!pathParts[1] && method === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const promos = await db.collection('promos')
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        
        return ok(res, { data: promos });
      }
      
      // POST /api/promos
      if (!pathParts[1] && method === 'POST') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const body = await readBody(req);
        if (!body.code || body.discount === undefined) {
          return fail(res, 400, 'code dan discount wajib diisi');
        }
        
        const promo = {
          code: body.code.toUpperCase().trim(),
          discount: Math.min(88, Math.max(1, Number(body.discount))),
          maxUses: body.maxUses ? Number(body.maxUses) : null,
          uses: 0,
          active: true,
          description: body.description || '',
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          createdAt: new Date()
        };
        
        await db.collection('promos').insertOne(promo);
        return created(res, { data: promo });
      }
      
      // PUT /api/promos/:id
      if (pathParts[1] && method === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        let promoId;
        try {
          promoId = new ObjectId(pathParts[1]);
        } catch {
          return fail(res, 400, 'ID promo tidak valid');
        }
        
        const body = await readBody(req);
        const update = {};
        
        if (body.active !== undefined) update.active = body.active;
        if (body.discount !== undefined) update.discount = Math.min(88, Math.max(1, Number(body.discount)));
        if (body.maxUses !== undefined) update.maxUses = body.maxUses ? Number(body.maxUses) : null;
        if (body.expiresAt !== undefined) update.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        if (body.description !== undefined) update.description = body.description;
        
        await db.collection('promos').updateOne(
          { _id: promoId },
          { $set: update }
        );
        
        return ok(res, { message: 'Promo berhasil diupdate' });
      }
      
      // DELETE /api/promos/:id
      if (pathParts[1] && method === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        let promoId;
        try {
          promoId = new ObjectId(pathParts[1]);
        } catch {
          return fail(res, 400, 'ID promo tidak valid');
        }
        
        await db.collection('promos').deleteOne({ _id: promoId });
        return ok(res, { message: 'Promo berhasil dihapus' });
      }
    }
    
    // ── promo validation (public) ─────────────────────────────────────────────
    if (pathParts[0] === 'promo' && pathParts[1] === 'validate' && method === 'POST') {
      const body = await readBody(req);
      if (!body.code) {
        return fail(res, 400, 'Kode promo wajib diisi');
      }
      
      const promo = await db.collection('promos').findOne({ 
        code: body.code.toUpperCase().trim(), 
        active: true 
      });
      
      if (!promo) {
        return fail(res, 404, 'Kode promo tidak valid');
      }
      
      if (promo.expiresAt && new Date() > new Date(promo.expiresAt)) {
        return fail(res, 410, 'Kode promo sudah kadaluarsa');
      }
      
      if (promo.maxUses !== null && promo.uses >= promo.maxUses) {
        return fail(res, 410, 'Kode promo sudah mencapai batas penggunaan');
      }
      
      return ok(res, { 
        discount: promo.discount, 
        code: promo.code, 
        description: promo.description || '' 
      });
    }

    // ── settings routes ───────────────────────────────────────────────────────
    if (pathParts[0] === 'settings') {
      // GET /api/settings
      if (!pathParts[1] && method === 'GET') {
        const settings = await db.collection('settings').find().toArray();
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.key] = s.value; });
        return ok(res, { data: settingsMap });
      }
      
      // PUT /api/settings/prices
      if (pathParts[1] === 'prices' && method === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const body = await readBody(req);
        if (!body.value) {
          return fail(res, 400, 'value wajib diisi');
        }
        
        await db.collection('settings').updateOne(
          { key: 'prices' },
          { $set: { value: body.value } },
          { upsert: true }
        );
        
        return ok(res, { message: 'Harga berhasil disimpan' });
      }
      
      // PUT /api/settings/adminFee
      if (pathParts[1] === 'adminFee' && method === 'PUT') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const body = await readBody(req);
        if (!body.value) {
          return fail(res, 400, 'value wajib diisi');
        }
        
        await db.collection('settings').updateOne(
          { key: 'adminFee' },
          { $set: { value: body.value } },
          { upsert: true }
        );
        
        return ok(res, { message: 'Biaya admin berhasil disimpan' });
      }
    }

    // ── bans routes ───────────────────────────────────────────────────────────
    if (pathParts[0] === 'bans') {
      // GET /api/bans
      if (!pathParts[1] && method === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const bans = await db.collection('bans')
          .find({ active: true })
          .sort({ bannedAt: -1 })
          .toArray();
        
        return ok(res, { data: bans });
      }
      
      // DELETE /api/bans/:ip
      if (pathParts[1] && method === 'DELETE') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        
        const ip = decodeURIComponent(pathParts[1]);
        await db.collection('bans').updateOne(
          { ip: ip },
          { $set: { active: false, unbannedAt: new Date() } }
        );
        
        return ok(res, { message: `IP ${ip} berhasil di-unban` });
      }
    }

    // ── likes routes ──────────────────────────────────────────────────────────
    if (pathParts[0] === 'like') {
      // GET /api/like/check/:idNumber
      if (pathParts[1] === 'check' && pathParts[2] && method === 'GET') {
        const ip = getIP(req);
        const idNumber = pathParts[2];
        
        const [banned, liked] = await Promise.all([
          db.collection('bans').findOne({ ip: ip, active: true }),
          db.collection('likes').findOne({ ip: ip, idNumber: idNumber })
        ]);
        
        return ok(res, { 
          liked: !!liked, 
          banned: !!banned 
        });
      }
      
      // POST /api/like/:idNumber
      if (pathParts[1] && pathParts[1] !== 'check' && method === 'POST') {
        const ip = getIP(req);
        const idNumber = pathParts[1];
        
        // Check if IP is banned
        const banned = await db.collection('bans').findOne({ ip: ip, active: true });
        if (banned) {
          return fail(res, 429, 'IP kamu diblokir karena spam like');
        }
        
        // Check if already liked
        const existingLike = await db.collection('likes').findOne({ ip: ip, idNumber: idNumber });
        if (existingLike) {
          return fail(res, 409, 'Kamu sudah menyukai ID ini');
        }
        
        // Check for spam (10 likes in 5 minutes)
        const since = new Date(Date.now() - 5 * 60 * 1000);
        const recentLikes = await db.collection('likes').countDocuments({ 
          ip: ip, 
          likedAt: { $gte: since } 
        });
        
        if (recentLikes >= 10) {
          await db.collection('bans').updateOne(
            { ip: ip },
            { 
              $set: { 
                ip: ip, 
                bannedAt: new Date(), 
                reason: 'spam_like', 
                active: true 
              } 
            },
            { upsert: true }
          );
          return fail(res, 429, 'Spam terdeteksi. IP kamu diblokir');
        }
        
        // Check if ID exists
        const idDoc = await db.collection('ids').findOne({ number: idNumber });
        if (!idDoc) {
          return fail(res, 404, 'ID tidak ditemukan');
        }
        
        // Add like
        await db.collection('likes').insertOne({
          ip: ip,
          idNumber: idNumber,
          likedAt: new Date()
        });
        
        // Increment likes count
        const result = await db.collection('ids').findOneAndUpdate(
          { number: idNumber },
          { $inc: { likes: 1 } },
          { returnDocument: 'after' }
        );
        
        return ok(res, { likes: result.likes });
      }
    }

    // Route not found
    return fail(res, 404, `Route tidak ditemukan: ${method} /api/${pathParts.join('/')}`);

  } catch (err) {
    console.error('[Error]', req.method, req.url, err.message);
    console.error(err.stack);
    cachedClient = null;
    cachedDb = null;
    return fail(res, 500, 'Server error: ' + err.message);
  }
};
