from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

def test_doctor_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
