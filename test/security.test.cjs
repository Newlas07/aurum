const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {hashPassword,verifyPassword,needsUpgrade}=require('../passwords.cjs');
const databaseConfig=require('../database-config.cjs');

test('password hashing distinguishes Unicode passwords beyond bcrypt byte limit',async()=>{
  const prefix='á'.repeat(40),one=prefix+'-first',two=prefix+'-other';
  const hash=await hashPassword(one);
  assert.ok(await verifyPassword(one,hash));
  assert.equal(await verifyPassword(two,hash),false);
  assert.equal(needsUpgrade(hash),false);
  const legacy=await require('bcryptjs').hash('legacy-test-password',12);
  assert.ok(await verifyPassword('legacy-test-password',legacy));assert.equal(needsUpgrade(legacy),true);
});
test('database TLS cannot be silently weakened by connection URL',()=>{
  assert.throws(()=>databaseConfig('postgresql://u:p@db.example.test/db',{NODE_ENV:'production'}),/TLS/);
  assert.throws(()=>databaseConfig('postgresql://u:p@db.example.test/db?sslmode=no-verify',{}),/TLS/);
  const tls=databaseConfig('postgresql://u:p@db.example.test/db?sslmode=require',{NODE_ENV:'production'});
  assert.equal(tls.ssl.rejectUnauthorized,true);assert.equal(new URL(tls.connectionString).searchParams.has('sslmode'),false);
  assert.equal(databaseConfig('postgresql://u:p@postgres.railway.internal/db',{NODE_ENV:'production'}).ssl,false);
});
function theme(saved,blocked=false){
  const storage=new Map(saved?[['aurum.theme',saved]]:[]),handlers={};
  const root={dataset:{},style:{}};
  const media={matches:false,addEventListener:(type,fn)=>{handlers.media=fn;}};
  const ctx=vm.createContext({document:{documentElement:root,querySelector:()=>null},localStorage:{getItem:key=>{if(blocked)throw Error('blocked');return storage.get(key);},setItem:(key,value)=>{if(blocked)throw Error('blocked');storage.set(key,value);}},matchMedia:()=>media,addEventListener:(type,fn)=>{handlers[type]=fn;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../theme.js'),'utf8'),ctx);
  return {ctx,root,storage,media,handlers};
}
test('theme preference survives reload and supports OS changes',()=>{
  const t=theme();assert.equal(t.root.dataset.theme,'light');
  t.ctx.AurumTheme.set('dark');assert.equal(t.root.dataset.theme,'dark');assert.equal(t.storage.get('aurum.theme'),'dark');
  const next=theme(t.storage.get('aurum.theme'));assert.equal(next.root.dataset.theme,'dark');
  next.ctx.AurumTheme.set('system');next.media.matches=true;next.handlers.media();assert.equal(next.root.dataset.theme,'dark');
  next.ctx.AurumTheme.set('<script>');assert.equal(next.ctx.AurumTheme.get(),'system');
});
test('blocked browser storage does not break theme selection',()=>{
  const t=theme(null,true);t.ctx.AurumTheme.set('dark');assert.equal(t.root.dataset.theme,'dark');
});
