#!/usr/bin/env python3
"""External check of a benchmark-product public bundle: Python 3 stdlib plus
the openssl CLI, no Jinn code. Covers the externally verifiable subset only:
manifest digests, content-addressed records, sealed-byte identity, DSSE
Ed25519 signatures, digest cross-references, key derivations, and the claim's
stored mirror. It does NOT re-derive the matrix, recompute the statistical
method, or rebuild the claim package (the reference verifier does), and no
tool can prove the producing venue was honest. Exit 0: all checks pass.
Exit 1: a check failed. Exit 2: usage or environment failure."""
import base64, hashlib, json, os, re, subprocess, sys, tempfile

HEX64 = re.compile(r"^[0-9a-f]{64}$")

def sha256(b): return hashlib.sha256(b).hexdigest()

def b58(data):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n, out = int.from_bytes(data, "big"), ""
    while n: n, r = divmod(n, 58); out = alphabet[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out

def strict_b64(field, label):
    """Decode base64 the way the reference verifier does: exactly standard OR
    exactly URL-safe, canonical padding, no stray bytes. An inserted newline or
    non-canonical padding fails here rather than being silently dropped. The
    re-encode round trip is what makes this strict: it rejects any spelling that
    is not the one canonical encoding of those bytes."""
    if isinstance(field, str):
        try:
            decoded = base64.b64decode(field, validate=True)
            if base64.b64encode(decoded).decode("ascii") == field:
                return decoded
        except Exception:
            pass
        try:
            decoded = base64.urlsafe_b64decode(field)
            if base64.urlsafe_b64encode(decoded).decode("ascii") == field:
                return decoded
        except Exception:
            pass
    raise ValueError(f"{label} is not strict standard or URL-safe base64")

def probe_openssl():
    """The real environment test: sign and verify a self-generated Ed25519 key.
    If this cannot produce success the host's openssl cannot do the job."""
    with tempfile.TemporaryDirectory() as tmp:
        priv, pub = os.path.join(tmp, "priv.pem"), os.path.join(tmp, "pub.der")
        msg, sig = os.path.join(tmp, "msg"), os.path.join(tmp, "sig")
        with open(msg, "wb") as handle: handle.write(b"external-verify probe")
        for argv in (["openssl", "genpkey", "-algorithm", "ed25519", "-out", priv],
                     ["openssl", "pkey", "-in", priv, "-pubout", "-outform", "DER", "-out", pub],
                     ["openssl", "pkeyutl", "-sign", "-inkey", priv, "-rawin", "-in", msg, "-out", sig]):
            if subprocess.run(argv, capture_output=True).returncode != 0:
                return False
        run = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
                              "-inkey", pub, "-rawin", "-in", msg, "-sigfile", sig],
                             capture_output=True, text=True)
        return "Signature Verified Successfully" in (run.stdout + run.stderr)

def openssl_verify(spki_der, sig, message):
    """After the capability probe, any outcome that is not explicit success is a
    verification failure — a bundle-supplied bad key never reads as 'inconclusive'."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, blob in (("key", spki_der), ("sig", sig), ("msg", message)):
            paths[name] = os.path.join(tmp, name)
            with open(paths[name], "wb") as handle: handle.write(blob)
        run = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
                              "-inkey", paths["key"], "-rawin", "-in", paths["msg"], "-sigfile", paths["sig"]],
                             capture_output=True, text=True)
        return "Signature Verified Successfully" in (run.stdout + run.stderr)

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
if not probe_openssl():
    print("openssl cannot sign/verify Ed25519 here (need OpenSSL 3+); cannot check signatures", file=sys.stderr)
    sys.exit(2)

root_real = os.path.realpath(root)

def resolve(rel):
    """Bundle-relative read with containment: reject absolute, empty, '.', '..',
    and backslash segments; refuse symlinks; refuse any real path outside the
    bundle. The reference verifier hardens exactly this, and a reference tool
    that dropped it would teach implementers to drop it too."""
    if not isinstance(rel, str) or rel != rel.strip() or rel.startswith("/") or "\\" in rel:
        raise ValueError(f"unsafe path {rel!r}")
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe path {rel!r}")
    full = os.path.join(root, *parts)
    walk = root
    for part in parts:
        walk = os.path.join(walk, part)
        if os.path.islink(walk):
            raise ValueError(f"symlink not allowed in {rel!r}")
    if os.path.realpath(full) != os.path.join(root_real, *parts):
        raise ValueError(f"path escapes bundle {rel!r}")
    return full

def read(rel): return open(resolve(rel), "rb").read()

failures, skipped = [], []
def check(name, fn):
    try:
        problems = fn()
    except Exception as error:  # a missing, malformed, or unsafe input fails the check
        problems = [f"{type(error).__name__}: {error}"]
    if problems == "skip":
        print(f"CHECK {name}: skipped"); skipped.append(name); return
    print(f"CHECK {name}: " + ("ok" if not problems else "FAIL " + "; ".join(str(p) for p in problems[:3])))
    if problems: failures.append(name)

manifest = json.loads(read("bundle.json"))
trust = json.loads(read("trust/public-keys.json"))
claim = json.loads(read("claim-package.json"))
envelope = json.loads(read("report-envelope.json"))

def manifest_files():
    problems = []
    for entry in manifest["files"]:
        try:
            blob = read(entry["path"])
        except Exception as error:
            problems.append(f"{entry['path']!r}: {error}"); continue
        if len(blob) != entry["bytes"] or sha256(blob) != entry["sha256"]:
            problems.append(f"{entry['path']} does not match its manifest entry")
    listed = {entry["path"] for entry in manifest["files"]}
    on_disk = {os.path.relpath(os.path.join(base, name), root).replace(os.sep, "/")
               for base, _, names in os.walk(root) for name in names}
    problems += [f"unlisted file {path}" for path in sorted(on_disk - listed - {"bundle.json"})]
    problems += [f"missing file {path}" for path in sorted(listed - on_disk)]
    return problems

def record_bytes(digest):
    if not HEX64.match(digest):
        raise ValueError(f"record name is not a 64-hex digest: {digest!r}")
    return read(f"records/{digest}.bin")

def cas_records():
    problems = []
    for name in os.listdir(os.path.join(root, "records")):
        if not name.endswith(".bin") or not HEX64.match(name[:-4]):
            problems.append(f"records/{name} is not a <64-hex>.bin record"); continue
        if sha256(read(f"records/{name}")) != name[:-4]:
            problems.append(f"records/{name} bytes do not hash to its name")
    return problems

def sealed_bytes():
    problems = []
    if strict_b64(envelope["payload"], "report envelope payload") != read("report.json"):
        problems.append("report.json is not the exact DSSE payload bytes")
    for field, rel in (("benchmarkSha256", "benchmark.json"), ("runSha256", "run.json"),
                       ("matrixSha256", "matrix.json"), ("reportSha256", "report.json"),
                       ("reportEnvelopeSha256", "report-envelope.json")):
        if sha256(read(rel)) != claim["records"][field]:
            problems.append(f"{rel} does not match claim records.{field}")
    return problems

def report_signature():
    spki = strict_b64(trust["report"]["spkiDerBase64"], "report SPKI")
    signature = next(s for s in envelope["signatures"] if s.get("keyid") == trust["report"]["keyId"])
    message = pae(envelope["payloadType"], strict_b64(envelope["payload"], "report envelope payload"))
    return [] if openssl_verify(spki, strict_b64(signature["sig"], "report signature"), message) else ["report DSSE signature invalid"]

def report_pins_matrix():
    report = json.loads(read("report.json"))
    digests = [subject.get("digest", {}).get("sha256") for subject in report.get("subjects", [])]
    return [] if sha256(read("matrix.json")) in digests else ["signed report does not pin matrix.json"]

def verdict_signatures():
    problems, keys = [], {e["keyId"]: strict_b64(e["spkiDerBase64"], "evaluator SPKI") for e in trust["evaluators"]}
    for verdict in json.loads(read("verdicts.json"))["verdicts"]:
        env = json.loads(record_bytes(verdict["sha256"]))
        signature = next(s for s in env["signatures"] if s.get("keyid") == verdict["keyId"])
        message = pae(env["payloadType"], strict_b64(env["payload"], "verdict payload"))
        if not openssl_verify(keys[verdict["keyId"]], strict_b64(signature["sig"], "verdict signature"), message):
            problems.append(f"verdict {verdict['sha256'][:12]} signature invalid")
    return problems

def matrix_verdict_closure():
    problems = []
    catalog = {v["sha256"]: set(v["cellKeys"]) for v in json.loads(read("verdicts.json"))["verdicts"]}
    for cell in json.loads(read("matrix.json"))["cells"]:
        for ref in cell.get("verdicts", []) + cell.get("validVerdicts", []):
            digest = ref.split(":", 1)[1]
            if digest not in catalog:
                problems.append(f"cell {cell['cellKey']} cites uncataloged verdict {digest[:12]}"); continue
            if cell["cellKey"] not in catalog[digest]:
                problems.append(f"verdict {digest[:12]} does not name cell {cell['cellKey']}")
            if not os.path.exists(os.path.join(root, "records", f"{digest}.bin")):
                problems.append(f"verdict record {digest[:12]} missing from the store")
    return problems

def claim_mirror():
    if "headline" not in claim:
        return "skip"  # comparison-shaped (paired-delta) claims carry no headline to mirror
    report = json.loads(read("report.json"))
    arms = report["results"]["perSubject"][0]["results"]["arms"]
    return [] if claim["headline"] == arms else ["claim headline disagrees with the signed report's results"]

def key_derivations():
    problems = []
    spki = strict_b64(trust["report"]["spkiDerBase64"], "report SPKI")
    if len(spki) != 44 or spki[:12] != bytes([0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x03, 0x21, 0x00]):
        problems.append("report SPKI is not a 44-byte Ed25519 SubjectPublicKeyInfo")
    else:
        derived = "did:key:z" + b58(bytes([0xED, 0x01]) + spki[-32:])
        if not (derived == trust["report"]["didKey"] == trust["report"]["keyId"] == trust["report"]["author"]):
            problems.append("report did:key/author does not derive from the carried SPKI")
    for evaluator in trust["evaluators"]:
        expected = "benchmark-product-verdict-" + sha256(strict_b64(evaluator["spkiDerBase64"], "evaluator SPKI"))[:16]
        if evaluator["keyId"] != expected:
            problems.append(f"evaluator keyId {evaluator['keyId']} does not derive from its SPKI")
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
