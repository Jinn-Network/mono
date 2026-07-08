"""Toolset-key rename regression tests (hermes-* → jinn-*).

The static platform-bundle keys in toolsets.py are canonically ``jinn-*``;
legacy ``hermes-*`` spellings must keep working anywhere a toolset name is
read (configs written before the rename, or shared with a stock upstream
install via HERMES_HOME), but must never be produced by the CLI itself —
see tests/dehermes/brandcheck.py, which no longer exempts them.
"""

from toolsets import (
    LEGACY_TOOLSET_BUNDLE_PREFIX,
    TOOLSET_BUNDLE_PREFIX,
    TOOLSETS,
    canonical_toolset_name,
    get_toolset,
    resolve_toolset,
    validate_toolset,
)


def test_static_toolset_keys_are_brand_free():
    for key in TOOLSETS:
        assert "hermes" not in key.lower(), f"upstream brand in toolset key {key!r}"


def test_gateway_bundle_includes_are_brand_free():
    for inc in TOOLSETS["jinn-gateway"]["includes"]:
        assert inc.startswith(TOOLSET_BUNDLE_PREFIX), inc
        assert inc in TOOLSETS, f"jinn-gateway includes unknown bundle {inc!r}"


def test_legacy_names_resolve_to_same_tools():
    for key in TOOLSETS:
        if not key.startswith(TOOLSET_BUNDLE_PREFIX):
            continue
        legacy = LEGACY_TOOLSET_BUNDLE_PREFIX + key[len(TOOLSET_BUNDLE_PREFIX):]
        assert canonical_toolset_name(legacy) == key
        assert validate_toolset(legacy), f"legacy {legacy!r} no longer validates"
        assert resolve_toolset(legacy) == resolve_toolset(key), legacy
        assert get_toolset(legacy) == get_toolset(key), legacy


def test_legacy_mapping_does_not_hijack_unknown_names():
    # A registry/MCP toolset that merely happens to start with "hermes-"
    # must pass through untouched — only real static bundles are remapped.
    assert canonical_toolset_name("hermes-not-a-bundle") == "hermes-not-a-bundle"


def test_platform_default_toolsets_are_canonical():
    from hermes_cli.platforms import PLATFORMS

    for name, info in PLATFORMS.items():
        assert info.default_toolset.startswith(TOOLSET_BUNDLE_PREFIX), (
            f"platform {name!r} default_toolset {info.default_toolset!r} "
            f"is not a canonical jinn-* bundle"
        )
        assert info.default_toolset in TOOLSETS, info.default_toolset


def test_yuanbao_tools_register_into_canonical_bundle():
    # The doctor "Tool Availability" section prints registry toolset names;
    # yuanbao was the leak that motivated the rename (jinn-agent doctor
    # printed "hermes-yuanbao (system dependency not met)").
    import tools.yuanbao_tools as yb

    assert yb._TOOLSET == "jinn-yuanbao"
