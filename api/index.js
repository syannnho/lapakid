// api/index.js - Fixed delete, confirm payment, dan delete promo
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://n4taza_db:N44E8WEKlOJLZIHQ@cluster0.pdfnlfb.mongodb.net/?appName=Cluster0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'lapakid_admin_secret_2026';
const DB_NAME = 'lapakid';

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb && cachedClient && cachedClient.topology?.isConnected?.()) {
    return cachedDb;
  }
  
  if (cachedClient) {
    try { await cachedClient.close(); } catch (e) {}
    cachedClient = null;
    cachedDb = null;
  }
  
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  
  await client.connect();
  cachedClient = client;
  cachedDb = client.db(DB_NAME);
  
  await initCollections(cachedDb);
  return cachedDb;
}

async function initCollections(db) {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);
  
  if (!collectionNames.includes('settings')) {
    await db.collection('settings').insertMany([
      { key: 'prices', value: { low: 125000, medium: 450000, high: 850000, legend: 1350000 } },
      { key: 'adminFee', value: { google: 5000, file: 0, qris: 0 } }
    ]);
  }
  
  if (!collectionNames.includes('ids')) {
    await db.collection('ids').createIndex({ number: 1 }, { unique: true });
  }
  
  if (!collectionNames.includes('promos')) {
    await db.collection('promos').createIndex({ code: 1 }, { unique: true });
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } 
      catch (e) { resolve({}); }
    });
  });
}

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const db = await connectToDatabase();
    const url = req.url.replace('/api', '');
    const path = url.split('?')[0];
    const parts = path.split('/').filter(Boolean);
    const method = req.method;
    
    // Parse body for POST/PUT requests
    let body = {};
    if (method === 'POST' || method === 'PUT') {
      body = await parseBody(req);
    }
    
    console.log(`${method} /api/${parts.join('/')}`);
    
    // ============ ADMIN LOGIN ============
    if (parts[0] === 'admin' && parts[1] === 'login' && method === 'POST') {
      if (body.token === ADMIN_TOKEN) {
        return sendJSON(res, 200, { success: true, token: ADMIN_TOKEN });
      }
      return sendJSON(res, 401, { success: false, message: 'Token admin salah' });
    }
    
    // Check admin auth untuk semua route yang memerlukan
    const isAdminRoute = ['ids', 'payments', 'promos', 'settings', 'bans'].includes(parts[0]);
    if (isAdminRoute && method !== 'GET') {
      const token = req.headers['x-admin-token'];
      if (token !== ADMIN_TOKEN) {
        return sendJSON(res, 401, { success: false, message: 'Unauthorized' });
      }
    }
    
    // ============ IDS ROUTES ============
    if (parts[0] === 'ids') {
      const idsCollection = db.collection('ids');
      
      // GET /api/ids/stats
      if (parts[1] === 'stats' && method === 'GET') {
        const total = await idsCollection.countDocuments();
        const sold = await idsCollection.countDocuments({ sold: true });
        const likesAgg = await idsCollection.aggregate([
          { $group: { _id: null, total: { $sum: '$likes' } } }
        ]).toArray();
        
        return sendJSON(res, 200, {
          success: true,
          data: {
            total,
            available: total - sold,
            sold,
            totalLikes: likesAgg[0]?.total || 0
          }
        });
      }
      
      // GET /api/ids
      if (!parts[1] && method === 'GET') {
        const ids = await idsCollection.find({}).sort({ addedAt: -1 }).toArray();
        return sendJSON(res, 200, { success: true, data: ids });
      }
      
      // POST /api/ids
      if (!parts[1] && method === 'POST') {
        if (!body.number || !body.tier) {
          return sendJSON(res, 400, { success: false, message: 'Number dan tier wajib diisi' });
        }
        
        const existing = await idsCollection.findOne({ number: body.number });
        if (existing) {
          return sendJSON(res, 409, { success: false, message: 'ID sudah ada' });
        }
        
        const newId = {
          number: String(body.number),
          tier: body.tier,
          sold: false,
          likes: 0,
          note: body.note || '',
          addedAt: new Date()
        };
        
        await idsCollection.insertOne(newId);
        return sendJSON(res, 201, { success: true, data: newId });
      }
      
      // POST /api/ids/bulk
      if (parts[1] === 'bulk' && method === 'POST') {
        if (!Array.isArray(body.ids) || !body.tier) {
          return sendJSON(res, 400, { success: false, message: 'ids array dan tier wajib diisi' });
        }
        
        let inserted = 0;
        let skipped = 0;
        
        for (const num of body.ids) {
          const existing = await idsCollection.findOne({ number: String(num).trim() });
          if (!existing) {
            await idsCollection.insertOne({
              number: String(num).trim(),
              tier: body.tier,
              sold: false,
              likes: 0,
              note: body.note || '',
              addedAt: new Date()
            });
            inserted++;
          } else {
            skipped++;
          }
        }
        
        return sendJSON(res, 201, { success: true, inserted, skipped });
      }
      
      // PUT /api/ids/:number
      if (parts[1] && method === 'PUT') {
        const number = parts[1];
        const update = {};
        if (body.sold !== undefined) update.sold = body.sold;
        if (body.tier !== undefined) update.tier = body.tier;
        if (body.note !== undefined) update.note = body.note;
        if (body.likes !== undefined) update.likes = body.likes;
        
        const result = await idsCollection.updateOne(
          { number: number },
          { $set: update }
        );
        
        if (result.matchedCount === 0) {
          return sendJSON(res, 404, { success: false, message: 'ID tidak ditemukan' });
        }
        
        return sendJSON(res, 200, { success: true, message: 'ID berhasil diupdate' });
      }
      
      // DELETE /api/ids/:number - FIXED
      if (parts[1] && method === 'DELETE') {
        const number = decodeURIComponent(parts[1]);
        console.log('Deleting ID:', number);
        
        const result = await idsCollection.deleteOne({ number: number });
        
        if (result.deletedCount === 0) {
          return sendJSON(res, 404, { success: false, message: 'ID tidak ditemukan' });
        }
        
        // Also delete related likes
        await db.collection('likes').deleteMany({ idNumber: number });
        
        return sendJSON(res, 200, { success: true, message: 'ID berhasil dihapus' });
      }
    }
    
    // ============ PAYMENTS ROUTES ============
    if (parts[0] === 'payments' && method === 'GET') {
      const payments = await db.collection('payments')
        .find({})
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      
      return sendJSON(res, 200, { success: true, data: payments });
    }
    
    // ============ PAYMENT CONFIRM - FIXED ============
    if (parts[0] === 'payment' && parts[2] === 'confirm' && method === 'PUT') {
      const paymentId = parts[1];
      console.log('Confirming payment:', paymentId);
      
      let oid;
      try {
        oid = new ObjectId(paymentId);
      } catch (e) {
        return sendJSON(res, 400, { success: false, message: 'ID pembayaran tidak valid: ' + paymentId });
      }
      
      const payment = await db.collection('payments').findOne({ _id: oid });
      if (!payment) {
        return sendJSON(res, 404, { success: false, message: 'Pembayaran tidak ditemukan' });
      }
      
      if (payment.status === 'confirmed') {
        return sendJSON(res, 400, { success: false, message: 'Pembayaran sudah dikonfirmasi' });
      }
      
      // Update payment status
      await db.collection('payments').updateOne(
        { _id: oid },
        { $set: { status: 'confirmed', confirmedAt: new Date() } }
      );
      
      // Mark ID as sold
      await db.collection('ids').updateOne(
        { number: payment.idNumber },
        { $set: { sold: true, soldAt: new Date() } }
      );
      
      return sendJSON(res, 200, { success: true, message: 'Pembayaran berhasil dikonfirmasi' });
    }
    
    // ============ PROMOS ROUTES ============
    if (parts[0] === 'promos') {
      const promosCollection = db.collection('promos');
      
      // GET /api/promos
      if (!parts[1] && method === 'GET') {
        const promos = await promosCollection.find({}).sort({ createdAt: -1 }).toArray();
        return sendJSON(res, 200, { success: true, data: promos });
      }
      
      // POST /api/promos
      if (!parts[1] && method === 'POST') {
        if (!body.code || body.discount === undefined) {
          return sendJSON(res, 400, { success: false, message: 'Code dan discount wajib diisi' });
        }
        
        const newPromo = {
          code: body.code.toUpperCase().trim(),
          discount: Math.min(88, Math.max(1, Number(body.discount))),
          maxUses: body.maxUses ? Number(body.maxUses) : null,
          uses: 0,
          active: true,
          description: body.description || '',
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          createdAt: new Date()
        };
        
        await promosCollection.insertOne(newPromo);
        return sendJSON(res, 201, { success: true, data: newPromo });
      }
      
      // PUT /api/promos/:id - FIXED (untuk toggle aktif/nonaktif)
      if (parts[1] && method === 'PUT') {
        const promoId = parts[1];
        console.log('Updating promo:', promoId);
        
        let oid;
        try {
          oid = new ObjectId(promoId);
        } catch (e) {
          return sendJSON(res, 400, { success: false, message: 'ID promo tidak valid: ' + promoId });
        }
        
        const update = {};
        if (body.active !== undefined) update.active = body.active;
        if (body.discount !== undefined) update.discount = Number(body.discount);
        if (body.maxUses !== undefined) update.maxUses = body.maxUses ? Number(body.maxUses) : null;
        if (body.description !== undefined) update.description = body.description;
        
        const result = await promosCollection.updateOne(
          { _id: oid },
          { $set: update }
        );
        
        if (result.matchedCount === 0) {
          return sendJSON(res, 404, { success: false, message: 'Promo tidak ditemukan' });
        }
        
        return sendJSON(res, 200, { success: true, message: 'Promo berhasil diupdate' });
      }
      
      // DELETE /api/promos/:id - FIXED
      if (parts[1] && method === 'DELETE') {
        const promoId = parts[1];
        console.log('Deleting promo:', promoId);
        
        let oid;
        try {
          oid = new ObjectId(promoId);
        } catch (e) {
          return sendJSON(res, 400, { success: false, message: 'ID promo tidak valid: ' + promoId });
        }
        
        const result = await promosCollection.deleteOne({ _id: oid });
        
        if (result.deletedCount === 0) {
          return sendJSON(res, 404, { success: false, message: 'Promo tidak ditemukan' });
        }
        
        return sendJSON(res, 200, { success: true, message: 'Promo berhasil dihapus' });
      }
    }
    
    // ============ PROMO VALIDATION (public) ============
    if (parts[0] === 'promo' && parts[1] === 'validate' && method === 'POST') {
      if (!body.code) {
        return sendJSON(res, 400, { success: false, message: 'Kode promo wajib diisi' });
      }
      
      const promo = await db.collection('promos').findOne({ 
        code: body.code.toUpperCase().trim(), 
        active: true 
      });
      
      if (!promo) {
        return sendJSON(res, 404, { success: false, message: 'Kode promo tidak valid' });
      }
      
      if (promo.expiresAt && new Date() > new Date(promo.expiresAt)) {
        return sendJSON(res, 410, { success: false, message: 'Kode promo sudah kadaluarsa' });
      }
      
      if (promo.maxUses !== null && promo.uses >= promo.maxUses) {
        return sendJSON(res, 410, { success: false, message: 'Kode promo sudah mencapai batas penggunaan' });
      }
      
      return sendJSON(res, 200, { 
        success: true, 
        discount: promo.discount, 
        code: promo.code, 
        description: promo.description || '' 
      });
    }
    
    // ============ SETTINGS ROUTES ============
    if (parts[0] === 'settings') {
      // GET /api/settings
      if (!parts[1] && method === 'GET') {
        const settings = await db.collection('settings').find({}).toArray();
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.key] = s.value; });
        return sendJSON(res, 200, { success: true, data: settingsMap });
      }
      
      // PUT /api/settings/prices
      if (parts[1] === 'prices' && method === 'PUT') {
        await db.collection('settings').updateOne(
          { key: 'prices' },
          { $set: { value: body.value } },
          { upsert: true }
        );
        return sendJSON(res, 200, { success: true, message: 'Harga berhasil disimpan' });
      }
      
      // PUT /api/settings/adminFee
      if (parts[1] === 'adminFee' && method === 'PUT') {
        await db.collection('settings').updateOne(
          { key: 'adminFee' },
          { $set: { value: body.value } },
          { upsert: true }
        );
        return sendJSON(res, 200, { success: true, message: 'Biaya admin berhasil disimpan' });
      }
    }
    
    // ============ BANS ROUTES ============
    if (parts[0] === 'bans') {
      // GET /api/bans
      if (!parts[1] && method === 'GET') {
        const bans = await db.collection('bans')
          .find({ active: true })
          .sort({ bannedAt: -1 })
          .toArray();
        return sendJSON(res, 200, { success: true, data: bans });
      }
      
      // DELETE /api/bans/:ip
      if (parts[1] && method === 'DELETE') {
        const ip = decodeURIComponent(parts[1]);
        await db.collection('bans').updateOne(
          { ip: ip },
          { $set: { active: false, unbannedAt: new Date() } }
        );
        return sendJSON(res, 200, { success: true, message: `IP ${ip} berhasil di-unban` });
      }
    }
    
    // ============ LIKE ROUTES ============
    if (parts[0] === 'like') {
      // GET /api/like/check/:idNumber
      if (parts[1] === 'check' && parts[2] && method === 'GET') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const idNumber = parts[2];
        
        const [banned, liked] = await Promise.all([
          db.collection('bans').findOne({ ip: ip, active: true }),
          db.collection('likes').findOne({ ip: ip, idNumber: idNumber })
        ]);
        
        return sendJSON(res, 200, { success: true, liked: !!liked, banned: !!banned });
      }
      
      // POST /api/like/:idNumber
      if (parts[1] && parts[1] !== 'check' && method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const idNumber = parts[1];
        
        const banned = await db.collection('bans').findOne({ ip: ip, active: true });
        if (banned) {
          return sendJSON(res, 429, { success: false, message: 'IP kamu diblokir karena spam like' });
        }
        
        const existingLike = await db.collection('likes').findOne({ ip: ip, idNumber: idNumber });
        if (existingLike) {
          return sendJSON(res, 409, { success: false, message: 'Kamu sudah menyukai ID ini' });
        }
        
        const since = new Date(Date.now() - 5 * 60 * 1000);
        const recentLikes = await db.collection('likes').countDocuments({ ip: ip, likedAt: { $gte: since } });
        
        if (recentLikes >= 10) {
          await db.collection('bans').updateOne(
            { ip: ip },
            { $set: { ip: ip, bannedAt: new Date(), reason: 'spam_like', active: true } },
            { upsert: true }
          );
          return sendJSON(res, 429, { success: false, message: 'Spam terdeteksi. IP kamu diblokir' });
        }
        
        const idDoc = await db.collection('ids').findOne({ number: idNumber });
        if (!idDoc) {
          return sendJSON(res, 404, { success: false, message: 'ID tidak ditemukan' });
        }
        
        await db.collection('likes').insertOne({ ip: ip, idNumber: idNumber, likedAt: new Date() });
        
        const result = await db.collection('ids').findOneAndUpdate(
          { number: idNumber },
          { $inc: { likes: 1 } },
          { returnDocument: 'after' }
        );
        
        return sendJSON(res, 200, { success: true, likes: result.likes });
      }
    }
    
    // ============ CREATE PAYMENT (public) ============
    if (parts[0] === 'payment' && !parts[1] && method === 'POST') {
      const { idNumber, method: payMethod, buyer, email, promoCode } = body;
      
      if (!idNumber || !payMethod || !buyer || !email) {
        return sendJSON(res, 400, { success: false, message: 'idNumber, method, buyer, email wajib diisi' });
      }
      
      const idDoc = await db.collection('ids').findOne({ number: String(idNumber) });
      if (!idDoc) {
        return sendJSON(res, 404, { success: false, message: 'ID tidak ditemukan' });
      }
      
      if (idDoc.sold) {
        return sendJSON(res, 409, { success: false, message: 'ID sudah terjual' });
      }
      
      const settings = await db.collection('settings').find({}).toArray();
      const prices = settings.find(s => s.key === 'prices')?.value || {};
      const fees = settings.find(s => s.key === 'adminFee')?.value || {};
      
      const basePrice = prices[idDoc.tier] || 0;
      let discount = 0;
      let promoUsed = null;
      
      if (promoCode) {
        const promo = await db.collection('promos').findOne({ code: promoCode.toUpperCase().trim(), active: true });
        if (promo && (!promo.expiresAt || new Date() < new Date(promo.expiresAt))) {
          if (!promo.maxUses || promo.uses < promo.maxUses) {
            discount = promo.discount;
            promoUsed = promo.code;
            await db.collection('promos').updateOne({ code: promo.code }, { $inc: { uses: 1 } });
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
      return sendJSON(res, 201, { success: true, data: { ...payment, _id: result.insertedId } });
    }
    
    // Route not found
    return sendJSON(res, 404, { success: false, message: `Route tidak ditemukan: ${method} /api/${parts.join('/')}` });
    
  } catch (error) {
    console.error('API Error:', error);
    return sendJSON(res, 500, { success: false, message: error.message });
  }
};
