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
