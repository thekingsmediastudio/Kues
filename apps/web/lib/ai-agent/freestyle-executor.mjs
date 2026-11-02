// Called only through the durable job controller and explicit reviewed approval.
import crypto from "node:crypto";
import { Freestyle } from "freestyle";
import { libraryScope, LibraryError } from "./workspace-storage.mjs";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
export function executionDigest(scope, code, inputs) {
  return hash(
    JSON.stringify({
      scope: libraryScope(scope),
      code,
      inputs: inputs.map((f) => ({ name: f.name, sha256: hash(f.bytes) })),
    }),
  );
}
export function createFreestyleExecutor({
  apiKey = "",
  client,
  snapshotId,
  authorize,
  reserve,
  persistResult,
} = {}) {
  const configured = Boolean(
    (apiKey || client) && authorize && reserve && persistResult,
  );
  return {
    configured,
    async run(scope, { code, inputs = [] } = {}) {
      if (!configured) throw new LibraryError("execution_not_configured", 503);
      libraryScope(scope);
      if (scope.agent?.settings?.toolPermissions?.run_code !== true)
        throw new LibraryError("execution_permission_required", 403);
      if (
        typeof code !== "string" ||
        !code.trim() ||
        code.length > 20000 ||
        !Array.isArray(inputs) ||
        inputs.length > 3 ||
        inputs.some(
          (f) =>
            !f ||
            !Buffer.isBuffer(f.bytes) ||
            !f.bytes.length ||
            f.bytes.length > 2 * 1024 * 1024 ||
            typeof f.name !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(f.name),
        ) ||
        new Set(inputs.map((f) => f.name)).size !== inputs.length
      )
        throw new LibraryError("execution_input_invalid");
      inputs = inputs.map((file) => ({
        name: file.name,
        bytes: Buffer.from(file.bytes),
      }));
      const digest = executionDigest(scope, code, inputs);
      if ((await authorize(scope, digest)) !== true)
        throw new LibraryError("execution_approval_required", 403);
      // The controller must atomically reserve a persisted worst-case resource budget.
      // Reservations are not refunded here: uncertain network outcomes can consume quota.
      const lease = await reserve(scope, {
        digest,
        maxCpuSeconds: 720,
        maxMemoryGiBSeconds: 1440,
        maxStorageGiBSeconds: 19200,
      });
      if (
        !lease ||
        typeof lease.recordVm !== "function" ||
        typeof lease.markCleanupFailed !== "function"
      )
        throw new LibraryError("execution_budget_unavailable", 503);
      if ((await authorize(scope, digest)) !== true)
        throw new LibraryError("execution_approval_required", 403);
      const deadline = AbortSignal.timeout(210000);
      const remote =
        client ||
        new Freestyle({
          apiKey,
          fetch: (url, init = {}) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.any([
                deadline,
                AbortSignal.timeout(30000),
                ...(init.signal ? [init.signal] : []),
              ]),
            }),
        });
      let vm;
      let cleanupFailed = false;
      let persistenceFailed = false;
      try {
        await lease.markProvisioning?.();
        ({ vm } = await remote.vms.create({
          ...(lease.slug ? { slug: lease.slug } : {}),
          ...(snapshotId ? { snapshotId } : {}),
          firewall: { rules: [] },
          maxRunSeconds: 180,
          maxRunTotalSeconds: 180,
          ttlSeconds: 600,
          autoDeleteSeconds: 0,
          automaticRestart: false,
        }));
        await lease.recordVm(vm.id);
        const state = await vm.data(),
          rules = await vm.firewallRules();
        if (
          !Array.isArray(rules.rules) ||
          rules.rules.length ||
          rules.totalCount !== 0
        )
          throw new LibraryError("execution_network_not_isolated", 503);
        if (
          !state.resources ||
          ![
            state.resources.cpu,
            state.resources.memory,
            state.resources.storage,
          ].every((v) => Number.isFinite(v) && v > 0) ||
          state.resources.cpu > 4 ||
          state.resources.memory > 8192 ||
          state.resources.storage > 32768 ||
          !Number.isFinite(state.maxRunSeconds) ||
          state.maxRunSeconds < 1 ||
          state.maxRunSeconds > 180 ||
          !Number.isFinite(state.maxRunTotalSeconds) ||
          state.maxRunTotalSeconds < 1 ||
          state.maxRunTotalSeconds > 180 ||
          !Number.isFinite(state.ttlSeconds) ||
          state.ttlSeconds < 1 ||
          state.ttlSeconds > 600
        )
          throw new LibraryError("execution_limits_unconfirmed", 503);
        // No secrets, host filesystem, cloud storage key, or network allow-rules enter the VM.
        await vm.fs.mkdir("/tmp/keus-inputs");
        for (const file of inputs)
          await vm.fs.writeFile("/tmp/keus-inputs/" + file.name, file.bytes, {
            maxAttempts: 1,
            signal: deadline,
          });
        await vm.fs.writeFile("/tmp/keus-job.py", code, {
          maxAttempts: 1,
          signal: deadline,
        });
        if ((await authorize(scope, digest)) !== true)
          throw new LibraryError("execution_approval_required", 403);
        // Output redirected to VM files, then range-read to bound backend memory.
        const result = await vm.exec({
          command: `cd /tmp/keus-inputs && timeout -k 2 120 python3 -I /tmp/keus-job.py > /tmp/keus-stdout.txt 2> /tmp/keus-stderr.txt; printf '%s' "$?" > /tmp/keus-exit.txt`,
          timeoutMs: 130000,
        });
        const output = await collectExecutionResult(vm, digest, deadline);
        try {
          await persistResult(scope, lease, output);
        } catch (error) {
          persistenceFailed = true;
          throw error;
        }
        return output;
      } catch (error) {
        if (error instanceof LibraryError) throw error;
        throw new LibraryError("execution_provider_failed", 502);
      } finally {
        if (vm) {
          if (persistenceFailed) {
            try {
              await vm.pause();
            } catch {}
            await lease.markCleanupFailed();
          } else {
            try {
              await vm.delete();
              await lease.markCleaned?.();
            } catch {
              cleanupFailed = true;
            }
            if (cleanupFailed) await lease.markCleanupFailed();
          }
        }
      }
    },
  };
}

export async function collectExecutionResult(
  vm,
  digest,
  signal = AbortSignal.timeout(30000),
) {
  const exit = Buffer.from(
    await vm.fs.readFile("/tmp/keus-exit.txt", {
      offset: 0,
      length: 5,
      signal,
    }),
  ).toString("utf8");
  if (!/^\d{1,3}$/.test(exit) || Number(exit) > 255)
    throw new LibraryError("execution_result_incomplete", 409);
  const read = async (path) =>
    Buffer.from(
      await vm.fs.readFile(path, { offset: 0, length: 16001, signal }),
    );
  const [stdout, stderr] = await Promise.all([
    read("/tmp/keus-stdout.txt"),
    read("/tmp/keus-stderr.txt"),
  ]);
  return {
    digest,
    exitCode: Number(exit),
    stdout: stdout.subarray(0, 16000).toString("utf8"),
    stderr: stderr.subarray(0, 16000).toString("utf8"),
    truncated: stdout.length > 16000 || stderr.length > 16000,
  };
}
