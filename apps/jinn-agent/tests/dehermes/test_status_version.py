import pytest

from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

@pytest.mark.xfail(strict=True, reason="doctor prints the `hermes-yuanbao` toolset identifier (toolsets.py:552, pre-existing, adjudicated at Task 10 — toolset key naming is a separate concern from CLI branding). The venv/bin/hermes and ~/.local/bin/hermes filesystem-truth strings are exempted by brandcheck.py's technical-token regex and are not part of this failure.")
def test_doctor_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
