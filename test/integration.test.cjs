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
});
