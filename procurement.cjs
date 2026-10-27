// Procurement is isolated from the existing finance routes to preserve their behavior.
module.exports = function procurement({app,pool,auth,csrf,bad,validDate,parseMoney,audit}) {
  const id = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : null;
  const text = value => String(value ?? '').trim();
  const quantity = value => /^\d+(\.\d{1,3})?$/.test(String(value)) && Number(value)>0 && Number(value)<=1000000 ? Number(value) : null;
  const fail = (message,status=400) => Object.assign(new Error(message),{status});
  async function transaction(work) {
    const client=await pool.connect();
    try { await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result; }
    catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  function route(method,url,handler) {
    app[method](url,auth,...(method==='get'?[]:[csrf]),async(req,res,next)=>{
      try{await handler(req,res);}catch(error){if(error.status)return bad(res,error.message,error.status);next(error);}
    });
  }
  async function quote(client,uid,qid,lock=false) {
    const result=await client.query('SELECT * FROM quotations WHERE id=$1 AND user_id=$2'+(lock?' FOR UPDATE':''),[qid,uid]);
    if(!result.rowCount)throw fail('Cotação não encontrada.',404);
    return result.rows[0];
  }
  function editable(q){if(q.approved_proposal_id)throw fail('Esta cotação já foi aprovada e não pode ser alterada.',409);}
  async function comparison(client,uid,qid) {
    const q=await quote(client,uid,qid);
    const items=(await client.query('SELECT * FROM quotation_items WHERE quotation_id=$1 ORDER BY id',[q.id])).rows;
    const proposals=(await client.query('SELECT p.*,s.name AS supplier_name FROM proposals p JOIN suppliers s ON s.id=p.supplier_id WHERE p.quotation_id=$1 ORDER BY p.id',[q.id])).rows;
    const prices=(await client.query('SELECT pi.* FROM proposal_items pi JOIN proposals p ON p.id=pi.proposal_id WHERE p.quotation_id=$1',[q.id])).rows;
    const offers=proposals.map(p=>{
      const lines=items.map(item=>{
        const price=prices.find(v=>v.proposal_id===p.id&&v.quotation_item_id===item.id);
        const total=price?Number((BigInt(Math.round(Number(item.quantity)*1000))*BigInt(price.unit_price)+500n)/1000n):null;
        return {...item,quantity:Number(item.quantity),unit_price:price?.unit_price??null,total};
      });
      const complete=lines.length>0&&lines.every(l=>l.total!==null);
      const subtotal=complete?lines.reduce((sum,l)=>sum+l.total,0):null;
      const total=subtotal===null?null:subtotal+p.shipping-p.discount;
      return {...p,items:lines,complete,total};
    });
    const complete=offers.filter(p=>p.complete&&p.total>=0&&p.total<=1000000000000).sort((a,b)=>a.total-b.total||a.id-b.id);
    const min=complete[0]?.total??null,max=complete.at(-1)?.total??null;
    const linked=(await client.query('SELECT id FROM transactions WHERE quotation_id=$1 AND user_id=$2',[q.id,uid])).rows[0];
    return {...q,items:items.map(i=>({...i,quantity:Number(i.quantity)})),proposals:offers,best_proposal_ids:complete.filter(p=>p.total===min).map(p=>p.id),lowest_total:min,potential_savings:min===null?null:max-min,transaction_id:linked?.id??null};
  }
  const ready=async()=>{
    const sql=[
      "CREATE TABLE IF NOT EXISTS products (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name VARCHAR(120) NOT NULL,description VARCHAR(1000) NOT NULL DEFAULT '',kind VARCHAR(10) NOT NULL CHECK(kind IN ('product','service')),quantity NUMERIC(12,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000),unit VARCHAR(20) NOT NULL)",
      "CREATE TABLE IF NOT EXISTS quotations (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title VARCHAR(120) NOT NULL,notes VARCHAR(1000) NOT NULL DEFAULT '',approved_proposal_id BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
      "CREATE TABLE IF NOT EXISTS quotation_items (id BIGSERIAL PRIMARY KEY,quotation_id BIGINT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,name VARCHAR(120) NOT NULL,description VARCHAR(1000) NOT NULL DEFAULT '',quantity NUMERIC(12,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000),unit VARCHAR(20) NOT NULL)",
      "CREATE TABLE IF NOT EXISTS proposals (id BIGSERIAL PRIMARY KEY,quotation_id BIGINT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,conditions VARCHAR(1000) NOT NULL DEFAULT '',shipping BIGINT NOT NULL DEFAULT 0 CHECK(shipping>=0),discount BIGINT NOT NULL DEFAULT 0 CHECK(discount>=0),UNIQUE(quotation_id,supplier_id))",
      "CREATE TABLE IF NOT EXISTS proposal_items (proposal_id BIGINT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,quotation_item_id BIGINT NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,unit_price BIGINT NOT NULL CHECK(unit_price>=0),PRIMARY KEY(proposal_id,quotation_item_id))",
      'ALTER TABLE transactions ADD COLUMN IF NOT EXISTS quotation_id BIGINT REFERENCES quotations(id) ON DELETE SET NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS transactions_quotation_unique ON transactions(quotation_id) WHERE quotation_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS products_user_idx ON products(user_id)',
      'CREATE INDEX IF NOT EXISTS quotations_user_idx ON quotations(user_id)',
      'CREATE INDEX IF NOT EXISTS quotation_items_quote_idx ON quotation_items(quotation_id)'
    ];for(const statement of sql)await pool.query(statement);
  };
  route('get','/api/products',async(req,res)=>res.json({products:(await pool.query('SELECT * FROM products WHERE user_id=$1 ORDER BY name,id',[req.user.id])).rows.map(p=>({...p,quantity:Number(p.quantity)}))}));
  for(const method of ['post','put']) route(method,'/api/products'+(method==='put'?'/:id':''),async(req,res)=>{
    const b=req.body,name=text(b.name),description=text(b.description),unit=text(b.unit),qty=quantity(b.quantity);
    if(name.length<2||name.length>120||description.length>1000||!unit||unit.length>20||!qty||!['product','service'].includes(b.kind))throw fail('Revise nome, descrição, quantidade e unidade.');
    const args=[req.user.id,name,description,b.kind,qty,unit];
    const result=method==='post'?await pool.query('INSERT INTO products(user_id,name,description,kind,quantity,unit) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',args):await pool.query('UPDATE products SET name=$2,description=$3,kind=$4,quantity=$5,unit=$6 WHERE user_id=$1 AND id=$7 RETURNING id',[...args,id(req.params.id)]);
    if(!result.rowCount)throw fail('Produto não encontrado.',404);res.status(method==='post'?201:200).json({id:result.rows[0].id});
  });
  route('delete','/api/products/:id',async(req,res)=>{
    const r=await pool.query('DELETE FROM products WHERE id=$1 AND user_id=$2',[id(req.params.id),req.user.id]);if(!r.rowCount)throw fail('Produto não encontrado.',404);res.json({ok:true});
  });
  route('get','/api/quotations',async(req,res)=>{
    const rows=(await pool.query('SELECT id,title,notes,approved_proposal_id,created_at FROM quotations WHERE user_id=$1 ORDER BY id DESC',[req.user.id])).rows;res.json({quotations:rows});
  });
  route('get','/api/quotations/:id',async(req,res)=>res.json(await comparison(pool,req.user.id,id(req.params.id))));
  route('post','/api/quotations',async(req,res)=>{
    const title=text(req.body.title),notes=text(req.body.notes),items=req.body.items;
    if(title.length<2||title.length>120||notes.length>1000||!Array.isArray(items)||!items.length||items.length>50)throw fail('Informe o título e de 1 a 50 itens.');
    const result=await transaction(async client=>{
      const q=(await client.query('INSERT INTO quotations(user_id,title,notes) VALUES($1,$2,$3) RETURNING id',[req.user.id,title,notes])).rows[0];
      for(const item of items){
        const p=(await client.query('SELECT * FROM products WHERE id=$1 AND user_id=$2',[id(item.product_id),req.user.id])).rows[0];
        const qty=quantity(item.quantity);if(!p||!qty)throw fail('Produto ou quantidade inválida.');
        await client.query('INSERT INTO quotation_items(quotation_id,product_id,name,description,quantity,unit) VALUES($1,$2,$3,$4,$5,$6)',[q.id,p.id,p.name,p.description,qty,p.unit]);
      }return q;
    });res.status(201).json(result);
  });
  route('delete','/api/quotations/:id',async(req,res)=>{
    await transaction(async client=>{const q=await quote(client,req.user.id,id(req.params.id),true);editable(q);await client.query('DELETE FROM quotations WHERE id=$1',[q.id]);});res.json({ok:true});
  });
  route('post','/api/quotations/:id/proposals',async(req,res)=>{
    const b=req.body,conditions=text(b.conditions),shipping=parseMoney(b.shipping??0),discount=parseMoney(b.discount??0);
    if(conditions.length>1000||shipping===null||discount===null||!Array.isArray(b.items)||b.items.length>50)throw fail('Condições ou preços inválidos.');
    const result=await transaction(async client=>{
      const q=await quote(client,req.user.id,id(req.params.id),true);editable(q);
      const supplier=await client.query('SELECT id FROM suppliers WHERE id=$1 AND user_id=$2',[id(b.supplier_id),req.user.id]);if(!supplier.rowCount)throw fail('Fornecedor inválido.');
      const items=(await client.query('SELECT id,quantity FROM quotation_items WHERE quotation_id=$1',[q.id])).rows;
      const seen=new Set();let subtotal=0n;
      for(const line of b.items){
        const item=items.find(v=>v.id===id(line.quotation_item_id)),price=parseMoney(line.unit_price);
        if(!item||price===null||seen.has(item.id))throw fail('Itens ou preços inválidos.');
        seen.add(item.id);subtotal+=(BigInt(Math.round(Number(item.quantity)*1000))*BigInt(price)+500n)/1000n;
      }
      if(!seen.size||subtotal+BigInt(shipping)-BigInt(discount)<0n||subtotal+BigInt(shipping)-BigInt(discount)>1000000000000n)throw fail('O total da proposta está fora do limite permitido.');
      const p=(await client.query('INSERT INTO proposals(quotation_id,supplier_id,conditions,shipping,discount) VALUES($1,$2,$3,$4,$5) ON CONFLICT(quotation_id,supplier_id) DO UPDATE SET conditions=EXCLUDED.conditions,shipping=EXCLUDED.shipping,discount=EXCLUDED.discount RETURNING id',[q.id,id(b.supplier_id),conditions,shipping,discount])).rows[0];
      await client.query('DELETE FROM proposal_items WHERE proposal_id=$1',[p.id]);
      for(const line of b.items)await client.query('INSERT INTO proposal_items(proposal_id,quotation_item_id,unit_price) VALUES($1,$2,$3)',[p.id,id(line.quotation_item_id),line.unit_price]);
      return p;
    });res.json(result);
  });
  route('post','/api/quotations/:id/approve',async(req,res)=>{
    const b=req.body;if(!validDate(b.date))throw fail('Informe uma data válida para a despesa planejada.');
    const result=await transaction(async client=>{
      const q=await quote(client,req.user.id,id(req.params.id),true),pid=id(b.proposal_id);
      if(q.approved_proposal_id&&q.approved_proposal_id!==pid)throw fail('Outra proposta já foi aprovada.',409);
      const existing=(await client.query('SELECT id FROM transactions WHERE quotation_id=$1 AND user_id=$2',[q.id,req.user.id])).rows[0];
      if(existing)return {transaction_id:existing.id,reused:true};
      const data=await comparison(client,req.user.id,q.id),offer=data.proposals.find(p=>p.id===pid);
      if(!offer||!offer.complete||offer.total<=0)throw fail('Escolha uma proposta completa com total maior que zero.');
      const category=await client.query("SELECT id FROM categories WHERE id=$1 AND user_id=$2 AND type='expense'",[id(b.category_id),req.user.id]);if(!category.rowCount)throw fail('Escolha uma categoria de despesa válida.');
      const t=(await client.query("INSERT INTO transactions(user_id,title,type,amount,category_id,date,status,notes,quotation_id) VALUES($1,$2,'expense',$3,$4,$5,'pending',$6,$7) RETURNING id",[req.user.id,q.title,offer.total,id(b.category_id),b.date,('Cotação #'+q.id+' · '+offer.supplier_name+' · '+offer.conditions).slice(0,1000),q.id])).rows[0];
      await client.query('UPDATE quotations SET approved_proposal_id=$1 WHERE id=$2',[pid,q.id]);return {transaction_id:t.id,reused:false};
    });await audit(req,'quotation_approved',req.user.id,{quotation_id:id(req.params.id)});res.json(result);
  });
  return {ready};
};
