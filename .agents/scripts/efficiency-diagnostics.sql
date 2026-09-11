-- Agent efficiency diagnostics — ad-hoc "efficiency monitor" at current data fidelity.
-- Run: sqlite3 -json zmrng.db < .agents/scripts/efficiency-diagnostics.sql
-- This IS the tool until task volume outgrows eyeballing. See
-- .agents/plans/agent-efficiency-monitor-grill.md "Empirical premise test".

.print === Q1: cost by model/effort/flow (opus-on-direct leak test) ===
SELECT model, effort, flow, count(*) AS n,
       ROUND(AVG(tokens_in+tokens_out)) AS avg_tok,
       ROUND(SUM(cost_usd),2) AS sum_cost, ROUND(AVG(turns),1) AS avg_turns
FROM tasks GROUP BY model, effort, flow ORDER BY sum_cost DESC;

.print === Q2: per-task tool calls vs turns vs tokens ===
SELECT substr(t.id,1,8) AS id, t.model AS m, t.flow AS fl, t.status AS st, t.turns,
       (SELECT count(*) FROM events e WHERE e.task_id=t.id
          AND json_extract(e.payload,'$.sub')='tool') AS tools,
       (t.tokens_in+t.tokens_out) AS tok, substr(t.title,1,34) AS title
FROM tasks t ORDER BY tools DESC LIMIT 20;

.print === Q3: same-file re-read/re-edit thrash (>=4x, FULL path) ===
SELECT substr(task_id,1,8) AS id, json_extract(payload,'$.tool') AS tool,
       count(*) AS reps, json_extract(payload,'$.summary') AS full_path
FROM events WHERE json_extract(payload,'$.sub')='tool'
GROUP BY task_id, json_extract(payload,'$.tool'), json_extract(payload,'$.summary')
HAVING reps>=4 ORDER BY reps DESC LIMIT 20;

.print === Q4: overall tool-name histogram (Bash-dominance / Skill tax) ===
SELECT json_extract(payload,'$.tool') AS tool, count(*) AS n
FROM events WHERE json_extract(payload,'$.sub')='tool'
GROUP BY tool ORDER BY n DESC;

-- KNOWN BLIND SPOTS (see plan): isError only on 'result' events, actor always 'main',
-- turns counts result-boundaries not effort. Failed-tool-call + subagent-thrash detection
-- need a capture fix in runner.ts first (surface main-worker tool_result + isError).
