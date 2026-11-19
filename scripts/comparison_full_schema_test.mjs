const {PGlite} = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const {pgcrypto} = await import(process.env.PGLITE_PGCRYPTO_MODULE || '@electric-sql/pglite/contrib/pgcrypto');
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role anon;create role authenticated;create role service_role;create schema storage; create table storage.buckets(id text primary key,name text,public boolean);');
for(const file of fs.readdirSync(root+'/supabase/migrations').sort()) {
 try { await db.exec(fs.readFileSync(root+'/supabase/migrations/'+file,'utf8')); console.log('OK',file); }
 catch(e) {throw new Error('Migration '+file+' failed: '+e.message);}
}

const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
try {
await db.query("update limits set value='4' where key='active_agent_version'");
await db.query("insert into users(id,wa_id)values($1,'synthetic')",[id(1)]);
await db.query("insert into user_limits(user_id,key,value,updated_by)values($1,'comparison_mode','true','synthetic')",[id(1)]);
await db.query("insert into caller_numbers(id,e164,provider)values($1,'+919800000099','sarvam')",[id(2)]);
await db.query("insert into requests(id,user_id,task,comparison,fields)values($1,$2,'question',true,'{\"questions\":[\"price?\"]}')",[id(3),id(1)]);
for(let i=10;i<15;i++) await db.query("insert into businesses(id,name,phone_e164,source)values($1,$2,$3,'user')",[id(i),'Synthetic '+i,'+9198000000'+i]);
await db.query('select set_recipients($1,$2)',[id(3),[10,11,12,13,14].map(id)]);
await db.query("insert into consents(id,request_id,kind,text_shown,fields_hash)select $1,id,'ask','synthetic plan',fields_hash(fields)from requests where id=$2",[id(4),id(3)]);
await db.query("update requests set state='calling_1' where id=$1",[id(3)]);
for(let i=10;i<15;i++){
 let res=(await db.query("select reserve_call($1,'question',null,false,$2::uuid) r",[id(3),id(i)])).rows[0].r;
 console.log('RESERVATION',i,JSON.stringify(res));assert.equal(res.ok,true);
}
assert.equal((await db.query('select count(*)::int n from calls')).rows[0].n,5);
await db.query('select finish_comparison_dispatch($1)',[id(3)]);
for(const c of (await db.query('select id from calls')).rows){
 await db.query("update calls set status='completed',outputs='{}',provider_result='{}' where id=$1",[c.id]);
 const token=(await db.query('select claim_settlement($1) token',[c.id])).rows[0].token;
 const res=(await db.query("select settle_comparison_call($1,false,false,'{}',now(),$2) r",[c.id,token])).rows[0].r;
 console.log('SETTLEMENT',JSON.stringify(res));assert.equal(res.ok,true);
}
assert.equal((await db.query('select count(*)::int n from deliveries')).rows[0].n,1);
console.log('FULL REPOSITORY SCHEMA FLOW PASS, synthetic rows only');
}catch(e){console.error('FLOW FAIL',e.message,e.detail||'',e.hint||'');process.exitCode=1;}
await db.close();
