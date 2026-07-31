# Gate C7 rehearsal

    ./c7-rehearsal.sh

Requires `hermes`, `node` (>= 22), `npm`, `git`, and `yarn` on PATH. Writes only
to a temporary directory, which it prints on exit.

## What it proves

- The install channel's shape works: `hermes plugins install` from a git source,
  the plugin's own runtime acquisition, and the pinned-artifact assertion.
- A real Hermes session reaches the corpus moment against a seeded archive, and
  that session is itself captured.
- The doctor is green on a correct install, and each broken precondition prints
  the one command that fixes it - or says the break is not fixable from this
  machine.
- `disable` stops capture, retrieval, and the doctor; `remove` returns the host
  to stock.

## What it does not prove

- **The published path.** The runtime is installed from a local `npm pack`
  tarball, not from the registry, and the adapter from a local git remote, not
  from `Jinn-Network/jinn-plugin`. Real-registry acquisition and the mirror are
  C8's four-layer gate (spec 9.3).
- **A populated public corpus.** The archive is seeded locally; the public plane
  is empty in this branch, which is the honest state today.
- **Model quality.** The rehearsal asserts that a packet was provided, not that
  it was the right packet. Relevance is C6's adversarial fixture set.
