const {PGlite}=require('@electric-sql/pglite');
const {PGLiteSocketServer}=require('@electric-sql/pglite-socket');
const path=require('node:path');
const crypto=require('node:crypto');

(async()=>{
  if(process.env.NODE_ENV==='production')throw new Error('Este comando é apenas para desenvolvimento local.');
  require('node:fs').mkdirSync(path.join(__dirname,'../data'),{recursive:true});
  const port=Number(process.env.PORT||3000),dbPort=port+12440;
  const db=await PGlite.create(path.join(__dirname,'../data/dev-'+port));
  const socket=new PGLiteSocketServer({db,port:dbPort,host:'127.0.0.1',maxConnections:20});
  await socket.start();
  process.env.DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:'+dbPort+'/postgres';
  process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
  process.env.NODE_ENV='development';
  const {app,pool,ready}=require('../server');await ready;
  const server=app.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>console.log('Aurum 2.0 local: http://127.0.0.1:'+server.address().port));
  const stop=async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();await socket.stop();await db.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
})().catch(error=>{console.error(error);process.exitCode=1;});
