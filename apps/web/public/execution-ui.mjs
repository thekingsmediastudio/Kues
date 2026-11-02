const copy = (code) =>
  ({
    execution_not_configured:
      "Cloud execution is not connected. No code has been run.",
    execution_permission_required:
      "Enable Run Python code in this agent’s Tools settings first.",
    execution_busy:
      "Two jobs or unresolved cleanups already occupy the execution slots. Wait or cancel a job.",
    execution_budget_exhausted:
      "The free-first run allowance has been reached. No paid fallback will be used.",
    execution_review_expired:
      "This review expired. Review the code again before running.",
    execution_review_changed:
      "The approval does not match the reviewed code and files.",
    execution_input_changed:
      "An input file changed after review. Prepare a fresh review.",
    execution_review_limit:
      "You have five pending reviews. Cancel one or wait ten minutes.",
    execution_input_invalid:
      "Use up to 20,000 characters of Python and up to three saved files, each at most 2 MB.",
    execution_provisioning_uncertain:
      "VM creation could not be confirmed. Automatic retries are blocked; cleanup needs verification.",
    execution_interrupted:
      "The run was interrupted. It will not be executed again automatically.",
    execution_vm_unavailable:
      "The execution machine expired or is unavailable. No automatic rerun.",
    execution_canceled: "Canceled. No automatic rerun.",
    execution_cleanup_pending:
      "Cleanup needs verification. A slot remains reserved.",
  })[code] ||
  "The request could not complete. Check the saved job state before trying again.";
export function createExecutionUI(adapter) {
  const style = document.createElement("style");
  style.textContent = `.execution-panel{position:fixed;z-index:20000;right:16px;top:90px;bottom:20px;width:min(580px,calc(100vw - 24px));box-sizing:border-box;padding:20px;background:#121416;color:#eee;border:1px solid #34383d;border-radius:16px;box-shadow:0 16px 64px #0009;overflow:auto;font:13px/1.5 system-ui}.execution-panel[hidden]{display:none}.execution-panel header{display:flex;align-items:center;justify-content:space-between}.execution-panel h2{font-size:20px;margin:0}.execution-panel p,.execution-panel small{color:#aeb4bb}.execution-panel textarea,.execution-panel select{display:block;width:100%;box-sizing:border-box;background:#0b0d10;border:1px solid #3b4045;color:#eee;border-radius:8px;padding:10px;margin:6px 0 12px;font:12px/1.5 ui-monospace,monospace}.execution-panel textarea{height:210px;resize:vertical}.execution-panel button{background:#202428;color:#eee;border:1px solid #3b4045;border-radius:8px;padding:9px 12px;cursor:pointer;font:inherit}.execution-panel button:disabled{opacity:.45;cursor:default}.execution-panel button[data-approve]{border-color:#32d583;color:#8de7b7}.execution-panel button:focus-visible,.execution-panel textarea:focus-visible,.execution-panel select:focus-visible{outline:2px solid #32d583}.execution-actions{display:flex;gap:8px;flex-wrap:wrap}.execution-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#090b0e;padding:12px;border-radius:8px;max-height:230px;overflow:auto}.execution-history button{display:block;width:100%;text-align:left;margin:5px 0;font-size:12px}.execution-review{white-space:pre-wrap;overflow-wrap:anywhere;color:#c0d6c8;margin:10px 0}.execution-status{color:#b7d9c6!important;min-height:20px}@media(max-width:600px){.execution-panel{top:82px;right:12px;bottom:12px;padding:16px}.execution-panel textarea{height:170px}}`;
  document.head.append(style);
  const panel = document.createElement("section");
  panel.className = "execution-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Python cloud jobs");
  panel.innerHTML =
    '<header><h2>Python jobs</h2><button data-close aria-label="Close Python jobs">×</button></header><p data-agent></p><p>Review before running. Code and selected files go to an isolated Freestyle VM. No network access is requested. Do not include passwords or API keys.</p><label>Python code<textarea data-code maxlength="20000" placeholder="Write or paste Python code to review. Nothing runs automatically." spellcheck="false"></textarea></label><label>Saved inputs (optional, up to 3)<select data-inputs multiple size="3" aria-label="Saved input files"></select></label><small>Inputs appear as input_1.csv, input_2.pdf, etc. Review shows the exact names. Use stdout for results; generated files are not collected yet.</small><div class="execution-review" data-review></div><div class="execution-actions"><button data-prepare>Review run</button><button data-approve hidden>Approve and run</button><button data-edit hidden>Edit</button><button data-cancel hidden>Cancel job</button></div><p class="execution-status" role="status"></p><pre data-output hidden></pre><h3>Recent jobs</h3><div class="execution-history"></div><p>120 seconds/script · 2 execution slots · 10 runs/user/day · 100 runs/month across this installation. These are Keus limits, not a guarantee about your provider account’s remaining free usage.</p><p>Jobs continue when this panel closes. App-restart recovery is limited by VM retention; uncertain jobs are never rerun automatically.</p>';
  document.body.append(panel);
  const code = panel.querySelector("[data-code]"),
    inputs = panel.querySelector("[data-inputs]"),
    status = panel.querySelector("[role=status]"),
    review = panel.querySelector("[data-review]"),
    output = panel.querySelector("[data-output]"),
    prepare = panel.querySelector("[data-prepare]"),
    approve = panel.querySelector("[data-approve]"),
    edit = panel.querySelector("[data-edit]"),
    cancel = panel.querySelector("[data-cancel]");
  let context = null,
    current = null,
    timer = null,
    enabled = false;
  const same = () =>
    context &&
    context.agentId === adapter.context().agentId &&
    context.version === adapter.context().version;
  async function request(action, data = {}) {
    if (!same()) throw Error("context_changed");
    const r = await fetch(
      `/api/execution/${action}?agentId=${encodeURIComponent(context.agentId)}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(action === "approve"
            ? { "X-Execution-Consent": "cloud-python-v1" }
            : {}),
        },
        body: JSON.stringify(data),
      },
    );
    const result = await r.json();
    if (!same()) throw Error("context_changed");
    if (!r.ok) throw Error(result.error);
    return result;
  }
  function error(e) {
    if (same()) status.textContent = copy(e.message);
  }
  function render(job) {
    current = job;
    const prepared = job.state === "prepared";
    approve.hidden = !prepared;
    edit.hidden = !prepared;
    cancel.hidden = !["queued", "running", "canceling"].includes(job.state);
    code.readOnly = prepared;
    inputs.disabled = prepared;
    prepare.disabled = !enabled || prepared;
    review.textContent = prepared
      ? `Review ${job.digest.slice(0, 12)}\n${job.review.inputs.map((f) => `${f.name} ← ${f.path} (${f.size} bytes)`).join("\n") || "No input files."}`
      : "";
    if (prepared) code.value = job.review.code;
    status.textContent = `${job.state}${job.result ? ` · exit ${job.result.exitCode}` : ""}${job.cleanupPending ? " · cleanup not yet confirmed" : ""}${job.error ? " — " + copy(job.error) : ""}`;
    output.hidden = !job.result;
    if (job.result)
      output.textContent = `${job.result.stdout || "(no stdout)"}${job.result.stderr ? "\n\nSTDERR\n" + job.result.stderr : ""}${job.result.truncated ? "\n\n[Output truncated]" : ""}`;
  }
  async function history() {
    const data = await request("list");
    const host = panel.querySelector(".execution-history");
    host.replaceChildren();
    for (const job of data.jobs) {
      const button = document.createElement("button");
      button.textContent = `${job.state} · ${new Date(job.createdAt).toLocaleString()} · ${job.id.slice(-6)}`;
      button.onclick = async () => {
        try {
          render(await request("get", { id: job.id }));
          poll();
        } catch (e) {
          error(e);
        }
      };
      host.append(button);
    }
  }
  function poll() {
    clearTimeout(timer);
    if (!same() || !current) return;
    if (
      ["queued", "running", "canceling"].includes(current.state) ||
      current.cleanupPending
    )
      timer = setTimeout(async () => {
        try {
          render(await request("get", { id: current.id }));
          await history();
          poll();
        } catch (e) {
          error(e);
        }
      }, 2000);
  }
  prepare.onclick = async () => {
    prepare.disabled = true;
    try {
      const job = await request("prepare", {
        code: code.value,
        fileIds: [...inputs.selectedOptions].map((o) => o.value),
      });
      render(job);
      await history();
    } catch (e) {
      error(e);
      prepare.disabled = !enabled;
    }
  };
  approve.onclick = async () => {
    if (
      !current ||
      !confirm(
        "Run exactly this reviewed Python code and selected files on Freestyle? The run consumes cloud compute allowance. Only logs are saved by this version; files created inside the VM are not collected. Continue?",
      )
    )
      return;
    approve.disabled = true;
    try {
      render(
        await request("approve", { id: current.id, digest: current.digest }),
      );
      await history();
      poll();
    } catch (e) {
      error(e);
    } finally {
      approve.disabled = false;
    }
  };
  edit.onclick = async () => {
    try {
      if (current?.state === "prepared")
        await request("cancel", { id: current.id });
      current = null;
      code.readOnly = false;
      inputs.disabled = false;
      approve.hidden = edit.hidden = true;
      prepare.disabled = !enabled;
      review.textContent = "";
      status.textContent = "Edit the code, then review again.";
      await history();
    } catch (e) {
      error(e);
    }
  };
  cancel.onclick = async () => {
    cancel.disabled = true;
    try {
      render(await request("cancel", { id: current.id }));
      poll();
    } catch (e) {
      error(e);
    } finally {
      cancel.disabled = false;
    }
  };
  function close() {
    clearTimeout(timer);
    panel.hidden = true;
    context = null;
    current = null;
    code.value = "";
    review.textContent = "";
    output.textContent = "";
    adapter.restoreFocus?.();
  }
  panel.querySelector("[data-close]").onclick = close;
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  document.getElementById("pythonJobsButton").onclick = async () => {
    adapter.closeMenu();
    context = { ...adapter.context() };
    panel.hidden = false;
    panel.querySelector("[data-agent]").textContent =
      context.agent?.name || "Selected agent";
    panel.querySelector("[data-close]").focus();
    current = null;
    enabled = false;
    prepare.disabled = true;
    approve.hidden = edit.hidden = cancel.hidden = true;
    code.readOnly = false;
    inputs.disabled = false;
    inputs.replaceChildren();
    output.hidden = true;
    panel.querySelector(".execution-history").replaceChildren();
    status.textContent = "Checking execution setup…";
    try {
      const state = await request("status");
      enabled = state.configured && state.allowed;
      prepare.disabled = !enabled;
      status.textContent = !state.configured
        ? copy("execution_not_configured")
        : !state.allowed
          ? copy("execution_permission_required")
          : "Nothing runs until you review and approve.";
      if (state.configured) {
        await history();
        const c = { ...context };
        const r = await fetch(
          `/api/workspace-files/list?agentId=${encodeURIComponent(c.agentId)}`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        if (r.ok && same()) {
          const data = await r.json();
          for (const file of data.files.filter(
            (f) => f.size <= 2 * 1024 * 1024,
          )) {
            const option = document.createElement("option");
            option.value = file.id;
            option.textContent = file.path;
            inputs.append(option);
          }
        }
      }
    } catch (e) {
      error(e);
    }
  };
  return {
    sync() {
      if (!panel.hidden && !same()) close();
    },
  };
}
