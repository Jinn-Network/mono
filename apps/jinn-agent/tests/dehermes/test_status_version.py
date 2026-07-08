from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

def test_doctor_is_hermes_free(tmp_path):
    # The toolset keys doctor prints (e.g. the yuanbao bundle from
    # hermes_cli/platforms.py + tools/yuanbao_tools.py) are canonically
    # jinn-* since the toolset-key rename, so no exemption applies — any
    # hermes-<platform> string here is a real leak. The venv/bin/hermes and
    # ~/.local/bin/hermes filesystem-truth strings are exempted by
    # brandcheck.py's technical-token regex.
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
