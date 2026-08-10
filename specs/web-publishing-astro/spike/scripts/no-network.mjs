function blocked(operation) {
  return (...args) => {
    const target = args[0] instanceof URL ? args[0].href : String(args[0] ?? "<unknown>");
    throw new Error(`T0 network-disabled build blocked ${operation}: ${target}`);
  };
}

globalThis.fetch = blocked("fetch");

const http = (await import("node:http")).default;
http.get = blocked("http.get");
http.request = blocked("http.request");

const https = (await import("node:https")).default;
https.get = blocked("https.get");
https.request = blocked("https.request");

const net = (await import("node:net")).default;
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");

const tls = (await import("node:tls")).default;
tls.connect = blocked("tls.connect");
