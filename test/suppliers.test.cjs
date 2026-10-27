const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const listeners = {};
  const modal = { innerHTML: '', classList:{remove(){},add(){}}, showModal() {}, addEventListener() {} };
  const context = vm.createContext({
    document: {
      querySelector: selector => selector === '#modal' ? modal : {},
      addEventListener: (event, handler) => { listeners[event] = handler; }
    },
    Intl, Date, setTimeout, clearTimeout
  });
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').replace(/init\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(`state.data={suppliers:[],categories:[],transactions:[],budgets:[],goals:[]};state.user={name:'Teste'};`, context);
  return { context, modal, run: code => vm.runInContext(code, context) };
}

test('supplier empty state offers registration', () => {
  const {run} = setup();
  const html = run('suppliersView()');
  assert.match(html, /Nenhum fornecedor cadastrado/);
  assert.match(html, /data-entity="suppliers"/);
});

test('supplier list escapes contact data and offers editing and deletion', () => {
  const {run} = setup();
  run(`state.data.suppliers=[{id:7,name:'<script>teste</script>',email:'a@example.com',phone:'123',notes:'<img src=x>'}];`);
  const html = run('suppliersView()');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /data-action="edit"/);
  assert.match(html, /data-action="delete"/);
});

test('numeric API ids match string ids from buttons when editing or deleting', () => {
  const {run,modal} = setup();
  run(`state.data.suppliers=[{id:7,name:'Fornecedor',email:null,phone:null,notes:'Contato'}];editor('suppliers','7');`);
  assert.match(modal.innerHTML, /Editar fornecedor/);
  assert.match(modal.innerHTML, /value="Fornecedor"/);
  assert.match(modal.innerHTML, /name="email"/);
  assert.match(modal.innerHTML, /name="phone"/);
  run(`deleteDialog('suppliers','7')`);
  assert.match(modal.innerHTML, /<strong>Fornecedor<\/strong>/);
});

test('reload fetches suppliers and preserves financial data', async () => {
  const {run,context} = setup();
  context.calls=[];
  run(`api=async endpoint=>{calls.push(endpoint);return endpoint==='/api/data'?{user:{name:'Teste'},transactions:[{id:1}]}:{suppliers:[{id:7,name:'Contato'}],products:[],quotations:[]};};renderApp=()=>{};`);
  await run('reload()');
  assert.deepEqual(Array.from(context.calls).sort(), ['/api/data','/api/products','/api/quotations','/api/suppliers']);
  assert.equal(run('state.data.suppliers[0].id'),7);
  assert.equal(run('state.data.transactions[0].id'),1);
});

test('demo blocks supplier changes', () => {
  const {run,modal} = setup();
  run(`state.demo=true;toast=()=>{};editor('suppliers');`);
  assert.equal(modal.innerHTML,'');
});
test('CSV export neutralizes formulas with leading whitespace and escapes quotes',()=>{
  const {run}=setup();
  assert.equal(run(`csvCell('  =HYPERLINK("bad")')`),`"'  =HYPERLINK(""bad"")"`);
  assert.equal(run(`csvCell('Texto normal')`),'"Texto normal"');
});
