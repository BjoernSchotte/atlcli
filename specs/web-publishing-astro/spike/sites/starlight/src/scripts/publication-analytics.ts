import { init, track } from "@plausible-analytics/tracker";

const element = document.querySelector<HTMLMetaElement>('meta[name="atlcli:analytics"]');
if (element?.content) {
  const config = JSON.parse(element.content) as { domain: string; endpoint: string };
  const sanitizedPageUrl = `${location.origin}${location.pathname}`;
  init({
    autoCapturePageviews: false,
    bindToWindow: false,
    captureOnLocalhost: /^(?:127(?:\.\d+){3}|localhost)$/u.test(location.hostname),
    customProperties: {},
    domain: config.domain,
    endpoint: config.endpoint,
    fileDownloads: false,
    formSubmissions: false,
    hashBasedRouting: false,
    logging: false,
    outboundLinks: false,
    transformRequest(payload) {
      if (payload.n !== "pageview") return null;
      return {
        d: config.domain,
        n: "pageview",
        u: sanitizedPageUrl,
        v: payload.v,
      };
    },
  });
  track("pageview", { url: sanitizedPageUrl });
}
