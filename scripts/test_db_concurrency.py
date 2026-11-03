"""Exercise overlapping database sessions against the local Supabase Docker container."""
import argparse
import json
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--database", default="postgres")
args = parser.parse_args()
if args.database != "postgres" and not args.database.startswith("desk_verify_"):
    raise SystemExit("Only the isolated local database is supported")

base = ["docker", "--host=unix:///var/run/docker.sock", "exec", "-i", "supabase_db_the-desk",
        "psql", "-U", "postgres", "-d", args.database, "-Atq", "-v", "ON_ERROR_STOP=1"]


def sql(statement):
    result = subprocess.run(base, input=statement, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def overlapping(first, second):
    worker = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    worker.stdin.write("begin; " + first + "; select pg_sleep(2); commit;\n")
    worker.stdin.close()
    # psql flushes the selected value before sleeping while the row/advisory lock is held.
    value = worker.stdout.readline().strip()
    other = sql(second)
    worker.wait(timeout=15)
    if worker.returncode:
        raise AssertionError(worker.stderr.read())
    return value, other


uid, rid, biz, num, call, delivery, prompt = [str(uuid.uuid4()) for _ in range(7)]
wa = "concurrency-" + uid
phone = "+91" + str(1_000_000_000 + int(uuid.uuid4().hex[:8], 16) % 8_000_000_000)
try:
    sql(f"""
      insert into users(id,wa_id) values('{uid}','{wa}');
      insert into businesses(id,name,phone_e164,source) values('{biz}','Local test','{phone}','user');
      insert into caller_numbers(id,e164,provider) values('{num}','{phone}','sarvam');
      insert into requests(id,user_id,task,state,business_id) values('{rid}','{uid}','question','confirming','{biz}');
      insert into calls(id,user_id,request_id,business_id,caller_number_id,kind,agent_version,status)
        values('{call}','{uid}','{rid}','{biz}','{num}','question','test','completed');
      insert into deliveries(id,user_id,call_id,dedupe_key,kind,message,next_attempt_at)
        values('{delivery}','{uid}','{call}','concurrency:{delivery}','report','{{"kind":"text","body":"test"}}','2000-01-01');
    """)
    now = "2026-11-03 12:00:00Z"
    first, second = overlapping(f"select take_deliveries('{now}',1,'{call}')",
                                f"select take_deliveries('{now}',1,'{call}');")
    assert len(json.loads(first)) == 1, first
    assert json.loads(second) == [], second
    print("Concurrent send workers: exactly one owns the delivery")

    sql(f"""select open_prompt('{prompt}','{rid}','ask','{{}}','yes','Call?','{{}}');
      select ingest_inbound('{uid}','{wa}:yes','{{"text":{{"body":"yes"}}}}',now());""")
    watermark = int(sql(f"select seq from messages where wa_message_id='{wa}:yes';"))
    first, second = overlapping(
        f"select ingest_inbound('{uid}','{wa}:wait','{{\"text\":{{\"body\":\"wait\"}}}}',now())",
        f"select record_consent('{prompt}',null,'yes','{wa}:yes',now(),'{{\"input_seq\":{watermark}}}')->>'reason';")
    assert second == "new_inbound", second
    print("Concurrent correction and approval: stale approval refused under the user lock")
    missing = sql(f"begin; set local role service_role; select record_consent('{prompt}',null,'yes','{wa}:yes')->>'reason'; rollback;")
    assert missing == "missing_watermark", missing
    print("Service-role RPC cannot approve without an inbox watermark")
finally:
    sql(f"""delete from deliveries where user_id='{uid}';
      delete from users where id='{uid}';
      delete from businesses where id='{biz}';
      delete from caller_numbers where id='{num}';""")
