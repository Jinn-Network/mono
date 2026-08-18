#!/usr/bin/env python3
"""External check of a benchmark-product public bundle: Python 3 stdlib plus
the openssl CLI, no Jinn code. Covers the externally verifiable subset only:
manifest digests, content-addressed records, sealed-byte identity, DSSE
Ed25519 signatures, digest cross-references, key derivations, and the claim's
stored mirror. It does NOT re-derive the matrix, recompute the statistical
method, or rebuild the claim package (the reference verifier does), and no
tool can prove the producing venue was honest. Exit 0: all checks pass.
Exit 1: a check failed. Exit 2: usage or environment failure."""
import base64, hashlib, json, os, subprocess, sys, tempfile

def sha256(b): return hashlib.sha256(b).hexdigest()

def b58(data):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n, out = int.from_bytes(data, "big"), ""
    while n: n, r = divmod(n, 58); out = alphabet[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out

def openssl_verify(spki_der, sig, message):
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, blob in (("key", spki_der), ("sig", sig), ("msg", message)):
            paths[name] = os.path.join(tmp, name)
            with open(paths[name], "wb") as handle: handle.write(blob)
        run = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
                              "-inkey", paths["key"], "-rawin", "-in", paths["msg"], "-sigfile", paths["sig"]],
                             capture_output=True, text=True)
        text = run.stdout + run.stderr
        if "Signature Verified Successfully" in text: return True
        if "Signature Verification Failure" in text: return False
        print(f"openssl cannot verify Ed25519 raw signatures here (need OpenSSL 3+): {text.strip()[:200]}", file=sys.stderr)
        sys.exit(2)

def pae(payload_type, payload):
    t = payload_type.encode()
    return b"DSSEv1 %d %s %d %s" % (len(t), t, len(payload), payload)

if len(sys.argv) != 2:
    print("usage: external-verify.py <bundle-dir>", file=sys.stderr)
    sys.exit(2)
root = sys.argv[1]
if not os.path.isdir(root):
    print(f"not a directory: {root}", file=sys.stderr)
    sys.exit(2)
read = lambda rel: open(os.path.join(root, rel), "rb").read()
failures = []
def check(name, fn):
    try:
        problems = fn()
    except Exception as error:  # a missing or malformed file fails the check
        problems = [f"{type(error).__name__}: {error}"]
    print(f"CHECK {name}: " + ("ok" if not problems else "FAIL " + "; ".join(str(p) for p in problems[:3])))
    if problems: failures.append(name)

manifest = json.loads(read("bundle.json"))
trust = json.loads(read("trust/public-keys.json"))
claim = json.loads(read("claim-package.json"))
envelope = json.loads(read("report-envelope.json"))

def manifest_files():
    problems = []
    for entry in manifest["files"]:
        blob = read(entry["path"])
        if len(blob) != entry["bytes"] or sha256(blob) != entry["sha256"]:
            problems.append(f"{entry['path']} does not match its manifest entry")
    listed = {entry["path"] for entry in manifest["files"]}
    on_disk = {os.path.relpath(os.path.join(base, name), root).replace(os.sep, "/")
               for base, _, names in os.walk(root) for name in names}
    problems += [f"unlisted file {path}" for path in sorted(on_disk - listed - {"bundle.json"})]
    problems += [f"missing file {path}" for path in sorted(listed - on_disk)]
    return problems

def cas_records():
    return [f"records/{name} bytes do not hash to its name"
            for name in os.listdir(os.path.join(root, "records"))
            if f"{sha256(read(f'records/{name}'))}.bin" != name]

def sealed_bytes():
    problems = []
    if base64.b64decode(envelope["payload"]) != read("report.json"):
        problems.append("report.json is not the exact DSSE payload bytes")
    for field, rel in (("benchmarkSha256", "benchmark.json"), ("runSha256", "run.json"),
                       ("matrixSha256", "matrix.json"), ("reportSha256", "report.json"),
                       ("reportEnvelopeSha256", "report-envelope.json")):
        if sha256(read(rel)) != claim["records"][field]:
            problems.append(f"{rel} does not match claim records.{field}")
    return problems

def report_signature():
    spki = base64.b64decode(trust["report"]["spkiDerBase64"])
    signature = next(s for s in envelope["signatures"] if s.get("keyid") == trust["report"]["keyId"])
    message = pae(envelope["payloadType"], base64.b64decode(envelope["payload"]))
    return [] if openssl_verify(spki, base64.b64decode(signature["sig"]), message) else ["report DSSE signature invalid"]

def report_pins_matrix():
    report = json.loads(read("report.json"))
    digests = [subject.get("digest", {}).get("sha256") for subject in report.get("subjects", [])]
    return [] if sha256(read("matrix.json")) in digests else ["signed report does not pin matrix.json"]

def verdict_signatures():
    problems, keys = [], {e["keyId"]: base64.b64decode(e["spkiDerBase64"]) for e in trust["evaluators"]}
    for verdict in json.loads(read("verdicts.json"))["verdicts"]:
        env = json.loads(read(f"records/{verdict['sha256']}.bin"))
        signature = next(s for s in env["signatures"] if s.get("keyid") == verdict["keyId"])
        message = pae(env["payloadType"], base64.b64decode(env["payload"]))
        if not openssl_verify(keys[verdict["keyId"]], base64.b64decode(signature["sig"]), message):
            problems.append(f"verdict {verdict['sha256'][:12]} signature invalid")
    return problems

def matrix_verdict_closure():
    problems, catalog = [], {v["sha256"] for v in json.loads(read("verdicts.json"))["verdicts"]}
    for cell in json.loads(read("matrix.json"))["cells"]:
        for ref in cell.get("verdicts", []) + cell.get("validVerdicts", []):
            digest = ref.split(":", 1)[1]
            if digest not in catalog: problems.append(f"cell {cell['cellKey']} cites uncataloged verdict {digest[:12]}")
            if not os.path.exists(os.path.join(root, "records", f"{digest}.bin")):
                problems.append(f"verdict record {digest[:12]} missing from the store")
    return problems

def claim_mirror():
    if "headline" not in claim: return []
    report = json.loads(read("report.json"))
    arms = report["results"]["perSubject"][0]["results"]["arms"]
    return [] if claim["headline"] == arms else ["claim headline disagrees with the signed report's results"]

def key_derivations():
    problems = []
    spki = base64.b64decode(trust["report"]["spkiDerBase64"])
    derived = "did:key:z" + b58(bytes([0xED, 0x01]) + spki[-32:])
    if not (derived == trust["report"]["didKey"] == trust["report"]["keyId"]):
        problems.append("report did:key does not derive from the carried SPKI")
    for evaluator in trust["evaluators"]:
        expected = "benchmark-product-verdict-" + sha256(base64.b64decode(evaluator["spkiDerBase64"]))[:16]
        if evaluator["keyId"] != expected: problems.append(f"evaluator keyId {evaluator['keyId']} does not derive from its SPKI")
    return problems

for name, fn in (("manifest-files", manifest_files), ("cas-records", cas_records),
                 ("sealed-bytes", sealed_bytes), ("report-signature", report_signature),
                 ("report-pins-matrix", report_pins_matrix), ("verdict-signatures", verdict_signatures),
                 ("matrix-verdict-closure", matrix_verdict_closure), ("claim-mirror", claim_mirror),
                 ("key-derivations", key_derivations)):
    check(name, fn)

print()
print("These checks prove internal consistency and that the bundle is signed by the")
print("keys the bundle itself names. They do NOT re-derive the matrix, recompute the")
print("statistical method, or rebuild the claim package (the reference verifier does),")
print("and no tool can prove the producing venue was honest.")
sys.exit(1 if failures else 0)
