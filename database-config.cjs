const fs=require('node:fs');
module.exports=function databaseConfig(connectionString,env=process.env){
  const url=new URL(connectionString);
  const mode=env.PGSSLMODE||url.searchParams.get('sslmode')||'disable';
  if(!['disable','require','verify-full'].includes(mode))throw new Error('Modo TLS do banco inválido.');
  if(['sslcert','sslkey','sslrootcert'].some(k=>url.searchParams.has(k)))throw new Error('Configure a CA do banco em PGSSLROOTCERT.');
  url.searchParams.delete('sslmode');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const privateRailway=url.hostname.endsWith('.railway.internal');
  if(env.NODE_ENV==='production'&&mode==='disable'&&!local&&!privateRailway)throw new Error('Banco externo exige TLS com certificado validado.');
  return {connectionString:url.toString(),ssl:mode==='disable'?false:{rejectUnauthorized:true,...(env.PGSSLROOTCERT?{ca:fs.readFileSync(env.PGSSLROOTCERT,'utf8')}:{})},connectionTimeoutMillis:10000,statement_timeout:15000,idle_in_transaction_session_timeout:15000};
};
