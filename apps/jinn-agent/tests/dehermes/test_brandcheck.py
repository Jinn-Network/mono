from tests.dehermes.brandcheck import assert_no_upstream_brand
import pytest

def test_allows_technical_tokens():
    assert_no_upstream_brand("HERMES_HOME=/x  module hermes_cli loaded")   # no raise

def test_flags_branding():
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Welcome to Hermes Agent!")

def test_allows_nous_module_tokens():
    # nous_* internal module names are technical, not branding (e.g. tracebacks)
    assert_no_upstream_brand("from hermes_cli.nous_account import x")

def test_still_flags_nous_branding():
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Created by Nous Research")

def test_allows_hermes_entry_point_paths():
    # venv/bin/hermes and ~/.local/bin/hermes are real on-disk paths (pip
    # entry point / install.sh symlink target) — filesystem truth, not a
    # branding choice, so `doctor`'s Command Installation section may say them.
    assert_no_upstream_brand("Venv entry point exists (venv/bin/hermes)")
    assert_no_upstream_brand("~/.local/bin/hermes → correct target")

def test_still_flags_bare_hermes_near_path_lookalikes():
    # Guard against over-widening: a bare "hermes" that isn't in the
    # bin/hermes path shape must still be flagged.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Welcome to Hermes")

def test_allows_real_toolset_keys():
    # hermes-* toolset registry keys (hermes_cli/platforms.py default_toolset
    # values) are technical identifiers users type in `-s` flags — not
    # branding. Controller ruling: exempt the explicit key list only.
    assert_no_upstream_brand("Available toolsets: hermes-yuanbao, hermes-slack, hermes-cli")
    assert_no_upstream_brand("⚠ hermes-yuanbao (system dependency not met)")

def test_still_flags_hermes_agent_brand_string_next_to_toolset_keys():
    # The explicit-list exemption must never widen into a `hermes-[a-z-]+`
    # pattern: "hermes-agent" is the brand string, not a toolset key, and
    # must still be caught even in a sentence that also mentions real keys.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("hermes-agent is great")
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("hermes-agent is great, see also hermes-slack")

def test_allows_backup_filename_stem():
    # ~/hermes-backup-<timestamp>.zip is the literal filename backup --help
    # prints — filesystem truth, not a branding choice.
    assert_no_upstream_brand("default: ~/hermes-backup-<timestamp>.zip")
