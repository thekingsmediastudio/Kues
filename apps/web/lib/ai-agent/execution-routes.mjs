import { LibraryError } from "./workspace-storage.mjs";
import { FileToolError } from "./file-tools.mjs";
export const EXECUTION_CONSENT = "cloud-python-v1";
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0,
      done = false;
    const chunks = [];
    const timer = setTimeout(
      () => finish(new LibraryError("execution_request_timeout", 408)),
      15000,
    );
    function finish(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", abort);
      req.off("error", abort);
      if (e) {
        req.resume();
        reject(e);
      } else {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw Error();
          resolve(value);
        } catch {
          reject(new LibraryError("execution_request_invalid"));
        }
      }
    }
    function data(c) {
      size += c.length;
      if (size > 128 * 1024)
        finish(new LibraryError("execution_request_too_large", 413));
      else chunks.push(c);
    }
    function end() {
      finish();
    }
    function abort() {
      finish(new LibraryError("execution_request_canceled"));
    }
    req.on("data", data);
    req.on("end", end);
    req.on("aborted", abort);
    req.on("error", abort);
  });
}
export function createExecutionRoutes({ service, getScope, sameOrigin }) {
  let active = 0;
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  return async (req, res, url) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: "same_origin_required" });
      return;
    }
    let counted = false;
    try {
      const action = url.pathname.split("/").at(-1);
      if (
        !["status", "prepare", "approve", "get", "list", "cancel"].includes(
          action,
        )
      )
        throw new LibraryError("execution_route_not_found", 404);
      const agentId = url.searchParams.get("agentId");
      if (!agentId || agentId.length > 255)
        throw new LibraryError("file_agent_required");
      const scope = await getScope(req, agentId);
      if (action === "status") {
        json(res, 200, {
          configured: service?.configured === true,
          allowed: scope.agent.settings?.toolPermissions?.run_code === true,
          language: "python",
          maxScriptSeconds: 120,
          globalMonthlyRunLimit: 100,
          perUserDailyRunLimit: 10,
        });
        return;
      }
      if (!service?.configured)
        throw new LibraryError("execution_not_configured", 503);
      if (active >= 4) throw new LibraryError("execution_busy", 429);
      active++;
      counted = true;
      if (
        String(req.headers["content-type"]).split(";")[0] !== "application/json"
      )
        throw new LibraryError("execution_request_invalid", 415);
      const data = await readBody(req);
      const fields = {
        prepare: ["code", "fileIds"],
        approve: ["id", "digest"],
        get: ["id"],
        list: [],
        cancel: ["id"],
      }[action];
      if (Object.keys(data).some((k) => !fields.includes(k)))
        throw new LibraryError("execution_request_invalid");
      if (
        action === "approve" &&
        req.headers["x-execution-consent"] !== EXECUTION_CONSENT
      )
        throw new LibraryError("execution_consent_required");
      const fresh = await getScope(req, agentId);
      let output;
      if (action === "prepare") output = await service.prepare(fresh, data);
      else if (action === "approve")
        output = await service.approve(fresh, data);
      else if (action === "list") output = { jobs: await service.list(fresh) };
      else if (action === "get") output = await service.get(fresh, data.id);
      else output = await service.cancel(fresh, data.id);
      json(res, 200, output);
    } catch (e) {
      if (!res.destroyed) {
        if ([408, 413].includes(e.status)) res.setHeader("Connection", "close");
        const known = e instanceof LibraryError || e instanceof FileToolError;
        json(res, known ? e.status : 503, {
          error: known ? e.code : "execution_unavailable",
        });
      }
    } finally {
      if (counted) active--;
    }
  };
}
