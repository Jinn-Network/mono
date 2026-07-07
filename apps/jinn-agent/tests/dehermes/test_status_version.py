from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

def test_doctor_is_hermes_free(tmp_path):
    # doctor prints the `hermes-yuanbao` toolset identifier (default_toolset
    # in hermes_cli/platforms.py:40, bundle definition in tools/yuanbao_tools.py:500)
    # — a technical toolset key, not branding, exempted by brandcheck.py's
    # explicit _TOOLSET_KEYS list (Task 10 controller ruling). The
    # venv/bin/hermes and ~/.local/bin/hermes filesystem-truth strings are
    # exempted by brandcheck.py's technical-token regex separately.
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
