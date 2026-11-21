# SPDX-License-Identifier: MIT
"""Layer 5 tests for tools/validate_okf.py (OKF v0.2 §11 conformance + --strict producer lint)."""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import validate_okf  # noqa: E402


def test_repo_docs_pass_both_modes() -> None:
    docs = REPO_ROOT / "docs"
    conformance = validate_okf.validate_bundle(docs, strict=False)
    assert conformance.errors == [], f"Conformance errors: {conformance.errors}"

    strict = validate_okf.validate_bundle(docs, strict=True)
    assert strict.errors == [], f"Strict errors: {strict.errors}"


def test_does_not_mutate_global_yaml_safe_loader(tmp_path: Path) -> None:
    """Regression test for I7: validate_okf must NOT strip timestamps from yaml.SafeLoader."""
    (tmp_path / "index.md").write_text("---\nokf_version: \"0.2\"\n---\n\n# Root\n", encoding="utf-8")
    validate_okf.validate_bundle(tmp_path, strict=True)

    parsed = yaml.safe_load("2026-11-21T15:00:00Z")
    assert isinstance(parsed, dt.datetime)


def test_permissive_conformance_tolerates_minimal_concept_and_broken_link(tmp_path: Path) -> None:
    (tmp_path / "minimal.md").write_text(
        "---\ntype: CustomThing\ncustom_ext: 123\n---\n\nSee [future](./does-not-exist.md).\n",
        encoding="utf-8",
    )
    res = validate_okf.validate_bundle(tmp_path, strict=False)
    assert res.errors == []

    # Same fixture fails --strict because of missing generated/title/description and broken link.
    strict_res = validate_okf.validate_bundle(tmp_path, strict=True)
    assert len(strict_res.errors) >= 2


def test_accepts_bare_verified_inline_code_tilde_fences_and_link_titles(tmp_path: Path) -> None:
    (tmp_path / "index.md").write_text("---\nokf_version: \"0.2\"\n---\n\n# Root\n", encoding="utf-8")
    (tmp_path / "target.md").write_text(
        "---\n"
        "type: Reference\n"
        "title: Target\n"
        "description: Linked target.\n"
        "generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }\n"
        "---\n\nTarget.\n",
        encoding="utf-8",
    )
    (tmp_path / "doc.md").write_text(
        "---\n"
        "type: Reference\n"
        "title: Code & Link Edge Cases\n"
        "description: Verifies inline code, tilde fences, and link titles.\n"
        "status: stable\n"
        "resource: ./target.md\n"
        "generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }\n"
        "verified: { by: human:jpdsmith, at: 2026-11-21T15:05:00+00:00 }\n"
        "sources:\n"
        "  - id: tgt\n"
        "    resource: ./target.md\n"
        "    author: team:vernie\n"
        "---\n\n"
        "See [target](target.md \"Target Doc\")[^tgt] and ignore `[^fake]` or `[nope](missing.md)`.\n\n"
        "~~~\n"
        "[^inside_tilde] and [broken](nope.md)\n"
        "# Citations\n"
        "~~~\n\n"
        "[^tgt]: Target reference.\n",
        encoding="utf-8",
    )
    res = validate_okf.validate_bundle(tmp_path, strict=True)
    assert res.errors == [], f"Unexpected errors: {res.errors}"


def test_negative_fixtures_caught_by_strict(tmp_path: Path) -> None:
    # Unquoted float okf_version: 0.2 -> must fail strict mode!
    (tmp_path / "index.md").write_text("---\nokf_version: 0.2\n---\n\n# Root\n", encoding="utf-8")
    sub = tmp_path / "sub"
    sub.mkdir()
    # Nested index.md with frontmatter -> MUST fail even in §11 mode!
    (sub / "index.md").write_text("---\ntype: Bad\n---\n\n# Sub\n", encoding="utf-8")
    # Bad concept: legacy timestamp, naive datetime, invalid status, dangling footnote,
    # orphan footnote def, duplicate sources[].id, broken relative resource, root-anchored link.
    (sub / "bad.md").write_text(
        "---\n"
        "type: Hardware Spec\n"
        "title: Bad\n"
        "description: Bad doc.\n"
        "status: bogus\n"
        "resource: ./missing_file.c\n"
        "timestamp: 2026-11-21T15:00:00Z\n"
        "generated: { by: invalid_actor, at: 2026-11-21T15:00:00 }\n"
        "sources:\n"
        "  - id: s1\n"
        "    resource: ./also_missing.md\n"
        "  - id: s1\n"
        "    title: Missing resource + dup id\n"
        "---\n\nClaim.[^missing] [root](/index.md)\n\n"
        "[^orphan]: Unused footnote.\n\n"
        "# Citations\n- old\n",
        encoding="utf-8",
    )
    # Committed runtime receipt -> forbidden in strict mode.
    (sub / "build_receipt.json").write_text("{}", encoding="utf-8")

    conf = validate_okf.validate_bundle(tmp_path, strict=False)
    assert any("Nested index.md" in e for e in conf.errors)

    strict = validate_okf.validate_bundle(tmp_path, strict=True)
    joined = "\n".join(strict.errors)
    assert "quoted string okf_version" in joined
    assert "timestamp" in joined
    assert "# Citations" in joined
    assert "Invalid status" in joined
    assert "explicit UTC offset" in joined
    assert "Invalid generated.by actor" in joined
    assert "does not exist" in joined
    assert "Duplicate sources[].id" in joined
    assert "[^missing]" in joined
    assert "Orphan footnote" in joined
    assert "root-anchored '/index.md'" in joined
    assert "Runtime receipt" in joined


def test_log_md_calendar_date_duplicates_order_and_code_fences(tmp_path: Path) -> None:
    (tmp_path / "index.md").write_text("---\nokf_version: \"0.2\"\n---\n\n# Root\n", encoding="utf-8")
    (tmp_path / "log.md").write_text(
        "# Log\n\n"
        "## 2026-02-31\nInvalid calendar day.\n\n"
        "## 2026-11-20\nOlder first.\n\n"
        "## 2026-11-21\nNewer second.\n\n"
        "## 2026-11-21\nDuplicate date.\n\n"
        "```markdown\n## Not a real date heading\n```\n",
        encoding="utf-8",
    )
    strict = validate_okf.validate_bundle(tmp_path, strict=True)
    joined = "\n".join(strict.errors)
    assert "not a valid calendar date" in joined
    assert "Duplicate date heading" in joined
    assert "newest-first" in joined
    assert "Not a real date heading" not in joined


def test_non_string_attested_computation_fields_do_not_crash(tmp_path: Path) -> None:
    (tmp_path / "index.md").write_text("---\nokf_version: \"0.2\"\n---\n\n# Root\n", encoding="utf-8")
    (tmp_path / "comp.md").write_text(
        "---\n"
        "type: Attested Computation\n"
        "title: Broken Types\n"
        "description: Non-string resource paths must fail cleanly without TypeError.\n"
        "runtime: python3\n"
        "generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }\n"
        "parameters:\n"
        "  - { name: x, type: integer, required: true }\n"
        "computation: 123\n"
        "executor:\n"
        "  resource: 456\n"
        "  receipt: [sha256]\n"
        "attester:\n"
        "  resource: [not, a, string]\n"
        "---\n\nBody.\n",
        encoding="utf-8",
    )
    strict = validate_okf.validate_bundle(tmp_path, strict=True)
    joined = "\n".join(strict.errors)
    assert "'executor.resource' must be a non-empty string" in joined
    assert "'attester.resource' must be a non-empty string" in joined
    assert "'computation' must be a non-empty string" in joined
