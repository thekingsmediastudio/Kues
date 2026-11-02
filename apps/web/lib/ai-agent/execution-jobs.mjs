import crypto from "node:crypto";
import { withWriteTransaction } from "../db/transaction.mjs";
import { LibraryError, libraryScope } from "./workspace-storage.mjs";
import {
  createFreestyleExecutor,
  executionDigest,
  collectExecutionResult,
} from "./freestyle-executor.mjs";
const ACTIVE = ["queued", "running"];
const id = () => "job_" + crypto.randomBytes(16).toString("hex");
const token = () => crypto.randomBytes(24).toString("hex");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const scopeArgs = (s) => [s.userId, s.workspaceId, s.agent.id];
const slug = (jobId) => "keus-" + jobId.replace("job_", "");
const scopeOf = (row) => ({
  userId: row.user_id,
  workspaceId: row.workspace_id,
  agent: { id: row.agent_id },
});
export function createExecutionJobs({
  db,
  library,
  client,
  apiKey = "",
  snapshotId,
  encryptionKey,
  resolveScope,
  now = Date.now,
  executorFactory = createFreestyleExecutor,
  schedule = (fn) => queueMicrotask(fn),
} = {}) {
  const key = Buffer.from(encryptionKey || "", "base64");
  if (!db || !library || !client || !resolveScope || key.length !== 32)
    throw new LibraryError("execution_not_configured", 503);
  const seal = (value, aad) => {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([
      c.update(JSON.stringify(value), "utf8"),
      c.final(),
    ]);
    return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString("base64");
  };
  const open = (cipher, aad) => {
    const b = Buffer.from(cipher, "base64"),
      d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"),
    );
  };
  const aad = (row) =>
    JSON.stringify([row.id, row.user_id, row.workspace_id, row.agent_id]);
  async function get(scope, jobId) {
    libraryScope(scope);
    if (!/^job_[a-f0-9]{32}$/.test(String(jobId)))
      throw new LibraryError("execution_job_unavailable", 404);
    const r = await db.execute({
      sql: "SELECT * FROM execution_jobs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
      args: [jobId, ...scopeArgs(scope)],
    });
    if (!r.rows[0]) throw new LibraryError("execution_job_unavailable", 404);
    return r.rows[0];
  }
  async function live(scope) {
    const fresh = await resolveScope(scope);
    if (
      !fresh ||
      libraryScope(fresh) !== libraryScope(scope) ||
      fresh.agent.settings?.toolPermissions?.run_code !== true
    )
      throw new LibraryError("execution_permission_required", 403);
    return fresh;
  }
  function view(row, details = false) {
    return {
      id: row.id,
      state: row.state,
      digest: row.digest,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      error: row.error_code || null,
      cleanupPending: Boolean(row.cleanup_pending),
      ...(details && row.plan_cipher && row.state === "prepared"
        ? { review: open(row.plan_cipher, aad(row)) }
        : {}),
      ...(details && row.result_cipher
        ? { result: open(row.result_cipher, aad(row)) }
        : {}),
    };
  }
  async function loadInputs(scope, refs) {
    const list = [];
    for (const ref of refs) {
      const file = await library.download(scope, ref.id);
      if (file.size > 2 * 1024 * 1024)
        throw new LibraryError("execution_input_invalid");
      const name =
        "input_" +
        (list.length + 1) +
        (file.path.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || ".bin");
      const digest = sha(file.bytes);
      if (ref.sha256 && ref.sha256 !== digest)
        throw new LibraryError("execution_input_changed", 409);
      list.push({
        id: file.id,
        path: file.path,
        name,
        sha256: digest,
        size: file.size,
        bytes: Buffer.from(file.bytes),
      });
    }
    return list;
  }
  async function authorized(scope, jobId, lease, digest) {
    try {
      await live(scope);
      const row = await get(scope, jobId);
      return (
        ACTIVE.includes(row.state) &&
        row.lease_token === lease &&
        Number(row.lease_until) > now() &&
        !row.cancel_requested &&
        row.digest === digest
      );
    } catch {
      return false;
    }
  }
  async function updateOwned(jobId, lease, sql, args = []) {
    return db.execute({
      sql: `UPDATE execution_jobs SET ${sql},updated_at=? WHERE id=? AND lease_token=?`,
      args: [...args, now(), jobId, lease],
    });
  }
  async function execute(scope, jobId, lease) {
    try {
      const row = await get(scope, jobId),
        plan = open(row.plan_cipher, aad(row));
      const fresh = await live(scope);
      const loaded = await loadInputs(fresh, plan.inputs);
      if (executionDigest(fresh, plan.code, loaded) !== row.digest)
        throw new LibraryError("execution_input_changed", 409);
      const executor = executorFactory({
        ...(apiKey ? { apiKey } : { client }),
        snapshotId,
        authorize: (s, d) => authorized(s, jobId, lease, d),
        reserve: async () => ({
          slug: slug(jobId),
          markProvisioning: async () => {
            const r = await db.execute({
              sql: "UPDATE execution_jobs SET cleanup_pending=1 WHERE id=? AND lease_token=? AND cancel_requested=0 AND state='queued'",
              args: [jobId, lease],
            });
            if (!r.rowsAffected)
              throw new LibraryError("execution_canceled", 409);
          },
          recordVm: async (vmId) => {
            if (typeof vmId !== "string" || !vmId)
              throw new LibraryError("execution_provider_failed", 502);
            const r = await updateOwned(
              jobId,
              lease,
              "vm_id=?,state=CASE WHEN cancel_requested=1 THEN 'canceling' ELSE 'running' END,cleanup_pending=1",
              [vmId],
            );
            if (!r.rowsAffected)
              throw new LibraryError("execution_lease_lost", 409);
          },
          markCleaned: () => updateOwned(jobId, lease, "cleanup_pending=0"),
          markCleanupFailed: () =>
            updateOwned(jobId, lease, "cleanup_pending=1"),
        }),
        persistResult: async (s, l, result) => {
          const current = await get(scope, jobId);
          if (current.cancel_requested || current.lease_token !== lease)
            throw new LibraryError("execution_canceled", 409);
          const r = await db.execute({
            sql: "UPDATE execution_jobs SET state='completed',result_cipher=?,plan_cipher=NULL,updated_at=? WHERE id=? AND lease_token=? AND cancel_requested=0 AND state IN ('queued','running')",
            args: [seal(result, aad(current)), now(), jobId, lease],
          });
          if (!r.rowsAffected)
            throw new LibraryError("execution_lease_lost", 409);
        },
      });
      await executor.run(fresh, { code: plan.code, inputs: loaded });
    } catch (error) {
      try {
        const row = await get(scope, jobId);
        if (ACTIVE.includes(row.state) || row.state === "canceling")
          await updateOwned(
            jobId,
            lease,
            "state=?,error_code=?,plan_cipher=NULL",
            [
              row.cancel_requested ? "canceled" : "failed",
              error instanceof LibraryError ? error.code : "execution_failed",
            ],
          );
      } catch {
        /* Keep the durable lease and VM recovery record when the DB is unavailable. */
      }
    }
  }
  let recovering = false;
  async function recover() {
    if (recovering) return;
    recovering = true;
    try {
      await db.execute({
        sql: "UPDATE execution_jobs SET state='expired',plan_cipher=NULL,updated_at=? WHERE state='prepared' AND prepare_expires_at<=?",
        args: [now(), now()],
      });
      await db.execute({
        sql: "DELETE FROM execution_jobs WHERE state IN ('completed','failed','canceled','expired','interrupted') AND cleanup_pending=0 AND updated_at<?",
        args: [now() - 30 * 86400000],
      });
      await db.execute({
        sql: "DELETE FROM execution_budget_counters WHERE updated_at<?",
        args: [now() - 90 * 86400000],
      });
      const rows = (
        await db.execute({
          sql: "SELECT * FROM execution_jobs WHERE approved_at IS NOT NULL AND ((state IN ('queued','running','canceling') AND lease_until<=?) OR (cleanup_pending=1 AND state NOT IN ('queued','running'))) LIMIT 20",
          args: [now()],
        })
      ).rows;
      for (const old of rows) {
        const scope = scopeOf(old),
          lease = token();
        const claimed = await db.execute({
          sql: "UPDATE execution_jobs SET lease_token=?,lease_until=? WHERE id=? AND lease_token=? AND lease_until<=?",
          args: [lease, now() + 60000, old.id, old.lease_token, now()],
        });
        if (!claimed.rowsAffected) continue;
        if (!old.vm_id && !old.cleanup_pending) {
          await updateOwned(
            old.id,
            lease,
            "state=?,plan_cipher=NULL,error_code='execution_interrupted_before_start'",
            [old.cancel_requested ? "canceled" : "interrupted"],
          );
          continue;
        }
        const vm = client.vms.ref(old.vm_id || slug(old.id));
        let exists = false;
        try {
          const state = await vm.data();
          exists = true;
          if (!old.vm_id) {
            await updateOwned(old.id, lease, "vm_id=?", [state.id || vm.id]);
          }
          let permitted = false;
          try {
            await live(scope);
            permitted = true;
          } catch {}
          if (
            !old.cancel_requested &&
            permitted &&
            ["queued", "running", "failed", "interrupted"].includes(old.state)
          ) {
            let result;
            try {
              result = await collectExecutionResult(vm, old.digest);
            } catch {
              await updateOwned(
                old.id,
                lease,
                "state=CASE WHEN cancel_requested=1 THEN 'canceled' ELSE 'interrupted' END,error_code='execution_interrupted',plan_cipher=NULL",
              );
            }
            if (result)
              await db.execute({
                sql: "UPDATE execution_jobs SET state='completed',result_cipher=?,plan_cipher=NULL,error_code=NULL,updated_at=? WHERE id=? AND lease_token=? AND cancel_requested=0",
                args: [seal(result, aad(old)), now(), old.id, lease],
              });
          } else if (ACTIVE.includes(old.state) || old.state === "canceling")
            await updateOwned(
              old.id,
              lease,
              "state='canceled',error_code='execution_canceled',plan_cipher=NULL",
            );
          await vm.delete();
          await updateOwned(
            old.id,
            lease,
            "cleanup_pending=0,state=CASE WHEN cancel_requested=1 AND state='canceling' THEN 'canceled' ELSE state END",
          );
        } catch (error) {
          const missing = error?.status === 404 || error?.statusCode === 404;
          if (missing && old.vm_id) {
            await updateOwned(
              old.id,
              lease,
              "state=CASE WHEN state IN ('queued','running','canceling') THEN 'interrupted' ELSE state END,cleanup_pending=0,plan_cipher=NULL,error_code=CASE WHEN state IN ('queued','running','canceling') THEN 'execution_vm_unavailable' ELSE error_code END",
            );
          } else
            await updateOwned(
              old.id,
              lease,
              "cleanup_pending=1,error_code=?,state=CASE WHEN state IN ('queued','running') THEN 'interrupted' ELSE state END",
              [
                exists
                  ? "execution_cleanup_pending"
                  : "execution_provisioning_uncertain",
              ],
            );
        }
      }
    } finally {
      recovering = false;
    }
  }
  return {
    configured: true,
    async prepare(scope, { code, fileIds = [] } = {}) {
      const fresh = await live(scope);
      if (
        typeof code !== "string" ||
        !code.trim() ||
        code.length > 20000 ||
        !Array.isArray(fileIds) ||
        fileIds.length > 3 ||
        new Set(fileIds).size !== fileIds.length ||
        fileIds.some((v) => typeof v !== "string")
      )
        throw new LibraryError("execution_input_invalid");
      const loaded = await loadInputs(
        fresh,
        fileIds.map((id) => ({ id })),
      );
      await live(scope);
      const row = {
        id: id(),
        user_id: scope.userId,
        workspace_id: scope.workspaceId,
        agent_id: scope.agent.id,
      };
      const plan = {
        code,
        inputs: loaded.map(({ bytes, ...f }) => f),
        language: "python",
        maxRunSeconds: 120,
      };
      const digest = executionDigest(fresh, code, loaded),
        stamp = now();
      await withWriteTransaction(db, async (tx) => {
        const n = await tx.execute({
          sql: "SELECT count(*) AS n FROM execution_jobs WHERE user_id=? AND state='prepared' AND prepare_expires_at>?",
          args: [scope.userId, stamp],
        });
        if (Number(n.rows[0].n) >= 5)
          throw new LibraryError("execution_review_limit", 429);
        await tx.execute({
          sql: "INSERT INTO execution_jobs(id,user_id,workspace_id,agent_id,state,digest,plan_cipher,created_at,updated_at,prepare_expires_at) VALUES(?,?,?,?,'prepared',?,?,?,?,?)",
          args: [
            row.id,
            ...scopeArgs(scope),
            digest,
            seal(plan, aad(row)),
            stamp,
            stamp,
            stamp + 10 * 60000,
          ],
        });
      });
      return view(await get(scope, row.id), true);
    },
    async approve(scope, { id: jobId, digest } = {}) {
      await live(scope);
      const lease = token();
      const decision = await withWriteTransaction(db, async (tx) => {
        const r = await tx.execute({
          sql: "SELECT * FROM execution_jobs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
          args: [jobId, ...scopeArgs(scope)],
        });
        const row = r.rows[0];
        if (!row) throw new LibraryError("execution_job_unavailable", 404);
        if (row.digest !== digest)
          throw new LibraryError("execution_review_changed", 409);
        if (row.state !== "prepared") {
          if (row.approved_at !== null) return false;
          throw new LibraryError("execution_review_expired", 409);
        }
        if (Number(row.prepare_expires_at) <= now())
          throw new LibraryError("execution_review_expired", 409);
        const active = await tx.execute(
          "SELECT count(*) AS n FROM execution_jobs WHERE state IN ('queued','running','canceling') OR cleanup_pending=1",
        );
        if (Number(active.rows[0].n) >= 2)
          throw new LibraryError("execution_busy", 429);
        const date = new Date(now()).toISOString(),
          keys = [
            ["month:" + date.slice(0, 7), 100],
            [
              "day:" + sha(Buffer.from(scope.userId)) + ":" + date.slice(0, 10),
              10,
            ],
          ];
        for (const [k, max] of keys) {
          await tx.execute({
            sql: "INSERT INTO execution_budget_counters(budget_key,used,updated_at) VALUES(?,0,?) ON CONFLICT(budget_key) DO NOTHING",
            args: [k, now()],
          });
          const count = await tx.execute({
            sql: "SELECT used FROM execution_budget_counters WHERE budget_key=?",
            args: [k],
          });
          if (Number(count.rows[0].used) >= max)
            throw new LibraryError("execution_budget_exhausted", 429);
          await tx.execute({
            sql: "UPDATE execution_budget_counters SET used=used+1,updated_at=? WHERE budget_key=?",
            args: [now(), k],
          });
        }
        await tx.execute({
          sql: "UPDATE execution_jobs SET state='queued',approved_at=?,lease_token=?,lease_until=?,cleanup_pending=0,updated_at=? WHERE id=?",
          args: [now(), lease, now() + 240000, now(), jobId],
        });
        return true;
      });
      if (decision) schedule(() => execute(scope, jobId, lease));
      return view(await get(scope, jobId), true);
    },
    async list(scope) {
      libraryScope(scope);
      const r = await db.execute({
        sql: "SELECT * FROM execution_jobs WHERE user_id=? AND workspace_id=? AND agent_id=? ORDER BY created_at DESC,id DESC LIMIT 20",
        args: scopeArgs(scope),
      });
      return r.rows.map((r) => view(r));
    },
    async get(scope, jobId) {
      return view(await get(scope, jobId), true);
    },
    async cancel(scope, jobId) {
      libraryScope(scope);
      const row = await withWriteTransaction(db, async (tx) => {
        const found = await tx.execute({
          sql: "SELECT * FROM execution_jobs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
          args: [jobId, ...scopeArgs(scope)],
        });
        const current = found.rows[0];
        if (!current) throw new LibraryError("execution_job_unavailable", 404);
        if (current.state === "prepared")
          await tx.execute({
            sql: "UPDATE execution_jobs SET state='canceled',plan_cipher=NULL,updated_at=? WHERE id=?",
            args: [now(), jobId],
          });
        else if (
          ACTIVE.includes(current.state) ||
          current.state === "canceling"
        )
          await tx.execute({
            sql: "UPDATE execution_jobs SET cancel_requested=1,state='canceling',updated_at=? WHERE id=?",
            args: [now(), jobId],
          });
        return current;
      });
      if (!ACTIVE.includes(row.state) && row.state !== "canceling")
        return view(await get(scope, jobId));

      if (row.vm_id) {
        try {
          await client.vms.ref(row.vm_id).delete();
          await db.execute({
            sql: "UPDATE execution_jobs SET state='canceled',cleanup_pending=0,plan_cipher=NULL,error_code='execution_canceled',updated_at=? WHERE id=? AND cancel_requested=1",
            args: [now(), jobId],
          });
        } catch {}
      }
      return view(await get(scope, jobId));
    },
    recover,
  };
}
