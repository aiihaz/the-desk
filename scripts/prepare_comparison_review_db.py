"""Restore a schema-only export to a NEW isolated local database for review tests.
Never exports or reads any private production rows. Requires pgserver and psycopg.
Usage: python scripts/prepare_comparison_review_db.py SCHEMA.sql CONFIG.json URI_OUT
CONFIG.json is the prior explicit limits/caller_contract configuration export.
"""
import json
import pathlib
import sys
import uuid
import pgserver
import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

schema, config, output = map(pathlib.Path, sys.argv[1:])
server = pgserver.get_server('/tmp/desk-comparison-review-local', cleanup_mode=None)
base = server.get_uri()
name = 'desk_review_' + uuid.uuid4().hex
with psycopg.connect(base, autocommit=True) as admin:
    for role in ('anon', 'authenticated', 'service_role'):
        if not admin.execute('select 1 from pg_roles where rolname=%s', [role]).fetchone():
            admin.execute('create role ' + role)
    admin.execute('create database ' + name)
uri = make_conninfo(base, dbname=name)
with psycopg.connect(uri, autocommit=True) as db:
    db.execute('create schema storage; create table storage.buckets(id text primary key,name text,public boolean);drop schema public cascade;')
    # pg_dump 17 setting is unavailable in the bundled local PostgreSQL 16 build.
    text = '\n'.join(line for line in schema.read_text().splitlines()
                     if not line.startswith('\\') and not line.startswith('SET transaction_timeout'))
    db.execute(text)
    db.execute('set search_path=public')
    for item in json.loads(config.read_text()):
        if item['kind'] not in ('limits', 'caller_contract'):
            continue
        table, row = item['kind'], item['data']
        cols = list(row)
        jsoncols = [r[0] for r in db.execute("select column_name from information_schema.columns where table_schema='public' and table_name=%s and data_type in ('json','jsonb')", [table])]
        db.execute('insert into '+table+'('+','.join(cols)+')values('+','.join(['%s']*len(cols))+')',
                   [Jsonb(row[k]) if k in jsoncols else row[k] for k in cols])
    migrations = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
    for file in sorted(migrations.glob('*.sql')):
        if file.name[:4] >= '0031':
            db.execute(file.read_text())
            print('APPLIED', file.name)
output.write_text(uri)
print('Prepared new isolated local review database; URI saved to', output)
