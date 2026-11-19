// Audio cleanup and erasure in 0034, on the whole repository's migrations in PGlite.
// Synthetic rows only. Storage is a stand-in: the worker's removal is simulated by
// what audioWork().acknowledge does (clear audio_path, drop the tombstone).
const {PGlite} = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const {pgcrypto} = await import(process.env.PGLITE_PGCRYPTO_MODULE || '@electric-sql/pglite/contrib/pgcrypto');
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role anon;create role authenticated;create role service_role;create schema storage; create table storage.buckets(id text primary key,name text,public boolean);');
for(const file of fs.readdirSync(root+'/supabase/migrations').sort()) {
  try { await db.exec(fs.readFileSync(root+'/supabase/migrations/'+file,'utf8')); }
  catch(e) {throw new Error('Migration '+file+' failed: '+e.message);}
}
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const one=async(sql,args=[])=>{const r=(await db.query(sql,args)).rows[0];return r?Object.values(r)[0]:undefined;};
let n=100;
const caller=id(99);
await db.query("insert into caller_numbers(id,e164,provider)values($1,'+919800000099','sarvam')",[caller]);
// A user with one request (comparison or not) and one call to a fresh business.
async function setup({comparison}){
  const u=id(n++),r=id(n++),b=id(n++),c=id(n++);
  await db.query("insert into users(id,wa_id)values($1,$2)",[u,'synthetic-'+u]);
  if(comparison) await db.query("insert into user_limits(user_id,key,value,updated_by)values($1,'comparison_mode','true','synthetic')",[u]);
  await db.query("insert into requests(id,user_id,task,fields)values($1,$2,'question','{}')",[r,u]);
  await db.query("insert into businesses(id,name,phone_e164,source)values($1,'Synthetic',$2,'user')",[b,'+9198'+String(n).padStart(8,'0')]);
  await db.query("insert into calls(id,request_id,user_id,business_id,caller_number_id,kind,agent_version)values($1,$2,$3,$4,$5,'question','4')",[c,r,u,b,caller]);
  return {u,r,c};
}
const result=c=>db.query("update calls set status='completed',settled_at=now(),provider_result=jsonb_build_object('interactionId','i-'||id::text) where id=$1",[c]);
const tomb=async p=>(await db.query('select user_id from call_audio_deletions where path=$1',[p])).rows[0];
const ack=async p=>{await db.query('update calls set audio_path=null where audio_path=$1',[p]);await db.query('delete from call_audio_deletions where path=$1',[p]);};
const requestErasure=u=>db.query("update users set delete_requested_at=now()-interval '2 minutes' where id=$1",[u]);
const exists=async u=>(await one('select count(*)::int from users where id=$1',[u]))===1;

try {
  // Ordinary calls never queue audio work, and deleting them queues no deletion.
  const plain=await setup({comparison:false});
  await result(plain.c);
  assert.equal(await one('select count(*)::int from call_audio_jobs where call_id=$1',[plain.c]),0);
  await db.query('delete from calls where id=$1',[plain.c]);
  assert.equal(await tomb(plain.c+'.wav'),undefined);
  console.log('PASS ordinary call deletion queues no audio deletion');

  // A comparison call whose job never ran has no bytes: deleting it queues nothing.
  const fresh=await setup({comparison:true});
  await result(fresh.c);
  assert.equal(await one('select count(*)::int from call_audio_jobs where call_id=$1',[fresh.c]),1);
  await db.query('delete from calls where id=$1',[fresh.c]);
  assert.equal(await tomb(fresh.c+'.wav'),undefined);
  console.log('PASS never-attempted job leaves nothing to delete');

  // An attempted job may have uploaded before crashing: its path is queued, with its user.
  const crashed=await setup({comparison:true});
  await result(crashed.c);
  await db.query('update call_audio_jobs set attempts=1 where call_id=$1',[crashed.c]);
  await db.query('delete from calls where id=$1',[crashed.c]);
  assert.equal((await tomb(crashed.c+'.wav'))?.user_id,crashed.u);
  console.log('PASS attempted job deletion queues its path with the owner');

  // An expired job that never ran is dropped without a deletion entry.
  const stale=await setup({comparison:true});
  await result(stale.c);
  await db.query("update call_audio_jobs set expires_at=now()-interval '1 minute' where call_id=$1",[stale.c]);
  await db.query('select prepare_audio_cleanup()');
  assert.equal(await one('select count(*)::int from call_audio_jobs where call_id=$1',[stale.c]),0);
  assert.equal(await tomb(stale.c+'.wav'),undefined);
  console.log('PASS expired unattempted job dropped with no deletion entry');

  // Erasure with a saved recording: waits until the worker removed the bytes.
  const saved=await setup({comparison:true});
  await result(saved.c);
  const job=(await one('select take_audio_jobs()')).find(j=>j.call_id===saved.c);
  assert.equal(await one('select finish_audio_job($1,$2,true)',[saved.c,job.token]),true);
  await requestErasure(saved.u);
  await db.query('select prepare_audio_cleanup()');
  assert.equal((await tomb(saved.c+'.wav'))?.user_id,saved.u);
  await db.query('select erase_requested_users()');
  assert.equal(await exists(saved.u),true,'erased while audio was still in the bucket');
  await ack(saved.c+'.wav');
  await db.query('select erase_requested_users()');
  assert.equal(await exists(saved.u),false);
  assert.equal(await tomb(saved.c+'.wav'),undefined,'cascade queued a deletion for audio already removed');
  console.log('PASS erasure waits for saved audio to be removed, then completes cleanly');

  // Erasure during a leased upload: the late upload is queued for deletion, erasure waits.
  const leased=await setup({comparison:true});
  await result(leased.c);
  const lj=(await one('select take_audio_jobs()')).find(j=>j.call_id===leased.c);
  await requestErasure(leased.u);
  await db.query('select erase_requested_users()');
  assert.equal(await exists(leased.u),true);
  assert.equal(await one('select finish_audio_job($1,$2,true)',[leased.c,lj.token]),false);
  assert.equal((await tomb(leased.c+'.wav'))?.user_id,leased.u);
  await db.query('select prepare_audio_cleanup()');
  assert.equal(await one('select count(*)::int from call_audio_jobs where call_id=$1',[leased.c]),0);
  await db.query('select erase_requested_users()');
  assert.equal(await exists(leased.u),true,'erased before the late upload was removed');
  await ack(leased.c+'.wav');
  await db.query('select erase_requested_users()');
  assert.equal(await exists(leased.u),false);
  console.log('PASS late upload during erasure is removed before the user is erased');

  // A user with no audio at all is erased as before.
  const none=await setup({comparison:false});
  await result(none.c);
  await requestErasure(none.u);
  await db.query('select erase_requested_users()');
  assert.equal(await exists(none.u),false);
  console.log('PASS user without audio erased immediately');
  console.log('ALL AUDIO/ERASURE CHECKS PASS, synthetic rows only');
} catch(e) { console.error('FAIL',e.message,e.detail||'',e.hint||''); process.exitCode=1; }
await db.close();
