import pytest

from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

@pytest.mark.xfail(strict=True, reason="blocked on Task 8 auth.py sweep (hermes strings at auth.py:3178,3643) — remove when Task 8 lands")
def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

@pytest.mark.xfail(strict=True, reason="blocked on Task 8 auth.py sweep (hermes strings at auth.py:3178,3643) — remove when Task 8 lands")
def test_doctor_is_hermes_free(tmp_path):
    # Note: doctor's failure is not auth.py-only. It also prints the
    # `hermes-yuanbao` toolset identifier (toolsets.py:552, pre-existing,
    # out of scope for both Task 6 and Task 8 — toolset key naming is a
    # separate concern from CLI branding). The venv/bin/hermes and
    # ~/.local/bin/hermes filesystem-truth strings are exempted by
    # brandcheck.py's technical-token regex and are not part of this failure.
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
