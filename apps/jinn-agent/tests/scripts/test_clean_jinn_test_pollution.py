"""Regression coverage for the one-time Jinn fixture-pollution cleanup."""

from __future__ import annotations

import importlib.util
import json
import stat
import tarfile
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[2] / "scripts" / "clean_jinn_test_pollution.py"
SPEC = importlib.util.spec_from_file_location("clean_jinn_test_pollution", SCRIPT)
assert SPEC and SPEC.loader
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


def _write_record(path: Path, *, session_id: str, episode_id: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "session": {
            "sessionId": session_id,
            "capturedAt": "2026-07-17T00:00:00Z",
        },
        "task": {"summary": "fixture or real work"},
    }
    if episode_id is not None:
        record.update(
            {
                "schemaVersion": "jinn.episode.v1",
                "episodeId": episode_id,
            }
        )
    path.write_text(json.dumps(record), encoding="utf-8")


def _write_mineable(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": "jinn.contribution-store.v3",
                "records": {
                    "s1-1784122564637021000": {
                        "recordId": "s1-1784122564637021000",
                    },
                    "20260717_010605_cf1edc-1784243166765569000": {
                        "recordId": "20260717_010605_cf1edc-1784243166765569000",
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def test_cleanup_removes_only_known_fixture_records_and_is_reversible(tmp_path):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    fixture_capture = paths.captures / "s1.json"
    real_capture = paths.captures / "20260717_010605_cf1edc.json"
    fixture_episode = paths.episodes / "sA-1784122567760469000.json"
    real_episode = (
        paths.episodes
        / "20260717_010605_cf1edc-1784243166765569000.episode.json"
    )
    _write_record(fixture_capture, session_id="s1")
    _write_record(real_capture, session_id="20260717_010605_cf1edc")
    _write_record(
        fixture_episode,
        session_id="sA",
        episode_id="sA-1784122567760469000",
    )
    _write_record(
        real_episode,
        session_id="20260717_010605_cf1edc",
        episode_id="20260717_010605_cf1edc-1784243166765569000",
    )
    _write_mineable(paths.mineable_store)

    plan = cleanup.build_cleanup_plan(paths)

    assert plan.files == (fixture_capture, fixture_episode)
    assert plan.mineable_record_ids == ("s1-1784122564637021000",)

    backup = paths.root / ".pollution-backup-test.tgz"
    cleanup.apply_cleanup(plan, backup)

    assert not fixture_capture.exists()
    assert not fixture_episode.exists()
    assert real_capture.exists()
    assert real_episode.exists()
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600
    mineable = json.loads(paths.mineable_store.read_text(encoding="utf-8"))
    assert list(mineable["records"]) == [
        "20260717_010605_cf1edc-1784243166765569000"
    ]
    with tarfile.open(backup, "r:gz") as archive:
        assert set(archive.getnames()) == {
            ".jinn-client/harness-layer/captures/s1.json",
            ".jinn-client/harness-layer/episodes/sA-1784122567760469000.json",
            ".jinn-client/mineable/mineable-traces.json",
        }


def test_cleanup_refuses_store_path_outside_expected_root(tmp_path):
    paths = cleanup.StorePaths(
        home=tmp_path / "home",
        root=tmp_path / "home" / ".jinn-client",
        captures=tmp_path / "outside" / "captures",
        episodes=tmp_path / "home" / ".jinn-client" / "episodes",
        mineable_store=tmp_path / "home" / ".jinn-client" / "mineable" / "mineable-traces.json",
    )

    with pytest.raises(cleanup.UnsafeCleanupPath, match="outside"):
        cleanup.build_cleanup_plan(paths)


def test_cleanup_refuses_symlinked_store_ancestor(tmp_path):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    outside = tmp_path / "outside"
    outside.mkdir()
    paths.root.mkdir(parents=True)
    (paths.root / "harness-layer").symlink_to(outside, target_is_directory=True)

    with pytest.raises(cleanup.UnsafeCleanupPath, match="symlink"):
        cleanup.build_cleanup_plan(paths)


def test_cleanup_refuses_contribution_store_changed_after_inspection(tmp_path):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    fixture_capture = paths.captures / "s1.json"
    _write_record(fixture_capture, session_id="s1")
    _write_mineable(paths.mineable_store)
    plan = cleanup.build_cleanup_plan(paths)
    changed = json.loads(paths.mineable_store.read_text(encoding="utf-8"))
    changed["records"]["new-production-record"] = {
        "recordId": "new-production-record",
        "candidate": {"sourceId": "new-production-record"},
    }
    paths.mineable_store.write_text(json.dumps(changed), encoding="utf-8")

    with pytest.raises(cleanup.CleanupDataError, match="changed after inspection"):
        cleanup.apply_cleanup(
            plan,
            paths.root / ".pollution-backup-test.tgz",
        )

    assert fixture_capture.exists()
    assert "new-production-record" in json.loads(
        paths.mineable_store.read_text(encoding="utf-8")
    )["records"]


def test_cleanup_refuses_fixture_replaced_with_legitimate_record(tmp_path):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    selected = paths.captures / "s1.json"
    _write_record(selected, session_id="s1")
    plan = cleanup.build_cleanup_plan(paths)

    selected.unlink()
    _write_record(selected, session_id="20260719_ordinary_work")

    with pytest.raises(cleanup.CleanupDataError, match="changed after inspection"):
        cleanup.apply_cleanup(
            plan,
            paths.root / ".pollution-backup-test.tgz",
        )

    assert json.loads(selected.read_text(encoding="utf-8"))["session"][
        "sessionId"
    ] == "20260719_ordinary_work"


def test_cleanup_refuses_symlinked_record(tmp_path):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    outside = tmp_path / "outside.json"
    _write_record(outside, session_id="s1")
    paths.captures.mkdir(parents=True)
    (paths.captures / "s1.json").symlink_to(outside)

    with pytest.raises(cleanup.UnsafeCleanupPath, match="symlink"):
        cleanup.build_cleanup_plan(paths)


def test_cleanup_backup_is_private_from_creation_when_archive_fails(
    tmp_path,
    monkeypatch,
):
    home = tmp_path / "home"
    paths = cleanup.store_paths(home)
    fixture_capture = paths.captures / "s1.json"
    _write_record(fixture_capture, session_id="s1")
    plan = cleanup.build_cleanup_plan(paths)
    backup = paths.root / ".pollution-backup-test.tgz"
    modes_during_archive = []

    def fail_mid_archive(_archive, _source, **_kwargs):
        modes_during_archive.append(stat.S_IMODE(backup.stat().st_mode))
        raise tarfile.TarError("forced mid-archive failure")

    monkeypatch.setattr(tarfile.TarFile, "add", fail_mid_archive)

    with pytest.raises(tarfile.TarError, match="forced mid-archive failure"):
        cleanup.apply_cleanup(plan, backup)

    assert modes_during_archive == [0o600]
    assert not backup.exists()
    assert fixture_capture.exists()
