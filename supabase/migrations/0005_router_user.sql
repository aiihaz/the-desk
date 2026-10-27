-- The daily redirect cap (E4 design L1) counts router_log rows per user. message_id can't
-- carry that: it is null when the inbound message isn't stored (dev bench, evals).
alter table router_log add column user_id uuid references users on delete cascade;
create index router_log_redirects_idx on router_log (user_id, at) where mode = 'redirect';
