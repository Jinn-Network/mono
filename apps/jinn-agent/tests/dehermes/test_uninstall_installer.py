from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def test_uninstall_and_installer_commands_hermes_free():
    checks = {
        "hermes_cli/uninstall.py": ["Hermes Agent Uninstaller", "Thank you for using Hermes Agent"],
        "cli.py": ["Hermes Agent CLI - Interactive Terminal Interface"],
        # installer must not tell users to run the `hermes` binary:
        "setup-hermes.sh": ["`hermes setup`", "run: hermes", "hermes setup"],
    }
    for rel, phrases in checks.items():
        src = (_REPO / rel).read_text()
        for p in phrases:
            assert p not in src, f"{rel}: leftover {p!r}"


def test_gateway_starting_banner_is_hermes_free_in_source():
    src = (_REPO / "hermes_cli" / "gateway.py").read_text()
    assert "Hermes Gateway Starting" not in src


def test_cli_docstrings_are_hermes_free_in_source():
    src = (_REPO / "cli.py").read_text()
    for phrase in (
        "Hermes Agent CLI - Interactive Terminal Interface",
        "Interactive CLI for the Hermes Agent.",
        "Hermes Agent CLI - Interactive AI Assistant",
    ):
        assert phrase not in src, f"cli.py: leftover {phrase!r}"


def test_subcommand_help_strings_are_hermes_free_in_source():
    checks = {
        "backup.py": ["Back up Hermes home directory", "Hermes configuration", "hermes-agent codebase"],
        "import_cmd.py": ["Restore a Hermes backup", "Hermes home directory"],
        "mcp.py": ["run Hermes as an MCP server", "Use 'hermes mcp add'", "'hermes mcp serve'"],
        "acp.py": ["Run Hermes Agent as an ACP", "Start Hermes Agent in ACP mode"],
        "profile.py": ["multiple isolated Hermes instances"],
        "dashboard.py": ["Start the Hermes backend server", "the Hermes backend server"],
        "logs.py": ["View and filter Hermes log files", "hermes logs "],
        "uninstall.py": ['help="Uninstall Hermes Agent"', "Remove Hermes Agent from your system"],
        "auth.py": ["Authenticate Hermes with Spotify"],
    }
    for rel, phrases in checks.items():
        src = (_REPO / "hermes_cli" / "subcommands" / rel).read_text()
        for p in phrases:
            assert p not in src, f"subcommands/{rel}: leftover {p!r}"


def test_parser_help_config_path_is_neutral_in_source():
    src = (_REPO / "hermes_cli" / "_parser.py").read_text()
    assert "~/.hermes/config.yaml" not in src
    # the legitimately-technical env var must still be present
    assert "HERMES_HOME" in src
