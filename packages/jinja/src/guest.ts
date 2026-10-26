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
    // A Markdown table cell: pipes escaped, line breaks as spaces.
    env.addFilter("mdcell", (value) => String(value === undefined || value === null ? "" : value).replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, " "));
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
  // Streaming: templates compiled for a stream environment write their output
  // through __atlcliSink while they render instead of returning one string.
  // Only the "head" function streams: the one whose preceding output has all
  // been written. The root is head first; it hands the role to a block or an
  // include it calls as a statement (after writing what it has) and takes it
  // back when that returns. super(), macros, caller(), {% set %} captures and
  // filter blocks collect into their own value as before, so the joined
  // chunks are exactly what render() returns.
  const S = { head: 0, pass: false, seq: 0, givers: [], limit: 16384 };
  S.write = (text) => { if (text) globalThis.__atlcliSink(text); };
  S.enter = () => { const id = ++S.seq; if (S.pass) { S.pass = false; S.head = id; } return id; };
  S.give = (sid, out) => {
    if (S.head !== sid) return out;
    S.write(out);
    S.givers.push(sid);
    S.pass = true;
    return "";
  };
  S.back = (sid) => {
    S.pass = false;
    if (S.givers[S.givers.length - 1] === sid) { S.givers.pop(); S.head = sid; }
  };
  // A template that extends another prints nothing itself: its parent's root takes over.
  S.handoff = (sid) => { if (S.head === sid) S.pass = true; };
  nunjucks.runtime.__atlcliStream = S;

  const C = nunjucks.compiler.Compiler.prototype;
  // The browser bundle shortens private method names; find them by what they emit.
  const privateMethod = (marker) => {
    const name = Object.getOwnPropertyNames(C).find((k) => typeof C[k] === "function" && String(C[k]).includes(marker));
    if (!name) throw new Error("nunjucks compiler: no method emitting " + marker);
    return name;
  };
  const BEGIN = privateMethod("(env, context, frame, runtime, cb) {");
  const emitLine = (c, code) => c.codebuf.push(code + "\\n");
  const original = {
    compile: nunjucks.compiler.compile,
    begin: C[BEGIN],
    root: C.compileRoot,
    output: C.compileOutput,
    block: C.compileBlock,
    include: C.compileInclude,
    capture: C.compileCapture,
  };
  let streaming = false;
  // Plain parameters, no apply(arguments)/finally: that version crashed quickjs-ng (GC assertion) after a few renders.
  nunjucks.compiler.compile = (src, asyncFilters, extensions, name, opts) => {
    const was = streaming;
    streaming = !!(opts && opts.atlcliStream);
    let code;
    try {
      code = original.compile(src, asyncFilters, extensions, name, opts);
    } catch (e) {
      streaming = was;
      throw e;
    }
    streaming = was;
    return code;
  };
  const SID = "__atlcliSid";
  const RS = "runtime.__atlcliStream";
  // Where this function's output may be written: a streaming function, its own buffer, not a capture.
  const live = (c) => streaming && c.__stream && c.buffer === "output" && !c.__capture;
  C.compileRoot = function (node, frame) {
    this.__extends = streaming && node.findAll(nunjucks.nodes.Extends).length > 0;
    original.root.call(this, node, frame);
    if (!streaming) return;
    const call = "parentTemplate.rootRenderFunc(env, context, frame, runtime, cb);\\n";
    const at = this.codebuf.lastIndexOf(call);
    if (at >= 0) this.codebuf[at] = RS + ".handoff(" + SID + ");\\n" + call;
  };
  C[BEGIN] = function (node, name) {
    original.begin.call(this, node, name);
    if (!streaming) return;
    this.__stream = name !== "root" || !this.__extends;
    emitLine(this, "var " + SID + " = " + RS + ".enter();");
  };
  C.compileOutput = function (node, frame) {
    original.output.call(this, node, frame);
    if (live(this)) emitLine(this, "if (output.length >= " + RS + ".limit && " + RS + ".head === " + SID + ") { " + RS + ".write(output); output = ''; }");
  };
  C.compileBlock = function (node, frame) {
    const on = live(this);
    if (on) emitLine(this, "output = " + RS + ".give(" + SID + ", output);");
    original.block.call(this, node, frame);
    if (on) emitLine(this, RS + ".back(" + SID + ");");
  };
  C.compileInclude = function (node, frame) {
    const on = live(this);
    if (on) emitLine(this, "output = " + RS + ".give(" + SID + ", output);");
    original.include.call(this, node, frame);
    if (on) emitLine(this, RS + ".back(" + SID + ");");
  };
  C.compileCapture = function (node, frame) {
    this.__capture = (this.__capture || 0) + 1;
    try { original.capture.call(this, node, frame); } finally { this.__capture--; }
  };

  // "lines": a line holding only a block tag disappears (trimBlocks + lstripBlocks), for document templates.
  const exactOpts = { autoescape: false, throwOnUndefined: false };
  const linesOpts = { ...exactOpts, trimBlocks: true, lstripBlocks: true };
  const envs = {
    exact: new nunjucks.Environment(new MapLoader(), exactOpts),
    lines: new nunjucks.Environment(new MapLoader(), linesOpts),
    streamExact: new nunjucks.Environment(new MapLoader(), { ...exactOpts, atlcliStream: true }),
    streamLines: new nunjucks.Environment(new MapLoader(), { ...linesOpts, atlcliStream: true }),
  };
  for (const env of Object.values(envs)) setup(env);
  let env = envs.exact;

  // Compiled templates by source; the cache is dropped when it grows too large.
  const compiled = new Map();
  const compile = (source) => {
    const key = Object.keys(envs).find((k) => envs[k] === env) + ":" + source;
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
    env = payload.mode === "stream" ? (payload.lines ? envs.streamLines : envs.streamExact) : payload.lines ? envs.lines : envs.exact;
    try {
      if (payload.mode === "stream") {
        Object.assign(S, { head: 0, pass: true, seq: 0, givers: [], limit: payload.flushBytes || 16384 });
        S.write(compile(payload.source).render(payload.vars));
        return stringify({ ok: true });
      }
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
