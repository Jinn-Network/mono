from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def test_no_hermes_in_user_facing_prints():
    # These strings are printed to users; none may carry upstream branding.
    banned = [
        ("hermes_cli/main.py",   ["Hermes post-install bootstrap", "Updating Hermes Agent", "prefixed with 'Hermes Agent'"]),
        ("hermes_cli/cli_commands_mixin.py", ["Update Hermes Agent"]),
        ("hermes_cli/auth.py",   [
            "authorize Hermes",
            "Starting Hermes login",
            "to use Hermes.",
            "Run `hermes auth` to authenticate",
            "Run `hermes auth` to re-authenticate",
            "found in Hermes auth store",
            "Hermes will create its own session",
            "Hermes will keep working independently",
            "Hermes creates its own",
            "Run `hermes model` again to switch",
            "Hermes will use OpenRouter for inference",
            "Use 'hermes auth' to manage credentials",
        ]),
        ("hermes_cli/nous_account.py", [
            "Hermes could not verify",
            "but Hermes cannot verify",
            "run `hermes model`",
            "Run `hermes model`",
        ]),
        ("hermes_cli/portal_cli.py", ["Set up Nous Portal"]),
        ("hermes_cli/subcommands/update.py", ["Update Hermes Agent"]),
    ]
    for rel, phrases in banned:
        src = (_REPO / rel).read_text()
        for p in phrases:
            assert p not in src, f"{rel}: leftover {p!r}"
