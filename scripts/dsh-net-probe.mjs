#!/usr/bin/env node
/**
 * dsh-net-probe — why can't DSH reach a model provider?
 *
 * Run this with the SAME Node that runs DSH, and from a shell where DSH's own
 * proxy variables are set (or not set) exactly as they are when DSH fails:
 *
 *     node scripts/dsh-net-probe.mjs
 *     node scripts/dsh-net-probe.mjs https://api.deepseek.com https://api.anthropic.com
 *
 * WHY this exists: Node collapses every pre-response failure — DNS, TCP
 * refused, TCP blocked, TLS/certificate, proxy — into the identical
 * `TypeError: fetch failed`, keeping the real reason only in `err.cause`. That
 * makes "no model connects" indistinguishable from "wrong API key", which is
 * how the upstream Q&A thread (deepseek-harness discussion #175) spent 27
 * comments before anyone found it was a proxy. A browser or curl is NOT a valid
 * control: they have their own proxy and trust-store settings, so they can
 * succeed while Node fails.
 *
 * THE ONE RULE THIS ENCODES: if you get ANY HTTP status back, DNS/TCP/TLS all
 * worked — stop tuning the proxy and the CA, and go look at the credential,
 * quota or gateway policy instead. HTTP 401/402/403/429 is a SUCCESS here.
 */
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")

const DEFAULT_TARGETS = [
  "https://api.deepseek.com",
  "https://api.anthropic.com",
]

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")

/**
 * Install the SAME outbound policy the DSH launcher installs, before probing.
 *
 * This is not optional. DSH does not rely on Node reading the proxy environment
 * (it cannot: Node samples that at startup, which is why the launcher resolves
 * from its own layered snapshot). If this probe skipped the policy it would
 * connect DIRECTLY and cheerfully report "network is fine" on a machine where
 * DSH itself is broken — the exact false negative this script exists to avoid.
 *
 * Verified by construction: with HTTPS_PROXY pointed at a dead port, the policy
 * is what makes the probe fail.
 */
async function installDshProxyPolicy() {
  const bootPkg = join(repoRoot, "packages/boot/app-boot/lib/index.js")
  const proxyPkg = join(repoRoot, "packages/util/http-proxy/lib/index.js")
  try {
    const { loadLayeredEnv } = await import(pathToFileURL(bootPkg).href)
    const { installProxyFromEnvironment } = await import(pathToFileURL(proxyPkg).href)
    // loadLayeredEnv mirrors the launcher: project .env then $DSH_HOME/.env,
    // without replacing anything already exported.
    const snapshot = loadLayeredEnv("dsh", process.cwd(), (line) => process.stderr.write(line))
    const diagnostics = []
    await installProxyFromEnvironment(snapshot, (message) => diagnostics.push(message))
    return { applied: true, diagnostics }
  } catch (error) {
    return { applied: false, diagnostics: [], error }
  }
}

// ── environment ──────────────────────────────────────────────────────────────
const PROXY_NAMES = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]
console.log("environment")
console.log(`  node            ${process.version}`)
console.log(`  platform        ${process.platform} ${process.arch}`)
console.log(`  DSH_HOME        ${dshHome}${existsSync(dshHome) ? "" : "  (does not exist)"}`)

let anyProxy = false
for (const name of PROXY_NAMES) {
  const value = process.env[name] ?? process.env[name.toUpperCase()]
  if (value !== undefined && value.trim() !== "") {
    anyProxy = true
    console.log(`  ${name.padEnd(15)} ${value}`)
  }
}
if (!anyProxy) {
  console.log("  proxy vars      none set (DSH will connect directly)")
  console.log("                  -> if this machine NEEDS a proxy, set HTTPS_PROXY and restart DSH;")
  console.log("                     DSH reads it at launch, so an already-running process will not pick it up.")
}

// A `.env` in DSH_HOME is part of the launcher's snapshot (it is what makes a
// proxy survive Node sampling the environment at startup).
const envFile = join(dshHome, ".env")
if (existsSync(envFile)) {
  const proxyLines = readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*(https?|all|no)_proxy\s*=/i.test(l))
  console.log(`  ${envFile}${proxyLines.length > 0 ? "" : "  (present, no proxy keys)"}`)
  for (const line of proxyLines) console.log(`    ${line.trim()}`)
}

for (const name of ["NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
  const value = process.env[name]
  if (value !== undefined) console.log(`  ${name.padEnd(29)} ${value}`)
}
if (process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") {
  console.log("  !! NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification entirely — do not ship that.")
}

// ── install DSH's real outbound policy BEFORE any probe ──────────────────────
const policy = await installDshProxyPolicy()
console.log("dsh outbound policy")
if (policy.applied) {
  for (const line of policy.diagnostics) console.log(`  ${line}`)
  if (policy.diagnostics.length === 0) console.log("  installed (no diagnostics)")
} else {
  console.log(`  COULD NOT LOAD DSH's policy: ${policy.error?.message ?? policy.error}`)
  console.log("  -> probes below run DIRECT and may not reproduce DSH's own routing.")
}

// ── probes ───────────────────────────────────────────────────────────────────
/** Walk `cause` and keep every link's message and errno code. */
function chain(error) {
  const out = []
  let current = error
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (!(current instanceof Error)) { out.push(String(current)); break }
    const code = current.code
    out.push(code ? `${current.message} [${code}]` : current.message)
    current = current.cause
  }
  return out
}

/** Classify the deepest link into the layer that actually failed. */
function classify(error) {
  const text = chain(error).join(" | ")
  const code = (error?.cause?.code ?? error?.code ?? "")
  const both = `${code} ${text}`

  // A TLS ALERT FROM THE PEER is categorically different from a certificate
  // VERIFICATION failure, and they need opposite advice:
  //   - verification failed -> we do not trust them      -> install the CA
  //   - they aborted         -> they rejected our records -> CA will NOT help
  // `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC` is the second kind: a middlebox
  // rewriting the stream so the peer's MAC check fails. This is the shape seen
  // in the wild with a TLS-inspecting gateway on an unstable link, and the
  // original version of this probe mis-filed it as UNKNOWN.
  if (/BAD_RECORD_MAC|WRONG_VERSION_NUMBER|SSL_ALERT|SSLV3_ALERT|TLSV1_ALERT|EPROTO/i.test(both)) {
    return [
      "TLS-ALERT",
      "the peer (or a middlebox) ABORTED the record layer mid-stream. A CA will not fix this — " +
        "certificate trust is not the issue. Suspect a TLS-inspecting gateway corrupting a long " +
        "connection, a flaky VPN/link, or an aggressive idle timeout on a large streamed request. " +
        "Re-run; if it is intermittent, look at the path (VPN vs direct, proxy vs direct) rather than DSH.",
    ]
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HOSTNAME_MISMATCH|UNABLE_TO_GET_ISSUER/i.test(both)) {
    return ["TLS-TRUST", "certificate verification failed — a TLS-inspecting gateway; set NODE_EXTRA_CA_CERTS to the approved CA (PEM), or NODE_USE_SYSTEM_CA=1 on Windows"]
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return ["DNS", "the hostname did not resolve — check DNS, VPN, or split-horizon DNS"]
  if (/ECONNREFUSED/i.test(code)) return ["TCP", "something answered and refused — a proxy that is not listening, or a closed port"]
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout/i.test(text)) return ["TCP/TIMEOUT", "the connection was blackholed — usually a firewall, or a proxy that should have been used"]
  if (/proxy/i.test(text)) return ["PROXY", "the proxy itself failed — check the URL, scheme (SOCKS is not supported by DSH) and credentials"]
  return ["UNKNOWN", "no recognizable layer — read the chain above verbatim"]
}

console.log("\nprobes")
let failures = 0
for (const target of targets) {
  const started = Date.now()
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    const ms = Date.now() - started
    // ANY status proves the transport worked.
    console.log(`  OK    ${target}  -> HTTP ${response.status}  (${ms}ms)`)
    console.log("        DNS + TCP + TLS all succeeded. If DSH still cannot use a model, the")
    console.log("        problem is NOT network: check the API key, account balance, quota,")
    console.log("        model name, and any gateway policy. Stop changing proxy/CA settings.")
  } catch (error) {
    failures++
    const ms = Date.now() - started
    const [layer, advice] = classify(error)
    console.log(`  FAIL  ${target}  (${ms}ms)`)
    console.log(`        layer: ${layer}`)
    console.log(`        chain: ${chain(error).join("  <-  ")}`)
    console.log(`        ${advice}`)
  }
}

console.log("\nnext step")
if (failures === 0) {
  console.log("  Every target reached HTTP. The transport is fine — look at credentials/quota.")
} else if (failures === targets.length && !anyProxy) {
  console.log("  Nothing connected and no proxy is configured. If this machine requires one,")
  console.log("  set HTTPS_PROXY (+ NO_PROXY=localhost,127.0.0.1,::1) and RESTART dsh.")
} else {
  console.log("  Fix the failing layer named above, then re-run this probe before touching DSH settings.")
}
console.log("  Same-Node probe is the control that matters: a browser or curl can succeed while Node fails.")

process.exit(failures === 0 ? 0 : 1)
