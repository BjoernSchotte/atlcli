/**
 * Guest-side code, evaluated in QuickJS after the Nunjucks bundle. It owns
 * the Environment, atlcli's filters and the render entry point. Everything
 * crossing the boundary is JSON text: `__atlcliPayload` in, the return value out.
 */
export const GUEST_PRELUDE = `
(() => {
  const { parse, stringify } = JSON;
  let templates = {};
  const MapLoader = nunjucks.Loader.extend({
    getSource(name) {
      if (!Object.prototype.hasOwnProperty.call(templates, name)) throw new Error("Template not found: " + name);
      return { src: templates[name], path: name, noCache: true };
    },
  });
  let captured;
  function setup(env) {
    const DATE_ONLY = /^\\d{4}-\\d{2}-\\d{2}$/;
    const pad = (n) => String(n).padStart(2, "0");
    // Template dates are calendar dates: read in UTC, so "2026-10-25" stays the 25th everywhere.
    env.addFilter("date", (value, format) => {
      if (typeof value !== "string" && !(value instanceof Date)) return value === undefined || value === null ? "" : value;
      const d = value instanceof Date ? value : new Date(DATE_ONLY.test(value) ? value + "T00:00:00.000Z" : value);
      if (Number.isNaN(d.getTime())) return value;
      return String(typeof format === "string" ? format : "YYYY-MM-DD")
        .replace("YYYY", String(d.getUTCFullYear()))
        .replace("MM", pad(d.getUTCMonth() + 1))
        .replace("DD", pad(d.getUTCDate()))
        .replace("HH", pad(d.getUTCHours()))
        .replace("mm", pad(d.getUTCMinutes()))
        .replace("ss", pad(d.getUTCSeconds()));
    });
    // date plus n units (d, w, m, y); months clamp to the month end; invalid input comes back unchanged.
    env.addFilter("dateAdd", (date, n, unit) => {
      if (typeof date !== "string") return date;
      const d = new Date(DATE_ONLY.test(date) ? date + "T00:00:00.000Z" : date);
      const amount = Number(n);
      if (Number.isNaN(d.getTime()) || !Number.isFinite(amount)) return date;
      if (unit === "d" || unit === "w") d.setUTCDate(d.getUTCDate() + amount * (unit === "w" ? 7 : 1));
      else if (unit === "m" || unit === "y") {
        const day = d.getUTCDate();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + amount * (unit === "y" ? 12 : 1));
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(day, last));
      } else return date;
      return DATE_ONLY.test(date) ? d.toISOString().slice(0, 10) : d.toISOString();
    });

    env.addGlobal("__atlcliCapture", (v) => { captured = v; return ""; });
  }
  // "lines": a line holding only a block tag disappears (trimBlocks + lstripBlocks), for document templates.
  const envs = {
    exact: new nunjucks.Environment(new MapLoader(), { autoescape: false, throwOnUndefined: false }),
    lines: new nunjucks.Environment(new MapLoader(), { autoescape: false, throwOnUndefined: false, trimBlocks: true, lstripBlocks: true }),
  };
  for (const env of Object.values(envs)) setup(env);
  let env = envs.exact;

  // Compiled templates by source; the cache is dropped when it grows too large.
  const compiled = new Map();
  const compile = (source) => {
    const key = (env === envs.lines ? "L" : "E") + source;
    let t = compiled.get(key);
    if (!t) {
      if (compiled.size > 500) compiled.clear();
      t = nunjucks.compile(source, env);
      compiled.set(key, t);
    }
    return t;
  };

  const errorOf = (e) => {
    const message = String((e && e.message) || e);
    const m = /\\[Line (\\d+), Column (\\d+)\\]/.exec(message);
    return { message: message.replace(/\\s+/g, " ").replace(/^\\(unknown path\\)\\s*/, "").trim(), ...(m ? { line: Number(m[1]), column: Number(m[2]) } : {}) };
  };

  globalThis.__atlcliJinja = () => {
    const payload = parse(globalThis.__atlcliPayload);
    delete globalThis.__atlcliPayload;
    templates = payload.templates || {};
    env = payload.lines ? envs.lines : envs.exact;
    try {
      if (payload.mode === "evaluate") {
        captured = undefined;
        compile("{{ __atlcliCapture(" + payload.source + ") }}").render(payload.vars);
        return stringify({ ok: true, value: captured === undefined ? null : captured, defined: captured !== undefined });
      }
      return stringify({ ok: true, text: compile(payload.source).render(payload.vars) });
    } catch (e) {
      // Limits are not template errors: let them end the call, so the host resets the runtime.
      if (e && (e.name === "InternalError" || /InternalError: (out of memory|interrupted)/.test(String(e.message)))) throw e;
      return stringify({ ok: false, error: errorOf(e) });
    }
  };
})();
`;
