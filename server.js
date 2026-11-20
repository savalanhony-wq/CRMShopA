// Asalac CRM local server (v3): static files, login/users/permissions, data.json storage,
// receipts folder, activity log, daily backups, and SMS relay to Android phones.
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process'),os=require('os'),zlib=require('zlib');
const PORT=+process.env.PORT||3000,APP=__dirname,LAN=process.env.LAN==='1',HOST=LAN?'0.0.0.0':'127.0.0.1';
const lanIPs=()=>{const r=[];for(const l of Object.values(os.networkInterfaces()))for(const a of l||[])if(a.family==='IPv4'&&!a.internal)r.push(a.address);return r.sort((x,y)=>(/^192\.168\./.test(y)-/^192\.168\./.test(x)))};
const DATA=process.env.DATA_DIR||(process.pkg?path.dirname(process.execPath):__dirname);
fs.mkdirSync(DATA,{recursive:true});
const DB=path.join(DATA,'data.json'),USERS=path.join(DATA,'users.json'),ACT=path.join(DATA,'activity.jsonl'),REC=path.join(DATA,'receipts'),STORY=path.join(DATA,'stories'),SBG=path.join(DATA,'storybg'),BK=path.join(DATA,'backups');
const FILES={'/':'index.html','/index.html':'index.html','/xlsx.full.min.js':'xlsx.full.min.js','/qrcode.js':'qrcode.js'};
const OK_PATHS=['/message','/messages','/health','/devices'];
const PERMS=['inv','ord','rep','msg','cus','pro','xl','set'];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};

/* ---------- users, sessions ---------- */
let users=[];try{users=JSON.parse(fs.readFileSync(USERS,'utf8'))}catch(e){}
const saveUsers=()=>fs.writeFileSync(USERS,JSON.stringify(users,null,1));
const hash=(p,salt)=>crypto.scryptSync(String(p),salt,64).toString('hex');
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const mkUser=o=>{const salt=crypto.randomBytes(16).toString('hex');return{id:crypto.randomBytes(6).toString('hex'),username:o.username,salt,hash:hash(o.password,salt),role:o.role==='admin'?'admin':'staff',perms:(o.perms||[]).filter(p=>PERMS.includes(p)),active:o.active!==false,created:Date.now()}};
const pub=u=>({id:u.id,username:u.username,role:u.role,perms:u.role==='admin'?PERMS:u.perms,active:u.active,created:u.created});
/* Sessions survive server restarts (sessions.json, tokens stored only as SHA-256 hashes), sliding 7-day expiry */
const SESS=path.join(DATA,'sessions.json'),fails=new Map(),TTL=7*24*3600e3,MAXAGE=TTL/1000;
const sha=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
const sessions=new Map();try{const j=JSON.parse(fs.readFileSync(SESS,'utf8'));for(const k in j)if(j[k]&&j[k].exp>Date.now())sessions.set(k,j[k])}catch(e){}
let sessTimer=null;
const saveSess=()=>{clearTimeout(sessTimer);sessTimer=setTimeout(()=>{try{fs.writeFileSync(SESS,JSON.stringify(Object.fromEntries(sessions)))}catch(e){}},400)};
const newSess=uid=>{const t=crypto.randomBytes(32).toString('hex');sessions.set(sha(t),{uid,exp:Date.now()+TTL});saveSess();return t};
const cookie=req=>{const m=(req.headers.cookie||'').match(/(?:^|;\s*)sid=([a-f0-9]+)/);if(m)return m[1];const b=/^Bearer\s+([a-f0-9]+)$/i.exec(req.headers.authorization||'');return b&&b[1]};
function who(req){const t=cookie(req),k=t&&sha(t),s=k&&sessions.get(k);if(!s)return null;if(s.exp<Date.now()){sessions.delete(k);saveSess();return null}const u=users.find(x=>x.id===s.uid&&x.active);if(!u)return null;if(s.exp-Date.now()<TTL-3600e3){s.exp=Date.now()+TTL;saveSess()}return u}
const can=(u,p)=>u&&(u.role==='admin'||u.perms.includes(p));
const validName=n=>typeof n==='string'&&n.trim().length>=3&&n.trim().length<=32&&!/\s/.test(n.trim());
const validPass=p=>typeof p==='string'&&p.length>=6&&p.length<=128;
function logAct(u,a,d){try{fs.appendFileSync(ACT,JSON.stringify({t:Date.now(),u:u?u.username:'-',a:String(a).slice(0,80),d:String(d==null?'':d).slice(0,300)})+'\n')}catch(e){}}

/* ---------- helpers ---------- */
const json=(res,code,o,h)=>{if(res.headersSent)return;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(h||{})});res.end(JSON.stringify(o))};
const readBody=(req,res,limit,cb)=>{let b='',dead=false;req.on('data',c=>{b+=c;if(b.length>limit&&!dead){dead=true;json(res,413,{error:'too large'});req.destroy()}});req.on('end',()=>{if(dead)return;let o=null;try{o=b?JSON.parse(b):{}}catch(e){return json(res,400,{error:'bad json'})}cb(o,b)})};
/* data.json safety: validate before reading/backing up, serialize writes, self-heal from newest valid backup */
const dbOk=t=>{try{const j=JSON.parse(t);return !!j&&Array.isArray(j.c)&&Array.isArray(j.p)&&Array.isArray(j.i)}catch(e){return false}};
function readDb(){let t=null;try{t=fs.readFileSync(DB,'utf8')}catch(e){if(e.code==='ENOENT')return'{}'}
 if(t&&dbOk(t))return t;
 try{const all=fs.readdirSync(BK).filter(x=>/^data-.*\.json$/.test(x)).sort().reverse();
  for(const f of all){const b=fs.readFileSync(path.join(BK,f),'utf8');if(dbOk(b)){try{fs.copyFileSync(DB,DB+'.corrupt-'+Date.now())}catch(e){}fs.writeFileSync(DB,b);logAct(null,'بازیابی خودکار data.json از پشتیبان',f);console.log('data.json was corrupted; restored from backup '+f);return b}}}catch(e){}
 return null}
let wq=Promise.resolve();const wait=ms=>new Promise(r=>setTimeout(r,ms));
function writeDb(raw){const p=wq.then(async()=>{const tmp=DB+'.tmp';await fs.promises.writeFile(tmp,typeof raw==='function'?raw():raw);for(let k=0;;k++){try{await fs.promises.rename(tmp,DB);break}catch(e){if(k>=3)throw e;await wait(100)}}});wq=p.catch(()=>{});return p}
function backup(manual){try{if(!fs.existsSync(DB)||!dbOk(fs.readFileSync(DB,'utf8')))return null;fs.mkdirSync(BK,{recursive:true});const d=new Date(),z=n=>String(n).padStart(2,'0'),day=d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate()),tag=manual?day+'-'+z(d.getHours())+z(d.getMinutes())+z(d.getSeconds()):day,f='data-'+tag+'.json';fs.copyFileSync(DB,path.join(BK,f));if(fs.existsSync(USERS))fs.copyFileSync(USERS,path.join(BK,'users-'+tag+'.json'));
 for(const pre of['data-','users-']){const all=fs.readdirSync(BK).filter(x=>x.startsWith(pre)).sort();while(all.length>40)fs.unlinkSync(path.join(BK,all.shift()))}return f}catch(e){return null}}
function openBrowser(u){try{const c=process.platform==='win32'?['cmd',['/c','start','',u]]:process.platform==='darwin'?['open',[u]]:['xdg-open',[u]];cp.spawn(c[0],c[1],{stdio:'ignore',detached:true}).unref()}catch(e){}}

/* ---------- two-way sync: record-level merge (last change wins, deletions are remembered) ---------- */
const KEYF={c:r=>r.id,p:r=>r.id,i:r=>r.no};
function mergeDb(a,b){
 a=a&&typeof a==='object'?a:{};b=b&&typeof b==='object'?b:{};
 const out={...a,...b},tomb=new Map(),cut=Date.now()-120*864e5;
 for(const t of[...(a.del||[]),...(b.del||[])])if(t&&t.t>cut){const k=t.k+':'+t.id,o=tomb.get(k);if(!o||o.t<t.t)tomb.set(k,t)}
 const mt=r=>+(r&&r._m)||0;
 for(const k of['c','p','i']){
  const A=Array.isArray(a[k])?a[k]:[],B=Array.isArray(b[k])?b[k]:[],m=new Map(),f=KEYF[k];
  for(const r of A)m.set(String(f(r)),r);
  let mx=0;for(const r of A)if(k==='i')mx=Math.max(mx,+r.no||0);
  for(const r of B){let key=String(f(r)),o=m.get(key);
   if(k==='i'&&o&&o._u&&r._u&&o._u!==r._u){ // two different invoices got the same number on two devices: renumber the incoming one
    const all=[...A,...B].reduce((q,x)=>Math.max(q,+x.no||0),0);r.no=all+1;r._m=Date.now();key=String(r.no);o=null;b.s=b.s||{};b.s.seq=Math.max(+b.s.seq||0,r.no);b.s._m=Date.now()}
   if(!o||mt(r)>mt(o))m.set(key,r)}
  out[k]=[...m.values()].filter(r=>{const t=tomb.get(k+':'+f(r));return !(t&&t.t>=mt(r))});
 }
 out.del=[...tomb.values()];
 const sa=a.s||{},sb=b.s||{};out.s=(+sb._m||0)>(+sa._m||0)?{...sa,...sb}:{...sb,...sa};
 out.s.seq=Math.max(+sa.seq||0,+sb.seq||0,...out.i.map(x=>+x.no||0));
 const L=new Map();for(const x of[...(a.sl||[]),...(b.sl||[])])L.set(x.t+'|'+x.to+'|'+(x.ph||'')+'|'+(x.sim||''),x);
 out.sl=[...L.values()].sort((x,y)=>x.t-y.t).slice(-20000);
 return out}

/* ---------- PWA: manifest, service worker and icon are generated here (no extra files) ---------- */
const crcT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc=b=>{let c=~0;for(const x of b)c=crcT[(c^x)&255]^(c>>>8);return(~c)>>>0};
function png(n){const raw=Buffer.alloc((n*4+1)*n),cx=n/2,R=n*.44;
 for(let y=0;y<n;y++){raw[y*(n*4+1)]=0;for(let x=0;x<n;x++){const o=y*(n*4+1)+1+x*4,dx=Math.abs(x-cx)/R,dy=Math.abs(y-cx)/R;
  const hex=dy<=.9&&dx*.866+dy*.5<=.866*1&&dx<=.866; // pointy-top hexagon
  const t=y/n;let r=107-20*t,g=29,b=74;if(hex){r=255;g=190-30*t;b=40;const ring=dx*.866+dy*.5>.866*.78||dx>.866*.78;if(ring){r=255;g=215;b=110}
   const w=Math.abs((x-cx)/n),h=(y-cx)/n;if(Math.abs(h)<.07&&w<.2){r=107;g=29;b=74}if(Math.abs(h-.17)<.045&&w<.14){r=107;g=29;b=74}if(Math.abs(h+.17)<.045&&w<.14){r=107;g=29;b=74}}
  raw[o]=r;raw[o+1]=g;raw[o+2]=b;raw[o+3]=255}}
 const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]),c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])};
 const h=Buffer.alloc(13);h.writeUInt32BE(n,0);h.writeUInt32BE(n,4);h[8]=8;h[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch('IHDR',h),ch('IDAT',zlib.deflateSync(raw)),ch('IEND',Buffer.alloc(0))])}
const ICONS={192:png(192),512:png(512)};
const MANIFEST=JSON.stringify({name:'Asalac CRM',short_name:'عسلک',lang:'fa',dir:'rtl',id:'./',start_url:'./',scope:'./',display:'standalone',background_color:'#fff8e6',theme_color:'#6b1d4a',icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]});
/* service worker: caches the app so it opens with NO internet and NO server (needs HTTPS or localhost; see HOWTO) */
const SW=`const C='asalac-v2',A=['./','xlsx.full.min.js','qrcode.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(A.map(x=>c.add(x).catch(()=>{})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.indexOf('/api/')>=0||/\\/(receipts|stories|storybg)\\//.test(u.pathname))return;
 e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match(new URL('./',location).href))))});`;
/* minimal ZIP writer (stored, no compression) for the portable phone package */
function zipOf(files){const parts=[],cen=[];let off=0;
 for(const[name,buf]of files){const nb=Buffer.from(name),c=crc(buf),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0800,6);h.writeUInt32LE(c,14);h.writeUInt32LE(buf.length,18);h.writeUInt32LE(buf.length,22);h.writeUInt16LE(nb.length,26);
  parts.push(h,nb,buf);const ce=Buffer.alloc(46);ce.writeUInt32LE(0x02014b50,0);ce.writeUInt16LE(20,4);ce.writeUInt16LE(20,6);ce.writeUInt16LE(0x0800,8);ce.writeUInt32LE(c,16);ce.writeUInt32LE(buf.length,20);ce.writeUInt32LE(buf.length,24);ce.writeUInt16LE(nb.length,28);ce.writeUInt32LE(off,42);cen.push(ce,nb);off+=30+nb.length+buf.length}
 const cd=Buffer.concat(cen),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(files.length,8);e.writeUInt16LE(files.length,10);e.writeUInt32LE(cd.length,12);e.writeUInt32LE(off,16);return Buffer.concat([...parts,cd,e])}
const HOWTO=`نصب اپ عسلک روی گوشی (بدون نیاز به اینترنت و کامپیوتر بعد از نصب)
=====================================================================
این پوشه یک «اپ تحت وب نصبی» (PWA) است. فقط یک‌بار باید روی یک آدرس امن (https) قرار بگیرد.

مرحله ۱ — قرار دادن روی اینترنت (یک‌بار، رایگان)
  راه ساده: سایت  app.netlify.com/drop  را باز کنید، همین پوشه (بعد از Extract کردن zip) را روی صفحه بکشید و رها کنید.
  یک آدرس مثل  https://xxxx.netlify.app  به شما می‌دهد.
  (جایگزین‌ها: GitHub Pages یا Cloudflare Pages. هر میزبانی که https بدهد و فایل‌ها را همین‌طور سرو کند.)

مرحله ۲ — نصب روی گوشی اندروید (یک‌بار، با اینترنت)
  آدرس را در Chrome گوشی باز کنید ← منوی ⋮ ← Install app (یا Add to Home screen).
  یک بار برنامه را باز کنید و حساب بسازید (نام کاربری و رمز مخصوص همین گوشی).

از این به بعد: اپ با آیکون «عسلک» بدون اینترنت و بدون وای‌فای باز می‌شود. اطلاعات فقط روی خود گوشی ذخیره می‌شود.

همگام‌سازی با برنامه کامپیوتر (بدون شبکه)
  گوشی: دکمه «به‌روزرسانی اطلاعات» ← «خروجی فایل همگام‌سازی» ← فایل را با شیر/واتساپ/تلگرام/USB به کامپیوتر بدهید.
  کامپیوتر: تنظیمات ← «ادغام فایل همگام‌سازی» ← همان فایل. سپس «خروجی فایل همگام‌سازی» بگیرید و در گوشی «ورود و ادغام فایل» بزنید.

نکته‌ها
  • این آدرس را به دیگران ندهید (هر کس آدرس را داشته باشد می‌تواند اپ خالی را باز کند؛ ولی به اطلاعات شما دسترسی ندارد، چون اطلاعات فقط روی گوشی شماست).
  • پیامک گروهی و چاپ حرارتی وقتی به کامپیوتر وصل نیستید در دسترس نیست.
  • رمز را فراموش کنید، راه بازیابی ندارد؛ از اطلاعات خروجی همگام‌سازی/پشتیبان نگه دارید.
  • با هر بار باز کردن اپ با اینترنت، نسخه جدید خودکار گرفته می‌شود.
`;
/* ---------- api ---------- */
function api(req,res,u){
 const user=who(req),ip=req.socket.remoteAddress;
 const need=(p)=>{if(!user){json(res,401,{error:'login'});return false}if(p&&!can(user,p)){json(res,403,{error:'forbidden'});return false}return true};
 const isAdmin=()=>{if(!user){json(res,401,{error:'login'});return false}if(user.role!=='admin'){json(res,403,{error:'forbidden'});return false}return true};
 if(u==='/api/me'&&req.method==='GET')return json(res,200,{setup:users.length===0,user:user?pub(user):null});
 if(u==='/api/setup'&&req.method==='POST')return readBody(req,res,1e5,o=>{
  if(users.length)return json(res,403,{error:'already set up'});
  if(!validName(o.username)||!validPass(o.password))return json(res,400,{error:'نام کاربری حداقل ۳ نویسه (بدون فاصله) و رمز حداقل ۶ نویسه باشد'});
  const nu=mkUser({username:o.username.trim(),password:o.password,role:'admin'});users.push(nu);saveUsers();
  const t=newSess(nu.id);logAct(nu,'ساخت حساب مدیر','');
  json(res,200,{user:pub(nu)},{'Set-Cookie':'sid='+t+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+MAXAGE})});
 if(u==='/api/login'&&req.method==='POST')return readBody(req,res,1e5,o=>{
  const key=ip+'|'+String(o.username||'').toLowerCase(),f=fails.get(key);
  if(f&&f.until>Date.now())return json(res,429,{error:'تلاش‌های ناموفق زیاد؛ ۶۰ ثانیه صبر کنید'});
  const x=users.find(v=>v.username.toLowerCase()===String(o.username||'').trim().toLowerCase());
  if(!x||!x.active||!same(hash(o.password||'',x.salt),x.hash)){const n=(f&&f.n||0)+1;fails.set(key,{n,until:n>=5?Date.now()+60e3:0});logAct(x||null,'ورود ناموفق',o.username);return json(res,401,{error:'نام کاربری یا رمز عبور اشتباه است'})}
  fails.delete(key);const t=newSess(x.id);logAct(x,'ورود','');
  json(res,200,{user:pub(x),sid:t},{'Set-Cookie':'sid='+t+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+MAXAGE})});
 if(u==='/api/logout'&&req.method==='POST'){const t=cookie(req);if(user)logAct(user,'خروج','');if(t){sessions.delete(sha(t));saveSess()}return json(res,200,{ok:1},{'Set-Cookie':'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
 if(u==='/api/account'&&req.method==='POST'){if(!need())return;return readBody(req,res,1e5,o=>{
  if(!same(hash(o.old||'',user.salt),user.hash))return json(res,400,{error:'رمز فعلی اشتباه است'});
  if(o.newUsername&&o.newUsername.trim()!==user.username){if(!validName(o.newUsername))return json(res,400,{error:'نام کاربری نامعتبر'});if(users.some(v=>v.id!==user.id&&v.username.toLowerCase()===o.newUsername.trim().toLowerCase()))return json(res,400,{error:'این نام کاربری قبلاً هست'});user.username=o.newUsername.trim()}
  if(o.newPassword){if(!validPass(o.newPassword))return json(res,400,{error:'رمز جدید حداقل ۶ نویسه باشد'});user.salt=crypto.randomBytes(16).toString('hex');user.hash=hash(o.newPassword,user.salt)}
  saveUsers();logAct(user,'تغییر نام کاربری/رمز','');json(res,200,{user:pub(user)})})}
 if(u==='/api/users'&&req.method==='GET'){if(!isAdmin())return;return json(res,200,{users:users.map(pub),perms:PERMS})}
 if(u==='/api/users'&&req.method==='POST'){if(!isAdmin())return;return readBody(req,res,1e5,o=>{
  const act=users.filter(v=>v.role==='admin'&&v.active);
  if(o.id){const x=users.find(v=>v.id===o.id);if(!x)return json(res,404,{error:'not found'});
   if(o.username&&o.username.trim()!==x.username){if(!validName(o.username))return json(res,400,{error:'نام کاربری نامعتبر'});if(users.some(v=>v.id!==x.id&&v.username.toLowerCase()===o.username.trim().toLowerCase()))return json(res,400,{error:'این نام کاربری قبلاً هست'});x.username=o.username.trim()}
   if(o.password){if(!validPass(o.password))return json(res,400,{error:'رمز حداقل ۶ نویسه باشد'});x.salt=crypto.randomBytes(16).toString('hex');x.hash=hash(o.password,x.salt)}
   const role=o.role==='admin'?'admin':'staff',active=o.active!==false;
   if(x.role==='admin'&&(role!=='admin'||!active)&&act.length<=1&&act[0]&&act[0].id===x.id)return json(res,400,{error:'حداقل یک مدیر فعال باید بماند'});
   x.role=role;x.active=active;x.perms=(o.perms||[]).filter(p=>PERMS.includes(p));if(!active){for(const[t,s]of sessions)if(s.uid===x.id)sessions.delete(t);saveSess()}
   saveUsers();logAct(user,'ویرایش کاربر',x.username);return json(res,200,{user:pub(x)})}
  if(!validName(o.username)||!validPass(o.password))return json(res,400,{error:'نام کاربری حداقل ۳ نویسه (بدون فاصله) و رمز حداقل ۶ نویسه باشد'});
  if(users.some(v=>v.username.toLowerCase()===o.username.trim().toLowerCase()))return json(res,400,{error:'این نام کاربری قبلاً هست'});
  const nu=mkUser({...o,username:o.username.trim()});users.push(nu);saveUsers();logAct(user,'کاربر جدید',nu.username);json(res,200,{user:pub(nu)})})}
 if(u==='/api/users/delete'&&req.method==='POST'){if(!isAdmin())return;return readBody(req,res,1e4,o=>{
  const x=users.find(v=>v.id===o.id);if(!x)return json(res,404,{error:'not found'});
  if(x.id===user.id)return json(res,400,{error:'نمی‌توانید خودتان را حذف کنید'});
  if(x.role==='admin'&&users.filter(v=>v.role==='admin'&&v.active).length<=1)return json(res,400,{error:'حداقل یک مدیر فعال باید بماند'});
  users=users.filter(v=>v.id!==x.id);for(const[t,s]of sessions)if(s.uid===x.id)sessions.delete(t);saveSess();saveUsers();logAct(user,'حذف کاربر',x.username);json(res,200,{ok:1})})}
 if(u==='/api/log'&&req.method==='GET'){if(!isAdmin())return;let L=[];try{L=fs.readFileSync(ACT,'utf8').trim().split('\n').slice(-300).map(l=>JSON.parse(l)).reverse()}catch(e){}return json(res,200,{log:L})}
 if(u==='/api/log'&&req.method==='POST'){if(!need())return;return readBody(req,res,1e4,o=>{logAct(user,o.a||'',o.d);json(res,200,{ok:1})})}
 if(u==='/api/backup'&&req.method==='POST'){if(!need('set'))return;const f=backup(true);logAct(user,'پشتیبان دستی',f||'');return json(res,200,f?{ok:1,file:f}:{ok:0})}
 if(u==='/api/pwa.zip'&&req.method==='GET'){if(!need())return;const F=[['index.html','index.html'],['xlsx.full.min.js','xlsx.full.min.js'],['qrcode.js','qrcode.js']],L=[];for(const[n,f]of F)try{L.push([n,fs.readFileSync(path.join(APP,f))])}catch(e){}
  L.push(['sw.js',Buffer.from(SW)],['manifest.webmanifest',Buffer.from(MANIFEST)],['icon-192.png',ICONS[192]],['icon-512.png',ICONS[512]],['HOWTO.txt',Buffer.from('\ufeff'+HOWTO)]);
  const z=zipOf(L);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="AsalacCRM-phone-app.zip"','Content-Length':z.length});return res.end(z)}
 if(u==='/api/lan'&&req.method==='GET'){if(!need())return;return json(res,200,{lan:LAN,port:PORT,ips:lanIPs()})}
 if(u==='/api/db'){
  if(!need())return;
  if(req.method==='GET'){const t=readDb();if(t===null)return json(res,500,{error:'data.json unreadable and no valid backup'});res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(t)}
  return readBody(req,res,60e6,(o,raw)=>{if(!o||!Array.isArray(o.c)||!Array.isArray(o.p)||!Array.isArray(o.i))return json(res,400,{error:'invalid data'});
   /* merge with what is on disk (inside the write queue), so a phone and a computer never overwrite each other's newer records; header X-Replace:1 = plain overwrite (restore backup) */
   const rep=req.headers['x-replace']==='1';
   writeDb(()=>{if(rep)return raw;let cur=null;try{cur=JSON.parse(fs.readFileSync(DB,'utf8'))}catch(e){}return cur&&Array.isArray(cur.c)?JSON.stringify(mergeDb(cur,o)):raw}).then(()=>json(res,200,{ok:1}),e=>json(res,500,{error:e.message}))})}
 if(u==='/api/receipt'&&req.method==='POST'){if(!need())return;return readBody(req,res,14e6,o=>{
  const m=/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(o.data||''));if(!m)return json(res,400,{error:'bad image'});
  const buf=Buffer.from(m[2],'base64');if(buf.length>8e6)return json(res,413,{error:'too large'});
  const d=new Date(),sub=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'),name=crypto.randomBytes(8).toString('hex')+'.'+(m[1]==='jpeg'?'jpg':m[1]);
  try{fs.mkdirSync(path.join(REC,sub),{recursive:true});fs.writeFileSync(path.join(REC,sub,name),buf)}catch(e){return json(res,500,{error:e.message})}
  json(res,200,{url:'/receipts/'+sub+'/'+name})})}
 if(u==='/api/story'&&req.method==='POST'){if(!need('inv'))return;return readBody(req,res,16e6,o=>{
  const m=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(o.data||''));if(!m)return json(res,400,{error:'PNG لازم است'});
  const buf=Buffer.from(m[1],'base64');if(buf.length>14e6)return json(res,413,{error:'too large'});
  if(buf.length<33||buf.readUInt32BE(0)!==0x89504e47||buf.readUInt32BE(4)!==0x0d0a1a0a)return json(res,400,{error:'bad png'});
  const w=buf.readUInt32BE(16),h=buf.readUInt32BE(20);if(w!==1080||h!==1920)return json(res,400,{error:'ابعاد استوری باید دقیقاً 1080×1920 باشد'});
  const no=String(o.no==null?'':o.no).replace(/[^\w\-]/g,'').slice(0,20);if(!no)return json(res,400,{error:'bad no'});
  try{fs.mkdirSync(STORY,{recursive:true});fs.writeFileSync(path.join(STORY,'story-'+no+'.png'),buf)}catch(e){return json(res,500,{error:e.message})}
  json(res,200,{url:'/stories/story-'+no+'.png'})})}
 if(u==='/api/story/delete'&&req.method==='POST'){if(!need('inv'))return;return readBody(req,res,1e4,o=>{const no=String(o.no==null?'':o.no).replace(/[^\w\-]/g,'').slice(0,20);try{fs.unlinkSync(path.join(STORY,'story-'+no+'.png'))}catch(e){}json(res,200,{ok:1})})}
 if(u==='/api/storybg'&&req.method==='POST'){if(!need('inv'))return;return readBody(req,res,16e6,o=>{
  const m=/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(o.data||''));if(!m)return json(res,400,{error:'bad image'});
  const buf=Buffer.from(m[2],'base64');if(buf.length>10e6)return json(res,413,{error:'too large'});
  const name='bg-'+crypto.randomBytes(8).toString('hex')+'.'+(m[1]==='png'?'png':m[1]==='webp'?'webp':'jpg');
  try{fs.mkdirSync(SBG,{recursive:true});fs.writeFileSync(path.join(SBG,name),buf)}catch(e){return json(res,500,{error:e.message})}
  json(res,200,{url:'/storybg/'+name})})}
 if(u==='/api/storybg/delete'&&req.method==='POST'){if(!need('inv'))return;return readBody(req,res,1e4,o=>{const m=/^\/storybg\/(bg-[a-f0-9]+\.(?:png|jpg|webp))$/.exec(String(o.url||''));if(m)try{fs.unlinkSync(path.join(SBG,m[1]))}catch(e){}json(res,200,{ok:1})})}
 if(u==='/api/gw'&&req.method==='POST'){if(!need('msg'))return;return readBody(req,res,1e6,q=>{
  if(!OK_PATHS.includes(q.path))return json(res,400,{error:'path not allowed'});
  let target;
  try{
   if(q.mode==='cloud')target=new URL('https://api.sms-gate.app/3rdparty/v1'+q.path);
   else{const host=String(q.gw||'').replace(/^https?:\/\//,'').replace(/\/+$/,'');
    if(!/^[\w.\-]+(:\d+)?$/.test(host))return json(res,400,{error:'BAD_ADDRESS'});
    target=new URL('http://'+host+q.path)}
  }catch(e){return json(res,400,{error:'BAD_ADDRESS'})}
  const data=q.body?JSON.stringify(q.body):null,lib=target.protocol==='https:'?https:http;
  const headers={Authorization:'Basic '+Buffer.from((q.user||'')+':'+(q.pass||'')).toString('base64')};
  if(data){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(data)}
  const r=lib.request(target,{method:q.method||'GET',headers,timeout:8000},resp=>{let d='';resp.on('data',c=>d+=c);
   resp.on('end',()=>{console.log(new Date().toLocaleTimeString(),q.method,q.path,'->',resp.statusCode);json(res,200,{status:resp.statusCode,body:d})})});
  r.on('timeout',()=>r.destroy(new Error('TIMEOUT')));
  r.on('error',e=>{console.log(new Date().toLocaleTimeString(),q.path,'ERR',e.code||e.message);json(res,200,{error:e.code||e.message})});
  if(data)r.write(data);r.end()})}
 return json(res,404,{error:'not found'});
}

const server=http.createServer((req,res)=>{
 let u;try{u=decodeURIComponent(req.url.split('?')[0])}catch(e){res.writeHead(400);return res.end('bad url')}
 if(u.startsWith('/api/')){/* phone app (standalone) syncs over the LAN with a Bearer token: allow cross-origin calls; cookies are NOT shared cross-origin */
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  try{return api(req,res,u)}catch(e){console.log('API ERR',e.message);return json(res,500,{error:'server error'})}}
  for(const[pre,dir]of[['/receipts/',REC],['/stories/',STORY],['/storybg/',SBG]])if(u.startsWith(pre)){
  if(!who(req)){res.writeHead(401);return res.end('login required')}
  const rel=u.slice(pre.length);if(rel.includes('..')||!/^[\w\-./]+$/.test(rel)){res.writeHead(400);return res.end('bad path')}
  const f=path.resolve(dir,rel);if(!f.startsWith(path.resolve(dir)+path.sep)){res.writeHead(400);return res.end('bad path')}
  return fs.readFile(f,(e,t)=>{if(e){res.writeHead(404);return res.end('not found')}res.writeHead(200,{'Content-Type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});res.end(t)})}
 if(u==='/manifest.webmanifest'){res.writeHead(200,{'Content-Type':'application/manifest+json'});return res.end(MANIFEST)}
 if(u==='/sw.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-cache','Service-Worker-Allowed':'/'});return res.end(SW)}
 {const m=/^\/icon-(192|512)\.png$/.exec(u);if(m){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=86400'});return res.end(ICONS[m[1]])}}
 const f=FILES[u];
 if(!f){res.writeHead(404);return res.end('Not found')}
 fs.readFile(path.join(APP,f),(e,t)=>{if(e){res.writeHead(404);return res.end('Missing '+f)}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'text/plain','X-Content-Type-Options':'nosniff'});res.end(t)});
});
server.on('error',e=>{console.log(e.code==='EADDRINUSE'?'Server is already running on port '+PORT:e.message);if(e.code==='EADDRINUSE'&&process.pkg)openBrowser('http://localhost:'+PORT);setTimeout(()=>process.exit(e.code==='EADDRINUSE'?0:1),300)});
/* never die because of one bad request: log and keep serving (serve.bat restarts us if we still exit) */
process.on('uncaughtException',e=>console.log(new Date().toLocaleTimeString(),'UNCAUGHT',e&&e.stack||e));
process.on('unhandledRejection',e=>console.log(new Date().toLocaleTimeString(),'UNHANDLED',e&&e.stack||e));
server.listen(PORT,HOST,()=>{console.log('Asalac CRM running: http://localhost:'+PORT+'  (close this window to stop)');if(LAN)lanIPs().forEach(ip=>console.log('Phone (same Wi-Fi):  http://'+ip+':'+PORT));console.log('Data folder: '+DATA);backup(false);setInterval(()=>backup(false),3600e3);if(process.pkg||process.env.OPEN==='1')openBrowser('http://localhost:'+PORT)});
