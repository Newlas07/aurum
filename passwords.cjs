const crypto=require('node:crypto');
const {promisify}=require('node:util');
const bcrypt=require('bcryptjs');
const scrypt=promisify(crypto.scrypt);
const prefix='$aurum-scrypt$v1$';
const options={N:65536,r:8,p:2,maxmem:128*1024*1024};
let active=0;const waiting=[];
async function bounded(work){
  if(active>=2){
    if(waiting.length>=16)throw Object.assign(new Error('Autenticação ocupada. Tente novamente.'),{status:503});
    await new Promise(resolve=>waiting.push(resolve));
  }else active++;
  try{return await work();}finally{if(waiting.length)waiting.shift()();else active--;}
}
async function hashPassword(password){
  const salt=crypto.randomBytes(16);
  const hash=await bounded(()=>scrypt(password,salt,64,options));
  return prefix+salt.toString('base64')+'$'+hash.toString('base64');
}
async function verifyPassword(password,stored){
  if(typeof password!=='string'||password.length>128||typeof stored!=='string')return false;
  if(!stored.startsWith(prefix))return bounded(()=>bcrypt.compare(password,stored));
  const [saltText,hashText]=stored.slice(prefix.length).split('$');
  const salt=Buffer.from(saltText||'','base64'),expected=Buffer.from(hashText||'','base64');
  if(salt.length!==16||expected.length!==64)return false;
  const actual=await bounded(()=>scrypt(password,salt,64,options));
  return crypto.timingSafeEqual(actual,expected);
}
module.exports={hashPassword,verifyPassword,needsUpgrade:hash=>!hash.startsWith(prefix)};
