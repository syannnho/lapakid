// api/index.js — lapakID Backend v2.3.0
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI    = process.env.MONGODB_URI   || 'mongodb+srv://n4taza_db:N44E8WEKlOJLZIHQ@cluster0.pdfnlfb.mongodb.net/?appName=Cluster0';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN   || 'lapakid_admin_secret_2026';
const DB_NAME      = 'lapakid';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO  = 'syannnho/nataza';
const GITHUB_BRANCH= 'main';

let cachedClient = null, cachedDb = null;

async function getDB() {
  if (cachedDb && cachedClient && cachedClient.topology?.isConnected?.()) return cachedDb;
  if (cachedClient) { try { await cachedClient.close(); } catch(_){} cachedClient=null; cachedDb=null; }
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize:10, serverSelectionTimeoutMS:8000,
    connectTimeoutMS:8000, socketTimeoutMS:30000,
    retryWrites:true, retryReads:true,
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
function ok(res,data)       { res.status(200).json({success:true,...data}); }
function created(res,data)  { res.status(201).json({success:true,...data}); }
function fail(res,code,msg) { res.status(code).json({success:false,message:msg}); }

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
function isAdmin(req) { return req.headers['x-admin-token'] === ADMIN_TOKEN; }

function readBody(req) {
  return new Promise(resolve => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function qs(url) {
  try { const i = url.indexOf('?'); return i===-1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i+1))); }
  catch { return {}; }
}

function parts(url) {
  const path = url.split('?')[0].replace(/^\/api\/?/, '');
  return path.split('/').filter(Boolean);
}

async function ensureSettings(db) {
  const col = db.collection('settings');
  if (!(await col.findOne({key:'prices'}))) {
    await col.insertMany([
      {key:'prices',   value:{low:125000, medium:450000, high:850000, legend:1350000}},
      {key:'adminFee', value:{qris:0, google:5000, file:0}},
      {key:'siteInfo', value:{name:'lapakID'}},
      {key:'music',    value:[]},
      {key:'banners',  value:[
        {url:'https://files.catbox.moe/kv3k51.png'},
        {url:'https://files.catbox.moe/l28ii6.png'},
        {url:'https://files.catbox.moe/5bm0fq.png'},
      ]},
      {key:'popup', value:{active:false, title:'🎉 Promo Spesial!', desc:'Gunakan kode promo saat checkout.', code:'LAPAK10', imageUrl:''}},
    ]);
  }
  for (const item of [
    {key:'music',   value:[]},
    {key:'banners', value:[{url:'https://files.catbox.moe/kv3k51.png'}]},
    {key:'popup',   value:{active:false, title:'🎉 Promo!', desc:'Diskon spesial.', code:'LAPAK10', imageUrl:''}},
  ]) {
    if (!(await col.findOne({key:item.key}))) await col.insertOne(item);
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function githubGetFile(filePath) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN belum diset di env Vercel');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, {headers:{'Authorization':`Bearer ${GITHUB_TOKEN}`,'Accept':'application/vnd.github.v3+json','User-Agent':'lapakID'}});
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.message||`GitHub ${r.status}`); }
  const data = await r.json();
  return {content:Buffer.from(data.content,'base64').toString('utf-8'), sha:data.sha, path:data.path};
}

async function githubPutFile(filePath, content, sha, message) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN belum diset di env Vercel');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const body = {message:message||`Update ${filePath} via lapakID dashboard`, content:Buffer.from(content,'utf-8').toString('base64'), branch:GITHUB_BRANCH};
  if (sha) body.sha = sha;
  const r = await fetch(url, {method:'PUT', headers:{'Authorization':`Bearer ${GITHUB_TOKEN}`,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json','User-Agent':'lapakID'}, body:JSON.stringify(body)});
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.message||`GitHub ${r.status}`); }
  return await r.json();
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawPath = req.url.split('?')[0];

  if (rawPath === '/' || rawPath === '') {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(200).end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/index.html"/><script>location.replace('/index.html')</script></head><body></body></html>`);
  }

  const [r0,r1,r2] = parts(req.url);
  const M = req.method.toUpperCase();

  // ── GitHub file editor (no DB needed) ────────────────────────────────────
  if (r0 === 'github' && r1 === 'file') {
    if (!isAdmin(req)) return fail(res,401,'Unauthorized');
    const ALLOWED = ['index.html','dashboard.html','payment.html','docs.html','about.html'];
    if (M === 'GET') {
      const fp = qs(req.url).path || '';
      if (!ALLOWED.includes(fp)) return fail(res,400,'File tidak diizinkan');
      try { return ok(res, await githubGetFile(fp)); }
      catch(e) { return fail(res,500,e.message); }
    }
    if (M === 'PUT') {
      const b = await readBody(req);
      const {path:fp, content:fc, sha, message} = b;
      if (!fp || !fc) return fail(res,400,'path dan content wajib');
      if (!ALLOWED.includes(fp)) return fail(res,400,'File tidak diizinkan');
      try { const result = await githubPutFile(fp,fc,sha,message); return ok(res,{message:`${fp} berhasil di-push`,commit:result.commit?.sha}); }
      catch(e) { return fail(res,500,e.message); }
    }
    return fail(res,405,'Method tidak diizinkan');
  }

  // ── Connect DB ───────────────────────────────────────────────────────────
  let db;
  try { db = await getDB(); await ensureSettings(db); }
  catch(err) { console.error('[MongoDB]',err.message); return fail(res,503,'Database error: '+err.message); }

  try {

    // ── admin/login ────────────────────────────────────────────────────────
    if (r0==='admin' && r1==='login' && M==='POST') {
      const b = await readBody(req);
      if (b.token===ADMIN_TOKEN) return ok(res,{token:ADMIN_TOKEN});
      return fail(res,401,'Token admin salah');
    }

    // ── ids ────────────────────────────────────────────────────────────────
    if (r0 === 'ids') {
      if (r1==='popular' && M==='GET') {
        const d = await db.collection('ids').find({sold:{$ne:true},likes:{$gt:0}}).sort({likes:-1}).limit(12).toArray();
        return ok(res,{data:d});
      }
      if (r1==='stats' && M==='GET') {
        const col = db.collection('ids');
        const [tot,sold,byT,likeT] = await Promise.all([
          col.countDocuments(), col.countDocuments({sold:true}),
          col.aggregate([{$group:{_id:'$tier',count:{$sum:1},sold:{$sum:{$cond:[{$eq:['$sold',true]},1,0]}},likes:{$sum:'$likes'}}}]).toArray(),
          col.aggregate([{$group:{_id:null,t:{$sum:'$likes'}}}]).toArray(),
        ]);
        const byTier = {};
        byT.forEach(t => { byTier[t._id]={count:t.count,sold:t.sold,likes:t.likes}; });
        return ok(res,{data:{total:tot,sold,available:tot-sold,totalLikes:likeT[0]?.t||0,byTier}});
      }
      if (!r1 && M==='GET') {
        const q=qs(req.url), f={};
        if (q.tier && q.tier!=='all') f.tier=q.tier;
        if (q.sold==='true') f.sold=true; else if (q.sold==='false') f.sold={$ne:true};
        if (q.search) f.number={$regex:q.search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'};
        let sort={addedAt:-1};
        if (q.sort==='likes') sort={likes:-1};
        if (q.sort==='number') sort={number:1};
        return ok(res,{data:await db.collection('ids').find(f).sort(sort).toArray()});
      }
      if (!r1 && M==='POST') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (!b.number||!b.tier) return fail(res,400,'number dan tier wajib');
        if (await db.collection('ids').findOne({number:String(b.number)})) return fail(res,409,'ID sudah ada');
        const doc = {number:String(b.number),tier:b.tier,sold:false,likes:0,note:b.note||'',price:b.price||null,addedAt:new Date()};
        await db.collection('ids').insertOne(doc);
        return created(res,{data:doc});
      }
      if (r1==='bulk' && M==='POST') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (!Array.isArray(b.ids)||!b.tier) return fail(res,400,'ids[] dan tier wajib');
        const docs = b.ids.map(n=>({number:String(n).trim(),tier:b.tier,sold:false,likes:0,note:b.note||'',price:null,addedAt:new Date()}));
        const ex = await db.collection('ids').find({number:{$in:docs.map(d=>d.number)}}).toArray();
        const exSet = new Set(ex.map(e=>e.number));
        const ins = docs.filter(d=>!exSet.has(d.number));
        if (ins.length) await db.collection('ids').insertMany(ins);
        return created(res,{inserted:ins.length,skipped:docs.length-ins.length});
      }
      if (r1 && !r2 && M==='GET') {
        const doc = await db.collection('ids').findOne({number:r1});
        if (!doc) return fail(res,404,'ID tidak ditemukan');
        return ok(res,{data:doc});
      }
      if (r1 && !r2 && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        const upd = {};
        for (const k of ['tier','sold','note','likes','price']) if (b[k]!==undefined) upd[k]=b[k];
        const r = await db.collection('ids').updateOne({number:r1},{$set:upd});
        if (!r.matchedCount) return fail(res,404,'ID tidak ditemukan');
        return ok(res,{message:'Diupdate'});
      }
      if (r1 && !r2 && M==='DELETE') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const r = await db.collection('ids').deleteOne({number:r1});
        if (!r.deletedCount) return fail(res,404,'ID tidak ditemukan');
        return ok(res,{message:'Dihapus'});
      }
    }

    // ── like ──────────────────────────────────────────────────────────────
    if (r0 === 'like') {
      if (r1==='check' && r2 && M==='GET') {
        const ip = getIP(req);
        const [banned,liked] = await Promise.all([
          db.collection('bans').findOne({ip,active:true}),
          db.collection('likes').findOne({ip,idNumber:r2}),
        ]);
        return ok(res,{liked:!!liked,banned:!!banned});
      }
      if (r1 && r1!=='check' && !r2 && M==='POST') {
        const ip=getIP(req), number=r1;
        if (await db.collection('bans').findOne({ip,active:true})) return fail(res,429,'IP kamu diblokir.');
        if (await db.collection('likes').findOne({ip,idNumber:number})) return fail(res,409,'Sudah menyukai ID ini');
        const since = new Date(Date.now()-5*60*1000);
        const cnt = await db.collection('likes').countDocuments({ip,likedAt:{$gte:since}});
        if (cnt>=10) {
          await db.collection('bans').updateOne({ip},{$set:{ip,bannedAt:new Date(),reason:'spam_like',active:true}},{upsert:true});
          return fail(res,429,'Spam terdeteksi. IP diblokir.');
        }
        if (!(await db.collection('ids').findOne({number}))) return fail(res,404,'ID tidak ditemukan');
        await db.collection('likes').insertOne({ip,idNumber:number,likedAt:new Date()});
        const upd = await db.collection('ids').findOneAndUpdate({number},{$inc:{likes:1}},{returnDocument:'after'});
        return ok(res,{likes:upd.likes});
      }
    }

    // ── wishlist ──────────────────────────────────────────────────────────
    if (r0 === 'wishlist') {

      // GET /api/wishlist/counts — jumlah total wishlist per ID (publik)
      if (r1 === 'counts' && !r2 && M === 'GET') {
        const agg = await db.collection('wishlists').aggregate([
          { $group: { _id: '$idNumber', count: { $sum: 1 } } }
        ]).toArray();
        const data = {};
        agg.forEach(a => { data[a._id] = a.count; });
        return ok(res, { data });
      }

      // GET /api/wishlist — ambil wishlist milik IP ini
      if (!r1 && M === 'GET') {
        const ip = getIP(req);
        const rows = await db.collection('wishlists').find({ ip }).toArray();
        return ok(res, { data: rows.map(r => r.idNumber) });
      }

      // POST /api/wishlist/:number — tambah ke wishlist
      if (r1 && !r2 && M === 'POST') {
        const ip = getIP(req);
        const number = r1;
        // Cek ID ada
        if (!(await db.collection('ids').findOne({ number }))) return fail(res, 404, 'ID tidak ditemukan');
        // Cek sudah ada di wishlist
        const exists = await db.collection('wishlists').findOne({ ip, idNumber: number });
        if (exists) return fail(res, 409, 'Sudah ada di wishlist');
        // Batas max 50 wishlist per IP
        const total = await db.collection('wishlists').countDocuments({ ip });
        if (total >= 50) return fail(res, 429, 'Maksimal 50 item dalam wishlist');
        await db.collection('wishlists').insertOne({ ip, idNumber: number, addedAt: new Date() });
        const count = await db.collection('wishlists').countDocuments({ idNumber: number });
        return created(res, { message: 'Ditambahkan ke wishlist', count });
      }

      // DELETE /api/wishlist/:number — hapus dari wishlist
      if (r1 && !r2 && M === 'DELETE') {
        const ip = getIP(req);
        const number = r1;
        const result = await db.collection('wishlists').deleteOne({ ip, idNumber: number });
        if (!result.deletedCount) return fail(res, 404, 'Tidak ada di wishlist');
        const count = await db.collection('wishlists').countDocuments({ idNumber: number });
        return ok(res, { message: 'Dihapus dari wishlist', count });
      }

      // GET /api/wishlist/admin — admin lihat semua wishlist (rangking)
      if (r1 === 'admin' && !r2 && M === 'GET') {
        if (!isAdmin(req)) return fail(res, 401, 'Unauthorized');
        const agg = await db.collection('wishlists').aggregate([
          { $group: { _id: '$idNumber', count: { $sum: 1 }, lastAdded: { $max: '$addedAt' } } },
          { $sort: { count: -1 } },
          { $limit: 100 },
        ]).toArray();
        return ok(res, { data: agg.map(a => ({ idNumber: a._id, count: a.count, lastAdded: a.lastAdded })) });
      }
    }

    // ── notifications ─────────────────────────────────────────────────────
    if (r0 === 'notifications') {
      if (!r1 && M==='GET') {
        const limit = parseInt(qs(req.url).limit)||20;
        const notifs = await db.collection('notifications').find({type:{$in:['confirmed','info']}}).sort({createdAt:-1}).limit(limit).toArray();
        const unread = await db.collection('notifications').countDocuments({type:{$in:['confirmed','info']},read:false});
        return ok(res,{data:notifs,unread});
      }
      if (r1==='read' && M==='PUT') {
        await db.collection('notifications').updateMany({type:{$in:['confirmed','info']},read:false},{$set:{read:true}});
        return ok(res,{message:'Semua notifikasi ditandai dibaca'});
      }
      if (r1==='broadcast' && M==='POST') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (!b.message) return fail(res,400,'message wajib');
        await db.collection('notifications').insertOne({type:'info',title:b.title||'Info dari Admin',message:b.message,read:false,createdAt:new Date()});
        return ok(res,{message:'Broadcast terkirim'});
      }
    }

    // ── promo ─────────────────────────────────────────────────────────────
    if (r0==='promo' && r1==='validate' && M==='POST') {
      const b = await readBody(req);
      if (!b.code) return fail(res,400,'Kode promo wajib');
      const p = await db.collection('promos').findOne({code:b.code.toUpperCase().trim(),active:true});
      if (!p) return fail(res,404,'Kode promo tidak valid atau tidak aktif');
      if (p.expiresAt && new Date()>new Date(p.expiresAt)) return fail(res,410,'Kode promo kadaluarsa');
      if (p.maxUses!=null && p.uses>=p.maxUses) return fail(res,410,'Kode promo habis');
      return ok(res,{discount:p.discount,code:p.code,description:p.description||''});
    }

    if (r0 === 'promos') {
      if (!r1 && M==='GET') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        return ok(res,{data:await db.collection('promos').find().sort({createdAt:-1}).toArray()});
      }
      if (!r1 && M==='POST') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (!b.code||b.discount==null) return fail(res,400,'code dan discount wajib');
        const doc = {code:b.code.toUpperCase().trim(),discount:Math.min(88,Math.max(1,Number(b.discount))),maxUses:b.maxUses?Number(b.maxUses):null,uses:0,active:true,description:b.description||'',expiresAt:b.expiresAt?new Date(b.expiresAt):null,createdAt:new Date()};
        await db.collection('promos').insertOne(doc);
        return created(res,{data:doc});
      }
      if (r1 && !r2 && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req); const upd = {};
        if (b.discount!=null) upd.discount=Math.min(88,Math.max(1,Number(b.discount)));
        if (b.active!=null) upd.active=Boolean(b.active);
        if (b.maxUses!=null) upd.maxUses=Number(b.maxUses);
        if (b.expiresAt!=null) upd.expiresAt=new Date(b.expiresAt);
        if (b.description!=null) upd.description=b.description;
        let oid; try{oid=new ObjectId(r1);}catch{return fail(res,400,'ID tidak valid');}
        await db.collection('promos').updateOne({_id:oid},{$set:upd});
        return ok(res,{message:'Promo diupdate'});
      }
      if (r1 && !r2 && M==='DELETE') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        let oid; try{oid=new ObjectId(r1);}catch{return fail(res,400,'ID tidak valid');}
        await db.collection('promos').deleteOne({_id:oid});
        return ok(res,{message:'Promo dihapus'});
      }
    }

    // ── settings ──────────────────────────────────────────────────────────
    if (r0 === 'settings') {
      if (!r1 && M==='GET') {
        const rows = await db.collection('settings').find().toArray();
        const map = {};
        rows.forEach(s=>{map[s.key]=s.value;});
        return ok(res,{data:map});
      }
      if (r1 && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (b.value===undefined) return fail(res,400,'value wajib');
        await db.collection('settings').updateOne({key:r1},{$set:{value:b.value}},{upsert:true});
        return ok(res,{message:`Setting '${r1}' disimpan`});
      }
    }

    // ── payment ───────────────────────────────────────────────────────────
    if (r0==='payment' && !r1 && M==='POST') {
      const b = await readBody(req);
      const {idNumber,method:pMethod,buyer,phone,promoCode} = b;
      if (!idNumber||!pMethod||!buyer||!phone) return fail(res,400,'idNumber, method, buyer, phone wajib');
      const idDoc = await db.collection('ids').findOne({number:String(idNumber)});
      if (!idDoc) return fail(res,404,'ID tidak ditemukan');
      if (idDoc.sold) return fail(res,409,'ID sudah terjual');
      const rows = await db.collection('settings').find({key:{$in:['prices','adminFee']}}).toArray();
      const prices = rows.find(s=>s.key==='prices')?.value||{};
      const fees   = rows.find(s=>s.key==='adminFee')?.value||{};
      const base = (idDoc.price!=null) ? idDoc.price : (prices[idDoc.tier]||0);
      let disc=0, promoUsed=null;
      if (promoCode) {
        const pr = await db.collection('promos').findOne({code:promoCode.toUpperCase().trim(),active:true});
        if (pr&&(pr.maxUses==null||pr.uses<pr.maxUses)&&(!pr.expiresAt||new Date()<new Date(pr.expiresAt))) {
          disc=pr.discount; promoUsed=pr.code;
          await db.collection('promos').updateOne({code:pr.code},{$inc:{uses:1}});
        }
      }
      const adminFee   = fees[pMethod]||0;
      const finalPrice = Math.round(base*(1-disc/100))+adminFee;
      const ip = getIP(req);
      const payment = {idNumber:String(idNumber),tier:idDoc.tier,price:base,method:pMethod,status:'pending',buyer,phone,promoCode:promoUsed,discount:disc,adminFee,finalPrice,ip,createdAt:new Date()};
      const ins = await db.collection('payments').insertOne(payment);
      return created(res,{data:{...payment,_id:ins.insertedId}});
    }

    if (r0 === 'payments') {
      if (!r1 && M==='GET') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        return ok(res,{data:await db.collection('payments').find().sort({createdAt:-1}).limit(200).toArray()});
      }
      if (r1 && r2==='confirm' && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        let oid; try{oid=new ObjectId(r1);}catch{return fail(res,400,'ID tidak valid');}
        const p = await db.collection('payments').findOne({_id:oid});
        if (!p) return fail(res,404,'Pembayaran tidak ditemukan');
        await db.collection('payments').updateOne({_id:oid},{$set:{status:'confirmed',confirmedAt:new Date()}});
        await db.collection('ids').updateOne({number:p.idNumber},{$set:{sold:true,soldAt:new Date()}});
        const priceStr = (p.finalPrice||0).toLocaleString('id-ID');
        await db.collection('notifications').insertOne({
          type:'confirmed', title:'Pembelian Berhasil',
          message:`${p.buyer} baru saja membeli ID ${p.idNumber} dengan harga Rp ${priceStr}`,
          idNumber:p.idNumber, buyer:p.buyer, phone:p.phone||'',
          finalPrice:p.finalPrice, tier:p.tier, read:false, createdAt:new Date(),
        });
        return ok(res,{message:'Pembayaran dikonfirmasi'});
      }
    }

    // ── reports (live chat) ───────────────────────────────────────────────
    if (r0 === 'reports') {
      if (!r1 && M==='POST') {
        const ip = getIP(req);
        const b  = await readBody(req);
        if (!b.name||!b.message) return fail(res,400,'name dan message wajib');
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const existing = await db.collection('reports').findOne({ip,createdAt:{$gte:startOfDay}});
        if (existing) return fail(res,429,'Kamu sudah mengirim pesan hari ini. Coba lagi besok.');
        const doc = {name:b.name.trim(),message:b.message.trim(),ip,status:'unread',reply:null,repliedAt:null,createdAt:new Date()};
        await db.collection('reports').insertOne(doc);
        return created(res,{message:'Pesan berhasil dikirim'});
      }
      if (r1==='reply-check' && M==='GET') {
        const name = qs(req.url).name||'';
        if (!name) return fail(res,400,'name wajib');
        const report = await db.collection('reports').findOne(
          {name:name.trim(),status:'replied'},
          {sort:{repliedAt:-1}}
        );
        if (!report) return ok(res,{reply:null});
        return ok(res,{reply:String(report._id),replyText:report.reply});
      }
      if (!r1 && M==='GET') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const reports = await db.collection('reports').find().sort({createdAt:-1}).limit(100).toArray();
        const unread  = await db.collection('reports').countDocuments({status:'unread'});
        return ok(res,{data:reports,unread});
      }
      if (r1 && r2==='reply' && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const b = await readBody(req);
        if (!b.reply) return fail(res,400,'reply wajib');
        let oid; try{oid=new ObjectId(r1);}catch{return fail(res,400,'ID tidak valid');}
        await db.collection('reports').updateOne({_id:oid},{$set:{reply:b.reply,status:'replied',repliedAt:new Date()}});
        return ok(res,{message:'Balasan tersimpan'});
      }
      if (r1 && r2==='read' && M==='PUT') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        let oid; try{oid=new ObjectId(r1);}catch{return fail(res,400,'ID tidak valid');}
        await db.collection('reports').updateOne({_id:oid},{$set:{status:'read'}});
        return ok(res,{message:'Ditandai dibaca'});
      }
    }

    // ── bans ──────────────────────────────────────────────────────────────
    if (r0 === 'bans') {
      if (!r1 && M==='GET') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        return ok(res,{data:await db.collection('bans').find({active:true}).sort({bannedAt:-1}).toArray()});
      }
      if (r1 && M==='DELETE') {
        if (!isAdmin(req)) return fail(res,401,'Unauthorized');
        const ip = decodeURIComponent(r1);
        await db.collection('bans').updateOne({ip},{$set:{active:false,unbannedAt:new Date()}});
        return ok(res,{message:`IP ${ip} di-unban`});
      }
    }

    // ── reset database ────────────────────────────────────────────────────
    if (r0==='reset' && r1==='database' && M==='DELETE') {
      if (!isAdmin(req)) return fail(res,401,'Unauthorized');
      const b = await readBody(req);
      if (b.confirm!=='RESET_CONFIRMED') return fail(res,400,'Konfirmasi tidak valid');
      await Promise.all([
        db.collection('ids').deleteMany({}),
        db.collection('payments').deleteMany({}),
        db.collection('likes').deleteMany({}),
        db.collection('wishlists').deleteMany({}),
        db.collection('notifications').deleteMany({}),
        db.collection('reports').deleteMany({}),
        db.collection('bans').deleteMany({}),
        db.collection('promos').deleteMany({}),
      ]);
      return ok(res,{message:'Database berhasil direset. Musik, banner, dan popup tidak dihapus.'});
    }

    // ── catch-all ─────────────────────────────────────────────────────────
    return fail(res,404,`Route tidak ditemukan: ${M} /api/${[r0,r1,r2].filter(Boolean).join('/')}`);

  } catch(err) {
    console.error('[Error]',req.method,req.url,err.message);
    cachedClient=null; cachedDb=null;
    return fail(res,500,'Server error: '+err.message);
  }
};
