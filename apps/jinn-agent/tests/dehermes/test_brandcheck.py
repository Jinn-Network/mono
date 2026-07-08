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

def test_allows_pip_install_hermes_agent_package_name():
    # bare `hermes-agent` in a pip-install invocation is the real PyPI
    # package name (pyproject.toml `name = "hermes-agent"`) — e.g. the
    # aiohttp-missing message and the `--version` update-available banner.
    # Renaming it would tell users to install a package that doesn't exist.
    assert_no_upstream_brand("pip install 'hermes-agent[messaging]'")
    assert_no_upstream_brand("run 'uv pip install --upgrade hermes-agent'")


def test_still_flags_hermes_agent_outside_pip_install_context():
    # The pip-install anchor must not widen into a general "hermes-agent"
    # brand-string exemption — bare mentions outside that context are still
    # cosmetic branding and must still be flagged.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Welcome to hermes-agent!")


def test_allows_backup_filename_stem():
    # ~/hermes-backup-<timestamp>.zip is the literal filename backup --help
    # prints — filesystem truth, not a branding choice.
    assert_no_upstream_brand("default: ~/hermes-backup-<timestamp>.zip")

def test_allows_backup_filename_stem_when_argparse_wraps_it():
    # argparse's help formatter line-wraps long strings wherever it likes,
    # and does split this filename right after the hyphen in practice
    # (`backup --help`'s real output). The exemption must survive that.
    assert_no_upstream_brand("default: ~/hermes-\n                        backup-<timestamp>.zip")


def test_still_flags_hyphen_adjacent_toolset_key_spillover():
    # A bare `\b` boundary treats `-` as a non-word character, so it sits on
    # both sides of a hyphen and would let the toolset-key alternation match
    # `hermes-cli` inside `hermes-cli-extra` (leaving `-extra` behind, which
    # then passes because it no longer contains "hermes"). The exemption
    # must not spill onto adjacent hyphenated text like this.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Available toolsets: hermes-cli-extra")


def test_still_flags_hyphen_prefixed_toolset_key_spillover():
    # Same spillover risk from the other side: a real key embedded inside a
    # longer hyphenated token (e.g. a typo'd or namespaced variant) must
    # still be flagged rather than silently exempted.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("see prefix-hermes-slack for details")


def test_allows_hermes_root_flag_form_only():
    # Only the real flag spelling `--hermes-root` (as `desktop`/`gui --help`
    # actually print it) is exempt.
    assert_no_upstream_brand("[--ignore-existing] [--hermes-root HERMES_ROOT]")


def test_still_flags_bare_hermes_root():
    # Bare `hermes-root` (no `--` prefix) is not the real flag spelling and
    # must still be flagged as branding, not silently swallowed by a
    # too-broad exemption.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("hermes-root is the config key")


def test_allows_synchronous_as_ordinary_english_word():
    # A bare substring match for "nous" also matches inside ordinary English
    # words that have nothing to do with the brand, e.g. "synchronous" (the
    # real `--sync, --synchronous` flag help text on `curator run --help`).
    # The check must not flag legitimate prose just because it happens to
    # contain the brand string as a sub-word.
    assert_no_upstream_brand("--sync, --synchronous  wait for the review pass")
    assert_no_upstream_brand("an autonomous, anonymous, erroneous, harmonious result")


def test_allows_nous_xai_provider_default_phrase():
    # "Upstream provider: nous or xai (default: nous)" (proxy start / gateway
    # enroll --help) is the --provider flag's real choice/default value,
    # same category as a bare provider-id literal like the {nous, xai}
    # choices set — not cosmetic branding.
    assert_no_upstream_brand("Upstream provider: nous or xai (default: nous). See `jinn-agent proxy providers`.")


def test_allows_profile_gateway_service_unit_name():
    # hermes-gateway-<profile>.service is the real (non-legacy) per-profile
    # systemd/launchd unit name pattern `gateway migrate-legacy --help`
    # explicitly says it does NOT touch — filesystem truth, not branding.
    assert_no_upstream_brand("Profile units (hermes-gateway-<profile>.service) are untouched")


def test_allows_profile_gateway_service_unit_name_when_argparse_wraps_it():
    # Same line-wrap risk as the hermes-backup- filename stem: argparse's
    # help formatter does split this one right after the hyphen in practice
    # (`gateway migrate-legacy --help`'s real output).
    assert_no_upstream_brand(
        "Profile units (hermes-\ngateway-<profile>.service) and unrelated third-party services"
    )


def test_allows_nous_staff_infra_claim():
    # "viewable only by Nous staff" (debug share --help's --nous flag
    # description) is a factual claim about who operates/can view the real
    # private S3 bucket the --nous flag uploads to — same category as
    # "Nous-internal storage", not cosmetic branding.
    assert_no_upstream_brand(
        "The bundle is private — viewable only by Nous staff (and allowlisted "
        "Discord mods) via a Google-login-gated viewer."
    )


def test_still_flags_nous_adjacent_to_word_boundary():
    # The letter-boundary guard on "nous" must not overcorrect into ignoring
    # real branding — only a preceding letter (as in "synchro-NOUS") is
    # exempt; "Nous" at a word start, after a hyphen, or after whitespace
    # must still be caught.
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Logged in via Nous Portal")
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("account-nous-linked")
