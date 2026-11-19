"""Local-only regression checks against a restored schema, never a production DB.
Usage: python scripts/comparison_review_db_test.py /tmp/local-test-uri
Requires psycopg and a prepared isolated database with migrations through 0034.
"""
import concurrent.futures
import json
import pathlib
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb

uri = pathlib.Path(sys.argv[1]).read_text().strip()
if not any(x in uri for x in ('host=/tmp/', 'host=localhost', 'host=127.0.0.1', '@/')):
    raise SystemExit('Only an isolated local database is permitted')
c = psycopg.connect(uri, autocommit=True)
def uid(): return str(uuid.uuid4())
def one(sql, args=()): return c.execute(sql,args).fetchone()[0]

def seed(task='question', enabled=True):
    u,r,n=uid(),uid(),uid()
    c.execute('insert into users(id,wa_id) values(%s,%s)',[u,'synthetic-'+u])
    if enabled:c.execute("insert into user_limits(user_id,key,value,updated_by)values(%s,'comparison_mode','true','synthetic')",[u])
    c.execute("insert into caller_numbers(id,e164,provider)values(%s,%s,'sarvam')",[n,'+919'+str(int(uuid.uuid4().hex[:7],16)).zfill(9)])
    c.execute("insert into requests(id,user_id,task,fields)values(%s,%s,%s,'{\"questions\":[\"price?\"]}')",[r,u,task])
    return u,r

def batch(size=2):
    u,r=seed();bs=[]
    for i in range(size):
        b=uid();bs.append(b)
        c.execute("insert into businesses(id,name,phone_e164,source)values(%s,%s,%s,'user')",[b,'Synthetic '+str(i),'+918'+str(int(uuid.uuid4().hex[:7],16)).zfill(9)])
    assert one('select set_recipients(%s,%s::uuid[])',[r,bs])['ok']
    consent=uid()
    c.execute("insert into consents(id,request_id,kind,text_shown,fields_hash)select %s,id,'ask','synthetic',fields_hash(fields)from requests where id=%s",[consent,r])
    c.execute("update requests set state='calling_1' where id=%s",[r])
    calls=[]
    for b in bs:
        result=one("select reserve_call(%s,'question',null,false,%s::uuid)",[r,b]);assert result['ok'],result;calls.append(result['call_id'])
    one('select finish_comparison_dispatch(%s)',[r])
    return u,r,calls

# Global ON cannot affect an unopted account, nor can explicit true force it.
c.execute("update limits set value='true' where key='comparison_mode'")
u,r=seed(enabled=False)
assert one('select comparison from requests where id=%s',[r]) is False
for task in ('cancel','reschedule'):
    u,r=seed(task)
    assert one('select comparison from requests where id=%s',[r]) is False
    assert one('select comparison_dispatching from requests where id=%s',[r]) is False
print('PASS account isolation and cancel/reschedule exclusion despite global ON')

# Final caller supplies deliberately stale batch facts. SQL must ignore that snapshot.
u,r,calls=batch(5)
for call in calls:c.execute("update calls set status='completed',provider_result='{}',outputs='{}' where id=%s",[call])
def settle(call):
    with psycopg.connect(uri,autocommit=True) as db:
        token=db.execute('select claim_settlement(%s)',[call]).fetchone()[0]
        if not token:return None
        facts={'event':'comparison_summary','happened':{'results':[{'outcome':'unreachable','detail':'STALE'}]},'values':{},'next_step':None,'_comparison_result':{'rank':1,'outcome':'answered','detail':'CURRENT '+call}}
        return db.execute("select settle_comparison_call(%s,false,false,%s,now(),%s)",[call,Jsonb(facts),token]).fetchone()[0]
with concurrent.futures.ThreadPoolExecutor(10) as pool:results=list(pool.map(settle,[x for x in calls for _ in range(2)]))
assert sum(bool(x and x.get('batch_complete')) for x in results)==1,results
facts=one("select facts from deliveries where request_id=%s and kind='report'",[r]);answers=facts['happened']['results']
assert len(answers)==5 and all(x['outcome']=='answered' and x['detail'].startswith('CURRENT') for x in answers),answers
assert '_comparison_result'not in facts
print('PASS overlapping settlements: one delivery and fresh content from every settled call')

# Cancellation/expiry cannot strand provider results or resurrect an old errand.
for state in ('cancelled','expired'):
    u,r,calls=batch(1)
    # Deliberately leave dispatch active, as cancellation can race submission.
    c.execute("update requests set state=%s,comparison_dispatching=true,comparison_dispatch_until=now()+interval '10 minutes' where id=%s",[state,r])
    c.execute("update calls set status='completed',provider_result='{}',outputs='{}' where id=%s",[calls[0]])
    result=settle(calls[0]);assert result['ok']and result.get('suppressed'),result
    assert one('select settled_at is not null from calls where id=%s',[calls[0]])
    assert one('select state from requests where id=%s',[r])==state
    assert one('select count(*) from deliveries where request_id=%s',[r])==0
print('PASS ended batches settle without delivery or resurrection, even during dispatch')
# A fast result followed by a newer message must not rewind the batch to confirming.
u,r,calls=batch(1)
c.execute("update calls set status='completed',provider_result='{}',provider_call_id=%s where id=%s",['synthetic-'+calls[0],calls[0]])
one('select defer_changed_consent(%s)',[r])
assert one('select state from requests where id=%s',[r])=='calling_1'
print('PASS completed early result survives newer-message release without request rewind')

# Superseded dispatch must leave durable notice, with stable IDs/names.
u,r,calls=batch(2)
one('select interrupt_comparison_dispatch(%s)',[r]);one('select interrupt_comparison_dispatch(%s)',[r])
assert one("select count(*) from deliveries where request_id=%s and kind='notice'",[r])==1
print('PASS interrupted dispatch queues exactly one status notice')

# Both webhook and recovery use the same finish_provider_call trigger.
u,r,calls=batch(1);call=calls[0]
provider={'callId':call,'attemptId':'synthetic-'+call,'status':'completed','durationS':1,'interactionId':'synthetic-recording','outputs':{'answer':'yes'}}
one('select finish_provider_call(%s)',[Jsonb(provider)])
assert one('select count(*) from call_audio_jobs where call_id=%s',[call])==1
jobs=one('select take_audio_jobs()');job=next(x for x in jobs if x['call_id']==call)
assert one('select finish_audio_job(%s,%s,false)',[call,job['token']])is False
assert one('select next_attempt_at>now() from call_audio_jobs where call_id=%s',[call])
c.execute('update call_audio_jobs set next_attempt_at=now() where call_id=%s',[call]);job=next(x for x in one('select take_audio_jobs()')if x['call_id']==call)
assert one('select finish_audio_job(%s,%s,true)',[call,job['token']])is True
assert one('select audio_path from calls where id=%s',[call])==call+'.wav'
# Once retention expires, bytes are removed by the worker, not just a DB field.
c.execute("update calls set created_at=now()-interval '10 years' where id=%s",[call]);one('select prepare_audio_cleanup()')
assert one('select count(*) from call_audio_deletions where path=%s',[call+'.wav'])==1
print('PASS delayed recording retry, durable completion, retention tombstone')
# Cascaded deletion must queue deterministic path even after upload-before-ack crash.
u2,r2,calls2=batch(1);call2=calls2[0]
c.execute('delete from calls where id=%s',[call2])
assert one('select count(*) from call_audio_deletions where path=%s',[call2+'.wav'])==1
print('PASS cascade/account deletion preserves orphan-upload cleanup tombstone')
# Erasure waits on a live archive lease; no new work may claim after deletion starts.
u3,r3,calls3=batch(1);call3=calls3[0]
provider['callId']=call3;provider['attemptId']='synthetic-'+call3
one('select finish_provider_call(%s)',[Jsonb(provider)])
c.execute('update calls set settled_at=now() where id=%s',[call3])
job=next(x for x in one('select take_audio_jobs()')if x['call_id']==call3)
c.execute("update users set delete_requested_at=now()-interval '2 minutes' where id=%s",[u3])
one('select erase_requested_users()')
assert one('select count(*) from users where id=%s',[u3])==1
assert one('select finish_audio_job(%s,%s,true)',[call3,job['token']])is False
assert one('select count(*) from call_audio_deletions where path=%s',[call3+'.wav'])==1
one('select erase_requested_users()')
assert one('select count(*) from users where id=%s',[u3])==0
print('PASS erasure waits for leased uploads, rejects saved audio after deletion, keeps tombstones')
print('ALL REVIEW DB REGRESSIONS PASS, synthetic data only')
