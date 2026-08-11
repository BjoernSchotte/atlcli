import { createHash } from "node:crypto";

export const ORT_JSEP_FACTORY_UPSTREAM_SHA256 =
  "18e4399d2c6998ed06bce49c4b7476984e77be43205f758607bc779344a804a6";
export const ORT_JSEP_WASM_UPSTREAM_SHA256 =
  "12017c384fc3f11f9fcbac694c373e31f62a87c37d14a823fe884b40b8392706";
export const ORT_JSEP_FACTORY_MV3_SHA256 =
  "bc66e8b9c769788a5c684c060d0a5028e90cd35539d359ed9ed74b4fe87a0eed";
export const ORT_ASYNCIFY_FACTORY_UPSTREAM_SHA256 =
  "718f08970456a0843a1281be041fa4520e4df67ba09f0264f72818b2ca987590";
export const ORT_ASYNCIFY_WASM_UPSTREAM_SHA256 =
  "1d6ee4ff60d7f0e6b6efa34469157d3bdcbe2f3b0dbcea2a645bb41361a85973";
export const ORT_ASYNCIFY_FACTORY_MV3_SHA256 =
  "01d36095dbd45fb097b54b035ff29184edde6be1424d980ef4600749baa286bc";

const DYNAMIC_EMVAL_INVOKER =
  'function Pb(a,b,d){var [c,...e]=Df(a,b>>>0);b=c.Vc.bind(c);var g=e.map(n=>n.Uc.bind(n));a--;var k={toValue:V};a=g.map((n,p)=>{var u=`argFromPtr${p}`;k[u]=n;return`${u}(args${p?"+"+8*p:""})`});switch(d){case 0:var l="toValue(handle)";break;case 2:l="new (toValue(handle))";break;case 3:l="";break;case 1:k.getStringOrSymbol=Gf,l="toValue(handle)[getStringOrSymbol(methodName)]"}l+=`(${a})`;c.zd||(k.toReturnWire=b,k.emval_returnValue=Ef,l=`return emval_returnValue(toReturnWire, destructorsRef, ${l})`);\nl=`return function (handle, methodName, destructorsRef, args) {\\n  ${l}\\n  }`;d=(new Function(Object.keys(k),l))(...Object.values(k));l=`methodCaller<(${e.map(n=>n.name)}) => ${c.name}>`;return Cf(Object.defineProperty(d,"name",{value:l}))}';

// Emscripten's generated embind helper normally compiles one tiny argument
// adapter with `new Function`. MV3 rejects that code even though the WASM
// itself is permitted. This equivalent closure preserves all four generated
// invocation modes without string-to-code execution. The upstream digest and
// exact one-occurrence replacement make an ORT upgrade fail closed.
const CSP_SAFE_EMVAL_INVOKER =
  'function Pb(a,b,d){var [c,...e]=Df(a,b>>>0);b=c.Vc.bind(c);var g=e.map(n=>n.Uc.bind(n));a--;var k=function(a){for(var b=Array(g.length),c=0;c<g.length;c++)b[c]=g[c](a+8*c);return b},l=function(a,e,g,n){var p=k(n),u;switch(d){case 0:u=V(a)(...p);break;case 1:u=V(a)[Gf(e)](...p);break;case 2:u=Reflect.construct(V(a),p);break;case 3:u=p.at(-1);break;default:throw Error("Unsupported emval method caller kind: "+d)}if(!c.zd)return Ef(b,g,u)};a=`methodCaller<(${e.map(n=>n.name)}) => ${c.name}>`;return Cf(Object.defineProperty(l,"name",{value:a}))}';

const ASYNCIFY_DYNAMIC_EMVAL_INVOKER =
  'function Pb(a,b,c){var [d,...e]=Jg(a,b>>>0);b=d.Sc.bind(d);var f=e.map(m=>m.Rc.bind(m));a--;var h={toValue:R};a=f.map((m,p)=>{var C=`argFromPtr${p}`;h[C]=m;return`${C}(args${p?"+"+8*p:""})`});switch(c){case 0:var k="toValue(handle)";break;case 2:k="new (toValue(handle))";break;case 3:k="";break;case 1:h.getStringOrSymbol=Mg,k="toValue(handle)[getStringOrSymbol(methodName)]"}k+=`(${a})`;d.ee||(h.toReturnWire=b,h.emval_returnValue=Kg,k=`return emval_returnValue(toReturnWire, destructorsRef, ${k})`);\nk=`return function (handle, methodName, destructorsRef, args) {\\n  ${k}\\n  }`;c=(new Function(Object.keys(h),k))(...Object.values(h));k=`methodCaller<(${e.map(m=>m.name)}) => ${d.name}>`;return Ig(Object.defineProperty(c,"name",{value:k}))}';

const ASYNCIFY_CSP_SAFE_EMVAL_INVOKER =
  'function Pb(a,b,c){var [d,...e]=Jg(a,b>>>0);b=d.Sc.bind(d);var f=e.map(m=>m.Rc.bind(m));a--;var h=function(a){for(var b=Array(f.length),c=0;c<f.length;c++)b[c]=f[c](a+8*c);return b},k=function(a,e,f,g){var p=h(g),u;switch(c){case 0:u=R(a)(...p);break;case 1:u=R(a)[Mg(e)](...p);break;case 2:u=Reflect.construct(R(a),p);break;case 3:u=p.at(-1);break;default:throw Error("Unsupported emval method caller kind: "+c)}if(!d.ee)return Kg(b,f,u)};a=`methodCaller<(${e.map(m=>m.name)}) => ${d.name}>`;return Ig(Object.defineProperty(k,"name",{value:a}))}';

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function patchOrtJsepFactoryForMv3(source: string): string {
  const digest = sha256Hex(source);
  if (digest !== ORT_JSEP_FACTORY_UPSTREAM_SHA256) {
    throw new Error(`Unexpected ONNX Runtime JSEP factory digest: ${digest}`);
  }
  const first = source.indexOf(DYNAMIC_EMVAL_INVOKER);
  if (first < 0 || source.indexOf(DYNAMIC_EMVAL_INVOKER, first + 1) >= 0) {
    throw new Error("Expected exactly one ONNX Runtime dynamic emval invoker.");
  }
  const patched = source.replace(DYNAMIC_EMVAL_INVOKER, CSP_SAFE_EMVAL_INVOKER);
  if (patched.includes("new Function(")) {
    throw new Error("ONNX Runtime JSEP factory still contains dynamic code.");
  }
  const patchedDigest = sha256Hex(patched);
  if (patchedDigest !== ORT_JSEP_FACTORY_MV3_SHA256) {
    throw new Error(`Unexpected patched ONNX Runtime JSEP factory digest: ${patchedDigest}`);
  }
  return patched;
}

export function patchOrtAsyncifyFactoryForMv3(source: string): string {
  const digest = sha256Hex(source);
  if (digest !== ORT_ASYNCIFY_FACTORY_UPSTREAM_SHA256) {
    throw new Error(`Unexpected ONNX Runtime asyncify factory digest: ${digest}`);
  }
  const first = source.indexOf(ASYNCIFY_DYNAMIC_EMVAL_INVOKER);
  if (first < 0 || source.indexOf(ASYNCIFY_DYNAMIC_EMVAL_INVOKER, first + 1) >= 0) {
    throw new Error("Expected exactly one ONNX Runtime asyncify dynamic emval invoker.");
  }
  const patched = source.replace(
    ASYNCIFY_DYNAMIC_EMVAL_INVOKER,
    ASYNCIFY_CSP_SAFE_EMVAL_INVOKER,
  );
  if (patched.includes("new Function(")) {
    throw new Error("ONNX Runtime asyncify factory still contains dynamic code.");
  }
  const patchedDigest = sha256Hex(patched);
  if (patchedDigest !== ORT_ASYNCIFY_FACTORY_MV3_SHA256) {
    throw new Error(`Unexpected patched ONNX Runtime asyncify factory digest: ${patchedDigest}`);
  }
  return patched;
}
