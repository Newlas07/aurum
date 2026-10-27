const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PGlite} = require('@electric-sql/pglite');
const {PGLiteSocketServer} = require('@electric-sql/pglite-socket');

test('Aurum 2.0: authentication, ownership, quotation comparison and financial integration', {timeout:120000}, async t=>{
  let db,socket;
  const external=process.env.AURUM_TEST_DATABASE_URL;
  if(external){
    const url=new URL(external);
    assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.endsWith('_test'),'Use apenas um banco local dedicado com nome terminado em _test.');
    process.env.DATABASE_URL=external;
  }else{
    db=await PGlite.create();
    socket=new PGLiteSocketServer({db,port:15439,host:'127.0.0.1',maxConnections:20});
    await socket.start();
    process.env.DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:15439/postgres';
  }
  process.env.JWT_SECRET='test-only-secret-aurum-2-not-a-production-key';
  process.env.NODE_ENV='test';
  if(!external)process.env.AURUM_TEST_SINGLE_CONNECTION='1';
  const {app,pool,ready}=require('../server');
  await ready;
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();if(socket)await socket.stop();if(db)await db.close();});
  const agent=()=>({cookies:new Map(),csrf:null});
  const a=agent(),b=agent();
  async function request(who,url,method='GET',body,options={}){
    const response=await fetch(base+url,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),cookie:[...who.cookies].map(([k,v])=>k+'='+v).join(';'),...(who.csrf&&!options.noCsrf?{'x-csrf-token':who.csrf}:{}),...(options.origin?{origin:options.origin}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');who.cookies.set(pair.slice(0,index),pair.slice(index+1));}
    const content=await response.text();let data;try{data=JSON.parse(content);}catch{data=content;}
    who.lastHeaders=Object.fromEntries(response.headers);who.lastSetCookies=response.headers.getSetCookie();
    if(data.csrfToken)who.csrf=data.csrfToken;
    if(options.status!==undefined)assert.equal(response.status,options.status,JSON.stringify(data));
    else assert.ok(response.ok,JSON.stringify(data));
    return data;
  }
  let product,service,supplier1,supplier2,q,detail,proposal1,proposal2,expenseCategory;
  await t.test('register, login and restore session',async()=>{
    await request(a,'/api/auth/register','POST',{name:'Conta A',email:'a@example.test',password:'Aurum-test-password-2026!'});
    await request(b,'/api/auth/register','POST',{name:'Conta B',email:'b@example.test',password:'Aurum-other-password-2026!'});
    await request(a,'/api/auth/logout','POST',{});
    await request(a,'/api/auth/login','POST',{email:'a@example.test',password:'Aurum-test-password-2026!'});
    assert.equal((await request(a,'/api/session')).user.name,'Conta A');
    const data=await request(a,'/api/data');expenseCategory=data.categories.find(c=>c.type==='expense').id;
  });
  await t.test('protect private files, unauthenticated requests, CSRF and cross-origin writes',async()=>{
    for(const file of ['/server.js','/procurement.cjs','/package.json','/.env','/test/integration.test.cjs'])await request(agent(),file,'GET',undefined,{status:404});
    await request(agent(),'/api/products','GET',undefined,{status:401});
    await request(a,'/api/products','POST',{}, {status:403,noCsrf:true});
    await request(a,'/api/products','POST',{}, {status:403,origin:'https://attacker.test'});
    await request(a,'/api/session');assert.equal(a.lastHeaders['cache-control'],'no-store');
    assert.match(a.lastHeaders['content-security-policy'],/frame-ancestors 'none'/);
    assert.equal(a.lastHeaders['x-content-type-options'],'nosniff');
    const transplant=agent();transplant.cookies=new Map(a.cookies);transplant.cookies.set('csrf_token',b.cookies.get('csrf_token'));transplant.csrf=b.csrf;
    await request(transplant,'/api/products','POST',{}, {status:403});
    const forged=agent();forged.cookies=new Map(a.cookies);forged.cookies.set('auth_token',a.cookies.get('auth_token')+'tampered');
    await request(forged,'/api/data','GET',undefined,{status:401});
    await request(a,'/api/products','POST',[], {status:400});
    await request(a,'/api/products','POST',{name:'Inválido',kind:'product',quantity:true,unit:'un'},{status:400});
  });
  await t.test('supplier creation, editing and account isolation',async()=>{
    supplier1=(await request(a,'/api/suppliers','POST',{name:'Fornecedor A',email:'sales@example.test',phone:'11999999999',notes:'Entrega rápida'})).id;
    supplier2=(await request(a,'/api/suppliers','POST',{name:'Fornecedor B'})).id;
    await request(a,'/api/suppliers/'+supplier1,'PUT',{name:'Fornecedor A atualizado',notes:'Pagamento em 30 dias'});
    assert.equal((await request(b,'/api/suppliers')).suppliers.length,0);
    await request(b,'/api/suppliers/'+supplier1,'PUT',{name:'Inválido'},{status:404});
    await request(b,'/api/suppliers/'+supplier1,'DELETE',{}, {status:404});
  });
  await t.test('products and services persist and reject invalid quantities',async()=>{
    product=(await request(a,'/api/products','POST',{name:'Tinta',description:'Branca lavável',kind:'product',quantity:2.5,unit:'litro'})).id;
    service=(await request(a,'/api/products','POST',{name:'Pintura',description:'Mão de obra',kind:'service',quantity:3,unit:'hora'})).id;
    await request(a,'/api/products','POST',{name:'Inválido',kind:'product',quantity:1.0001,unit:'un'},{status:400});
    assert.equal((await request(a,'/api/products')).products.length,2);
    assert.equal((await request(b,'/api/products')).products.length,0);
    await request(b,'/api/products/'+product,'PUT',{name:'Inválido',kind:'product',quantity:1,unit:'un'},{status:404});
  });
  await t.test('quotations snapshot multiple products and enforce ownership',async()=>{
    q=(await request(a,'/api/quotations','POST',{title:'Pintura da sala',notes:'Comparar qualidade equivalente',items:[{product_id:product,quantity:2.5},{product_id:service,quantity:3}]})).id;
    await request(b,'/api/quotations/'+q,'GET',undefined,{status:404});
    await request(b,'/api/quotations','POST',{title:'Invasão',items:[{product_id:product,quantity:1}]},{status:400});
    assert.equal((await request(b,'/api/quotations')).quotations.length,0);
    detail=await request(a,'/api/quotations/'+q);assert.equal(detail.items.length,2);
    await request(a,'/api/products/'+product,'PUT',{name:'Tinta nova',description:'Mudou',kind:'product',quantity:1,unit:'galão'});
    assert.equal((await request(a,'/api/quotations/'+q)).items[0].name,'Tinta');
  });
  await t.test('compare complete offers including shipping, discounts and fractional quantities',async()=>{
    const items=detail.items.map((i,n)=>({quotation_item_id:i.id,unit_price:n?5000:1999}));
    proposal1=(await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier1,conditions:'30 dias',shipping:500,discount:100,items})).id;
    proposal2=(await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier2,shipping:1000,discount:0,items:items.map(i=>({...i,unit_price:i.unit_price+100}))})).id;
    detail=await request(a,'/api/quotations/'+q);
    assert.equal(detail.lowest_total,20398); // 2.5 * 1999 -> 4998 cents, plus 15000 + 500 - 100.
    assert.deepEqual(detail.best_proposal_ids,[proposal1]);assert.equal(detail.potential_savings,1150);
    await request(b,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier1,items},{status:404});
  });
  await t.test('incomplete offers cannot be approved or labeled as cheapest',async()=>{
    await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier2,items:[{quotation_item_id:detail.items[0].id,unit_price:1}]});
    detail=await request(a,'/api/quotations/'+q);
    assert.equal(detail.proposals.find(p=>p.id===proposal2).complete,false);
    assert.deepEqual(detail.best_proposal_ids,[proposal1]);assert.equal(detail.potential_savings,0);
    await request(a,`/api/quotations/${q}/approve`,'POST',{proposal_id:proposal2,date:'2026-10-27',category_id:expenseCategory},{status:400});
    await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier2,items:[null]},{status:400});
    await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier2,items:[{quotation_item_id:detail.items[0].id,unit_price:true}]},{status:400});
  });
  await t.test('approval creates one planned expense, including duplicate simultaneous requests',async()=>{
    const payload={proposal_id:proposal1,date:'2026-10-27',category_id:expenseCategory};
    await request(a,`/api/quotations/${q}/approve`,'POST',{...payload,date:'2026-02-30'},{status:400});
    const initial=await Promise.all([request(a,`/api/quotations/${q}/approve`,'POST',payload),request(a,`/api/quotations/${q}/approve`,'POST',payload)]);
    const first=initial[0];assert.equal(initial[1].transaction_id,first.transaction_id);
    const repeat=await request(a,`/api/quotations/${q}/approve`,'POST',payload);
    assert.equal(repeat.transaction_id,first.transaction_id);assert.equal(repeat.reused,true);
    const simultaneous=await Promise.all([request(a,`/api/quotations/${q}/approve`,'POST',payload),request(a,`/api/quotations/${q}/approve`,'POST',payload)]);
    assert.ok(simultaneous.every(r=>r.transaction_id===first.transaction_id));
    const auditCount=await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE event='quotation_approved' AND user_id=$1",[require('jsonwebtoken').decode(a.cookies.get('auth_token')).uid]);
    assert.equal(auditCount.rows[0].count,5);
    const data=await request(a,'/api/data');assert.equal(data.transactions.length,1);assert.equal(data.transactions[0].status,'pending');assert.equal(data.transactions[0].amount,20398);
    await request(a,`/api/quotations/${q}/approve`,'POST',{...payload,proposal_id:proposal2},{status:409});
    await request(a,`/api/quotations/${q}/proposals`,'POST',{supplier_id:supplier1,items:[]},{status:409});
    await request(a,'/api/quotations/'+q,'DELETE',{}, {status:409});
  });
  await t.test('logout revokes the server session',async()=>{
    const stolen=agent();stolen.cookies=new Map(a.cookies);stolen.csrf=a.csrf;
    await request(a,'/api/auth/logout','POST',{});
    await request(stolen,'/api/data','GET',undefined,{status:401});
  });
  await t.test('password change revokes other sessions and rejects the old password',async()=>{
    const other=agent();await request(other,'/api/auth/login','POST',{email:'b@example.test',password:'Aurum-other-password-2026!'});
    await request(b,'/api/password','PUT',{currentPassword:'Aurum-other-password-2026!',newPassword:'Nova-senha-aurum-2026!'});
    await request(other,'/api/data','GET',undefined,{status:401});
    await request(agent(),'/api/auth/login','POST',{email:'b@example.test',password:'Aurum-other-password-2026!'},{status:401});
    await request(agent(),'/api/auth/login','POST',{email:'b@example.test',password:'Nova-senha-aurum-2026!'});
  });
  await t.test('financial entities and security inventory are isolated between accounts',async()=>{
    const categories=(await request(b,'/api/data')).categories,category=categories.find(c=>c.type==='expense');
    const tx=(await request(b,'/api/transactions','POST',{title:'Teste',type:'expense',amount:100,category_id:category.id,date:'2026-10-26',status:'pending'})).id;
    const budget=(await request(b,'/api/budgets','POST',{category_id:category.id,month:'2026-10',limit:10000})).id;
    const goal=(await request(b,'/api/goals','POST',{name:'Teste',target:10000,saved:0,deadline:'2026-12-01',color:'#709487'})).id;
    await request(a,'/api/auth/login','POST',{email:'a@example.test',password:'Aurum-test-password-2026!'});
    for(const [entity,key] of [['transactions',tx],['budgets',budget],['goals',goal],['categories',category.id]])await request(a,`/api/${entity}/${key}`,'DELETE',{}, {status:404});
    await request(a,'/api/transactions','POST',{title:'Categoria alheia',type:'expense',amount:100,category_id:category.id,date:'2026-10-26',status:'paid'},{status:400});
    const inventory=await request(a,'/api/security/sessions');assert.ok(inventory.sessions.every(s=>s.jti!==require('jsonwebtoken').decode(b.cookies.get('auth_token')).jti));
    await request(agent(),'/api/security/events','GET',undefined,{status:401});
  });
  await t.test('expired sessions and expired or mismatched JWTs are rejected',async()=>{
    const jwt=require('jsonwebtoken'),claims=jwt.decode(a.cookies.get('auth_token'));
    const expired=agent();expired.cookies=new Map(a.cookies);expired.cookies.set('auth_token',jwt.sign({...claims,exp:1},process.env.JWT_SECRET));
    await request(expired,'/api/session','GET',undefined,{status:401});
    const wrongAudience=agent();wrongAudience.cookies=new Map(a.cookies);wrongAudience.cookies.set('auth_token',jwt.sign({...claims,aud:'another-app'},process.env.JWT_SECRET));
    await request(wrongAudience,'/api/session','GET',undefined,{status:401});
    await pool.query('UPDATE sessions SET expires_at=NOW()-INTERVAL \'1 second\' WHERE jti=$1',[claims.jti]);
    await request(a,'/api/session','GET',undefined,{status:401});
    await request(a,'/api/auth/login','POST',{email:'a@example.test',password:'Aurum-test-password-2026!'});
  });
  await t.test('malformed JSON, excessive bodies and SQL-like ids fail without disclosing internals',async()=>{
    for(const [raw,expected] of [['{"invalid":',400],[JSON.stringify({text:'x'.repeat(60000)}),413]]){
      const response=await fetch(base+'/api/products',{method:'POST',headers:{'content-type':'application/json'},body:raw});
      assert.equal(response.status,expected);assert.ok(!(await response.text()).includes('SyntaxError'));
    }
    await request(a,"/api/quotations/1%20OR%201=1",'GET',undefined,{status:404});
  });
  await t.test('deleting an account with approved quotations removes only its own data',async()=>{
    await request(a,'/api/security/account','DELETE',{confirm:'EXCLUIR',password:'wrong'},{status:401});
    await request(a,'/api/security/account','DELETE',{confirm:'EXCLUIR',password:'Aurum-test-password-2026!'});
    await request(a,'/api/session','GET',undefined,{status:401});
    assert.equal((await request(b,'/api/data')).user.name,'Conta B');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM suppliers WHERE name LIKE 'Fornecedor%'")).rows[0].count,0);
  });
  await t.test('login lockout survives concurrent failures and correct credentials cannot bypass it',async()=>{
    await Promise.all(Array.from({length:5},()=>request(agent(),'/api/auth/login','POST',{email:'b@example.test',password:'wrong'},{status:401})));
    await request(agent(),'/api/auth/login','POST',{email:'b@example.test',password:'Nova-senha-aurum-2026!'},{status:429});
    const locked=await pool.query("SELECT failed_login_count,locked_until>NOW() AS locked FROM users WHERE email='b@example.test'");
    assert.equal(locked.rows[0].failed_login_count,5);assert.equal(locked.rows[0].locked,true);
  });
  await t.test('reauthentication has a per-account attempt limit',async()=>{
    for(let n=0;n<9;n++)await request(b,'/api/password','PUT',{currentPassword:'wrong',newPassword:'Other-test-password-2026!'},{status:401});
    await request(b,'/api/password','PUT',{currentPassword:'wrong',newPassword:'Other-test-password-2026!'},{status:429});
  });
});
