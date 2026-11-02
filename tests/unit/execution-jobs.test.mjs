import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionJobs } from "../../apps/web/lib/ai-agent/execution-jobs.mjs";
const migration = await fs.readFile(
  new URL("../../apps/web/migrations/0013_execution_jobs.sql", import.meta.url),
  "utf8",
);
const scope = {
  userId: "user-a",
  workspaceId: "workspace-a",
  agent: {
    id: "agent-a",
    settings: { toolPermissions: { run_code: true, read_files: true } },
  },
};
const encryptionKey = Buffer.alloc(32, 9).toString("base64");
function provider() {
  const all = new Map(),
    calls = [];
  return {
    calls,
    all,
    vms: {
      async create(opts) {
        calls.push(opts);
        const id = "vm-" + calls.length;
        let deleted = false;
        const data = {
          id,
          resources: { cpu: 4, memory: 8192, storage: 32768 },
          maxRunSeconds: 180,
          maxRunTotalSeconds: 180,
          ttlSeconds: 600,
        };
        const vm = {
          id,
          async data() {
            if (deleted) throw { status: 404 };
            return data;
          },
          async firewallRules() {
            return { rules: [], totalCount: 0 };
          },
          async exec() {
            return { statusCode: 0 };
          },
          async delete() {
            deleted = true;
          },
          async pause() {},
          fs: {
            async mkdir() {},
            async writeFile() {},
            async readFile(p) {
              return Buffer.from(
                p.includes("exit") ? "0" : p.includes("stdout") ? "450\n" : "",
              );
            },
          },
        };
        all.set(id, vm);
        all.set(opts.slug, vm);
        return { vm };
      },
      ref(id) {
        return (
          all.get(id) || {
            id,
            async data() {
              throw { status: 404 };
            },
            async delete() {
              throw { status: 404 };
            },
          }
        );
      },
    },
  };
}
async function setup(t, { url = "file::memory:" } = {}) {
  const db = createClient({ url });
  await db.executeMultiple(migration);
  t.after(() => db.close());
  const client = provider(),
    tasks = [];
  let time = Date.parse("2026-11-02T12:00:00Z"),
    allowed = true,
    input = Buffer.from("450");
  const options = {
    db,
    client,
    encryptionKey,
    library: {
      async download(s, id) {
        assert.equal(id, "saved-one");
        return { id, path: "budget.csv", size: input.length, bytes: input };
      },
    },
    resolveScope: async (s) => ({
      ...s,
      agent: {
        ...s.agent,
        settings: {
          toolPermissions: { run_code: allowed, read_files: allowed },
        },
      },
    }),
    now: () => time,
    schedule: (f) => tasks.push(f),
  };
  return {
    db,
    client,
    tasks,
    options,
    service: createExecutionJobs(options),
    advance: (ms) => (time += ms),
    revoke: () => (allowed = false),
    changeInput: () => (input = Buffer.from("999")),
  };
}
async function prepare(h, extra = {}) {
  return h.service.prepare(scope, {
    code: "print(450)",
    fileIds: ["saved-one"],
    ...extra,
  });
}
test("durable review binds exact inputs and encrypts code; approval replay creates one VM", async (t) => {
  const h = await setup(t);
  const p = await prepare(h, { code: 'print("private-code-marker")' });
  assert.equal(p.review.inputs[0].name, "input_1.csv");
  const raw = (await h.db.execute("SELECT plan_cipher FROM execution_jobs"))
    .rows[0].plan_cipher;
  assert(!raw.includes("private-code-marker"));
  await assert.rejects(
    h.service.approve(scope, { id: p.id, digest: "changed" }),
    (e) => e.code === "execution_review_changed",
  );
  assert.equal(h.client.calls.length, 0);
  await Promise.all([h.service.approve(scope, p), h.service.approve(scope, p)]);
  assert.equal(h.tasks.length, 1);
  await h.tasks.shift()();
  const result = await h.service.get(scope, p.id);
  assert.equal(result.state, "completed");
  assert.equal(result.result.stdout, "450\n");
  assert.equal(result.cleanupPending, false);
  assert.equal(h.client.calls.length, 1);
  assert.equal(
    (
      await h.db.execute(
        "SELECT used FROM execution_budget_counters WHERE budget_key LIKE 'month:%'",
      )
    ).rows[0].used,
    1,
  );
});
test("jobs remain scoped to user, workspace and agent after service recreation", async (t) => {
  const h = await setup(t);
  const p = await prepare(h);
  const fresh = createExecutionJobs(h.options);
  assert.equal((await fresh.get(scope, p.id)).id, p.id);
  for (const other of [
    { ...scope, userId: "other" },
    { ...scope, workspaceId: "other" },
    { ...scope, agent: { ...scope.agent, id: "other" } },
  ]) {
    await assert.rejects(
      fresh.get(other, p.id),
      (e) => e.code === "execution_job_unavailable",
    );
    assert.deepEqual(await fresh.list(other), []);
  }
});
test("changed original and revoked permission never reach cloud execution", async (t) => {
  for (const mode of ["input", "permission"]) {
    const h = await setup(t),
      p = await prepare(h);
    await h.service.approve(scope, p);
    mode === "input" ? h.changeInput() : h.revoke();
    await h.tasks.shift()();
    assert.equal(h.client.calls.length, 0);
    assert.equal((await h.service.get(scope, p.id)).state, "failed");
  }
});
test("expired reviews and cancellation cannot approve or start work", async (t) => {
  const h = await setup(t),
    p = await prepare(h);
  h.advance(600001);
  await assert.rejects(
    h.service.approve(scope, p),
    (e) => e.code === "execution_review_expired",
  );
  await h.service.recover();
  assert.equal((await h.service.get(scope, p.id)).state, "expired");
  const second = await prepare(h);
  await h.service.approve(scope, second);
  await h.service.cancel(scope, second.id);
  await h.tasks.shift()();
  assert.equal(h.client.calls.length, 0);
  const canceled = await h.service.get(scope, second.id);
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.cleanupPending, false);
});
test("two concurrent claims and global monthly quota are atomic across controllers", async (t) => {
  const h = await setup(t),
    other = createExecutionJobs(h.options);
  const plans = await Promise.all([prepare(h), prepare(h), prepare(h)]);
  const results = await Promise.allSettled(
    plans.map((p) => other.approve(scope, p)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    results.filter((r) => r.status === "rejected")[0].reason.code,
    "execution_busy",
  );
  for (const p of plans) await h.service.cancel(scope, p.id);
  while (h.tasks.length) await h.tasks.shift()();
  await h.db.execute(
    "UPDATE execution_budget_counters SET used=100 WHERE budget_key LIKE 'month:%'",
  );
  const p = await prepare(h);
  await assert.rejects(
    h.service.approve(scope, p),
    (e) => e.code === "execution_budget_exhausted",
  );
});
test("restart reconciliation collects an existing VM result but never executes code again", async (t) => {
  const h = await setup(t),
    p = await prepare(h);
  await h.service.approve(scope, p);
  const { vm } = await h.client.vms.create({
    slug: "keus-" + p.id.replace("job_", ""),
  });
  await h.db.execute({
    sql: "UPDATE execution_jobs SET state='running',vm_id=?,cleanup_pending=1 WHERE id=?",
    args: [vm.id, p.id],
  });
  h.tasks.length = 0;
  h.advance(240001);
  const recovered = createExecutionJobs(h.options);
  await recovered.recover();
  const row = await recovered.get(scope, p.id);
  assert.equal(row.state, "completed");
  assert.equal(row.result.stdout, "450\n");
  assert.equal(row.cleanupPending, false);
  assert.equal(h.client.calls.length, 1);
});
test("uncertain VM creation blocks another launch instead of silently retrying", async (t) => {
  const h = await setup(t),
    p = await prepare(h);
  await h.service.approve(scope, p);
  h.tasks.length = 0;
  await h.db.execute({
    sql: "UPDATE execution_jobs SET cleanup_pending=1 WHERE id=?",
    args: [p.id],
  });
  h.advance(240001);
  await h.service.recover();
  const state = await h.service.get(scope, p.id);
  assert.equal(state.state, "interrupted");
  assert.equal(state.cleanupPending, true);
  assert.equal(state.error, "execution_provisioning_uncertain");
  assert.equal(h.client.calls.length, 0);
  await h.service.approve(scope, p);
  assert.equal(h.tasks.length, 0);
});
test("completed encrypted output survives a real SQLite close and reopen", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keus-jobs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const url = "file:" + path.join(dir, "jobs.db");
  const h = await setup(t, { url }),
    p = await prepare(h);
  await h.service.approve(scope, p);
  await h.tasks.shift()();
  h.db.close();
  const db = createClient({ url });
  t.after(() => db.close());
  const reopened = createExecutionJobs({ ...h.options, db });
  assert.equal((await reopened.get(scope, p.id)).result.stdout, "450\n");
  assert(
    !JSON.stringify(
      (await db.execute("SELECT result_cipher FROM execution_jobs")).rows,
    ).includes("450\\n"),
  );
});

test("concurrent cancel and approve never discard the cancellation", async (t) => {
  const h = await setup(t),
    p = await prepare(h);
  await Promise.allSettled([
    h.service.approve(scope, p),
    h.service.cancel(scope, p.id),
  ]);
  while (h.tasks.length) await h.tasks.shift()();
  assert.equal((await h.service.get(scope, p.id)).state, "canceled");
  assert.equal(h.client.calls.length, 0);
});
test("recovery keeps a VM when durable result persistence fails", async (t) => {
  const h = await setup(t),
    p = await prepare(h);
  await h.service.approve(scope, p);
  const { vm } = await h.client.vms.create({
    slug: "keus-" + p.id.replace("job_", ""),
  });
  await h.db.execute({
    sql: "UPDATE execution_jobs SET state='running',vm_id=?,cleanup_pending=1 WHERE id=?",
    args: [vm.id, p.id],
  });
  h.tasks.length = 0;
  h.advance(240001);
  let failed = false;
  const wrapped = {
    transaction: (...args) => h.db.transaction(...args),
    execute: async (statement) => {
      if (
        !failed &&
        String(statement.sql || statement).includes(
          "state='completed',result_cipher",
        )
      ) {
        failed = true;
        throw Error("transient persistence failure");
      }
      return h.db.execute(statement);
    },
  };
  await createExecutionJobs({ ...h.options, db: wrapped }).recover();
  assert(failed);
  await assert.doesNotReject(vm.data());
  assert.equal((await h.service.get(scope, p.id)).cleanupPending, true);
  h.advance(60001);
  await h.service.recover();
  assert.equal((await h.service.get(scope, p.id)).state, "completed");
});
