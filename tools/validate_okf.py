#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Two-tier OKF v0.2 Knowledge Bundle Conformance Validator & Strict Producer Linter.

Default mode enforces normative OKF v0.2 §11 conformance ONLY:
  - Non-reserved .md files MUST begin with valid YAML frontmatter containing a non-empty `type`.
  - Reserved `index.md` files MUST NOT carry frontmatter, EXCEPT bundle-root `index.md` which
    MAY declare `okf_version`.
  - Reserved `log.md` files MUST NOT carry frontmatter and date headings MUST use valid ISO `YYYY-MM-DD`.
  - Missing optional fields, unknown keys/types, and broken links are tolerated per §11.

`--strict` mode enforces Vernie OS producer quality checks for CI:
  - Root `index.md` MUST declare string `okf_version: "0.2"` (and no other frontmatter keys).
  - No legacy v0.1 `timestamp` frontmatter key or `# Citations` body heading.
  - All datetimes (`generated.at`, `verified[].at`, `stale_after`, `sources[].last_modified`)
    MUST be ISO-8601 strings with explicit UTC offset (`Z` or `±HH:MM`).
  - `generated.by` and `verified[].by` MUST follow §7 actor convention
    (`<producer>/<version>`, `human:<id>`, or `process:<id>`).
  - `sources` entries MUST include `resource` (with relative paths existing on disk) and unique `id`s;
    `sources[].author` allows standard actors or `team:<id>`.
  - Every inline footnote citation `[^id]` MUST resolve to both a `sources[].id` entry and a
    matching `[^id]: ...` body footnote definition; orphan definitions are flagged.
  - `type: Attested Computation` concepts MUST declare `runtime`, `parameters`, `executor`
    (`resource` + `receipt`), `attester` (`resource`), and either `computation` path or an inline
    `# Computation` code block.
  - All relative markdown links within the bundle MUST resolve to existing files/directories.
  - No runtime receipt JSON artifacts committed inside the bundle.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path
from typing import Any

import yaml

RESERVED_FILENAMES = {"index.md", "log.md"}
VALID_STATUSES = {"draft", "stable", "deprecated"}

# Actor convention per OKF v0.2 §7 (+ team:<id> permitted on sources[].author per §5.1/Appendix A)
ACTOR_RE = re.compile(r"^(human:[A-Za-z0-9._-]+|process:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$")
SOURCE_AUTHOR_RE = re.compile(
    r"^(human:[A-Za-z0-9._-]+|process:[A-Za-z0-9._-]+|team:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$"
)
ISO_OFFSET_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
LOG_DATE_H2_RE = re.compile(r"^##\s+(.+?)\s*$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FOOTNOTE_USE_RE = re.compile(r"\[\^([A-Za-z0-9._-]+)\](?!:)")
FOOTNOTE_DEF_RE = re.compile(r"^\[\^([A-Za-z0-9._-]+)\]:\s*\S", re.MULTILINE)
MD_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\n]+)\)")
INLINE_CODE_RE = re.compile(r"(`+)(?:(?!\1).)*?\1")


# Module-level SafeLoader subclass with a copied resolver dict so yaml.SafeLoader is NEVER mutated.
class NoDateSafeLoader(yaml.SafeLoader):
    pass


NoDateSafeLoader.yaml_implicit_resolvers = {
    ch: [(tag, regexp) for tag, regexp in mappings if tag != "tag:yaml.org,2002:timestamp"]
    for ch, mappings in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class ValidationReport:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.files_checked: int = 0

    def add_error(self, path: Path, msg: str) -> None:
        self.errors.append(f"{path}: {msg}")


def split_frontmatter(text: str) -> tuple[bool, str | None, str]:
    """Return (has_frontmatter, raw_yaml, body). Does not parse YAML yet."""
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return False, None, text
    lines = text.splitlines(keepends=True)
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            raw_yaml = "".join(lines[1:idx])
            body = "".join(lines[idx + 1 :])
            return True, raw_yaml, body
    return True, None, text  # Unclosed frontmatter fence


def parse_yaml_preserving_strings(raw_yaml: str) -> Any:
    """Parse YAML while keeping ISO datetimes as raw strings without mutating yaml.SafeLoader."""
    return yaml.load(raw_yaml, Loader=NoDateSafeLoader)


def check_iso_datetime(value: Any, field: str, path: Path, report: ValidationReport) -> None:
    if not isinstance(value, str) or not ISO_OFFSET_RE.match(value):
        report.add_error(
            path, f"'{field}' must be an ISO-8601 datetime with explicit UTC offset (got {value!r})"
        )
        return
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        report.add_error(path, f"'{field}' is not a valid calendar datetime: {value!r}")


def strip_fenced_code(body: str) -> str:
    """Strip ``` and ~~~ fenced code blocks before scanning prose or headings."""
    out_lines: list[str] = []
    fence_char: str | None = None
    fence_len = 0
    for line in body.splitlines():
        stripped = line.lstrip()
        if fence_char is None:
            m = re.match(r"^(`{3,}|~{3,})", stripped)
            if m:
                fence_char = m.group(1)[0]
                fence_len = len(m.group(1))
                continue
            out_lines.append(line)
        else:
            if re.match(rf"^{re.escape(fence_char)}{{{fence_len},}}\s*$", stripped):
                fence_char = None
                fence_len = 0
    return "\n".join(out_lines)


def strip_code_and_inline(body: str) -> str:
    """Strip fenced code blocks AND inline backtick spans before scanning links or footnotes."""
    no_fences = strip_fenced_code(body)
    return INLINE_CODE_RE.sub("", no_fences)


def extract_link_target(raw_dest: str) -> str:
    """Parse markdown link destination, stripping optional angle brackets and title text."""
    s = raw_dest.strip()
    if s.startswith("<") and ">" in s:
        s = s[1 : s.index(">")]
    else:
        # Strip optional title (`path "title"` or `path 'title'`)
        s = re.split(r"\s+", s, maxsplit=1)[0]
    return s.split("#", 1)[0].split("?", 1)[0]


def is_external_uri(target: str) -> bool:
    return target.startswith(("http://", "https://", "mailto:", "file://"))


def check_relative_resource(
    value: Any, field: str, md_path: Path, bundle_root: Path, report: ValidationReport
) -> None:
    if not isinstance(value, str) or not value.strip():
        report.add_error(md_path, f"'{field}' must be a non-empty string (got {value!r})")
        return
    if is_external_uri(value):
        return
    if value.startswith("/"):
        report.add_error(
            md_path,
            f"'{field}' should be a relative path instead of root-anchored '{value}'",
        )
        return
    if not (md_path.parent / value).resolve().exists() and not (bundle_root / value).resolve().exists():
        report.add_error(md_path, f"'{field}' relative path '{value}' does not exist")


def check_relative_links(md_path: Path, body: str, bundle_root: Path, report: ValidationReport) -> None:
    prose = strip_code_and_inline(body)
    for raw_dest in MD_LINK_RE.findall(prose):
        target = extract_link_target(raw_dest)
        if not target or is_external_uri(target):
            continue
        if target.startswith("/"):
            # Flag bundle-root '/' links in strict mode since bundle lives in docs/ (breaks on GitHub).
            report.add_error(
                md_path,
                f"Use relative link instead of root-anchored '{target}' so GitHub UI resolves cleanly",
            )
            continue
        resolved = (md_path.parent / target).resolve()
        if not resolved.exists():
            report.add_error(md_path, f"Broken relative link '{target}' -> {resolved}")


def validate_index_file(
    md_path: Path, is_root: bool, text: str, bundle_root: Path, strict: bool, report: ValidationReport
) -> None:
    has_fm, raw_fm, body = split_frontmatter(text)
    if not is_root:
        if has_fm:
            report.add_error(md_path, "Nested index.md MUST NOT contain YAML frontmatter (OKF §8)")
    else:
        if has_fm:
            if raw_fm is None:
                report.add_error(md_path, "Unclosed YAML frontmatter fence in root index.md")
                return
            try:
                fm = parse_yaml_preserving_strings(raw_fm)
            except yaml.YAMLError as exc:
                report.add_error(md_path, f"Invalid YAML frontmatter: {exc}")
                return
            if not isinstance(fm, dict):
                report.add_error(md_path, "Root index.md frontmatter must be a YAML mapping")
                return
            extra_keys = set(fm.keys()) - {"okf_version"}
            if extra_keys:
                report.add_error(
                    md_path,
                    f"Root index.md frontmatter may ONLY declare 'okf_version' (unexpected: {sorted(extra_keys)})",
                )
            okf_ver = fm.get("okf_version")
            if strict and (not isinstance(okf_ver, str) or okf_ver != "0.2"):
                report.add_error(
                    md_path,
                    f"Root index.md must declare quoted string okf_version: \"0.2\" (got {okf_ver!r})",
                )
        elif strict:
            report.add_error(md_path, "Root index.md must declare okf_version: \"0.2\" in frontmatter")

    if strict:
        check_relative_links(md_path, body, bundle_root, report)


def validate_log_file(
    md_path: Path, text: str, bundle_root: Path, strict: bool, report: ValidationReport
) -> None:
    has_fm, _, body = split_frontmatter(text)
    if has_fm:
        report.add_error(md_path, "Reserved log.md MUST NOT contain YAML frontmatter (OKF §9)")

    dates: list[str] = []
    seen_dates: set[str] = set()
    for line in strip_fenced_code(body).splitlines():
        m = LOG_DATE_H2_RE.match(line)
        if m:
            heading = m.group(1)
            if not ISO_DATE_RE.match(heading):
                report.add_error(md_path, f"log.md date heading must be ISO YYYY-MM-DD (got {heading!r})")
                continue
            try:
                dt.date.fromisoformat(heading)
            except ValueError:
                report.add_error(md_path, f"log.md date heading is not a valid calendar date: {heading!r}")
                continue
            if strict and heading in seen_dates:
                report.add_error(md_path, f"Duplicate date heading in log.md: {heading!r}")
            seen_dates.add(heading)
            dates.append(heading)
    if strict and dates != sorted(dates, reverse=True):
        report.add_error(md_path, f"log.md date headings must be newest-first (found {dates})")
    if strict:
        check_relative_links(md_path, body, bundle_root, report)


def validate_concept_file(
    md_path: Path, text: str, bundle_root: Path, strict: bool, report: ValidationReport
) -> None:
    has_fm, raw_fm, body = split_frontmatter(text)
    if not has_fm:
        report.add_error(md_path, "Concept document missing required YAML frontmatter (OKF §4/§11)")
        return
    if raw_fm is None:
        report.add_error(md_path, "Unclosed YAML frontmatter fence")
        return

    try:
        fm = parse_yaml_preserving_strings(raw_fm)
    except yaml.YAMLError as exc:
        report.add_error(md_path, f"Malformed YAML frontmatter: {exc}")
        return

    if not isinstance(fm, dict):
        report.add_error(md_path, "YAML frontmatter must be a mapping")
        return

    concept_type = fm.get("type")
    if not isinstance(concept_type, str) or not concept_type.strip():
        report.add_error(md_path, "Concept document missing required non-empty 'type' field (OKF §4.1/§11)")
        return

    # §10.2: `runtime` is required for Attested Computation
    if concept_type == "Attested Computation":
        runtime = fm.get("runtime")
        if not isinstance(runtime, str) or not runtime.strip():
            report.add_error(md_path, "Attested Computation missing required 'runtime' field (OKF §10.2)")

    if not strict:
        return

    # --- Strict OKF v0.2 producer lint checks ---
    if "timestamp" in fm:
        report.add_error(md_path, "Legacy v0.1 'timestamp' key forbidden; use 'generated: { by, at }' (OKF §13.1)")

    body_no_fences = strip_fenced_code(body)
    if re.search(r"^#\s+Citations\s*$", body_no_fences, re.MULTILINE):
        report.add_error(md_path, "Legacy v0.1 '# Citations' body heading forbidden; use frontmatter 'sources' (OKF §13.1)")

    for rec in ("title", "description"):
        if not isinstance(fm.get(rec), str) or not fm[rec].strip():
            report.add_error(md_path, f"Missing recommended non-empty '{rec}' field")

    if "status" in fm and fm["status"] not in VALID_STATUSES:
        report.add_error(md_path, f"Invalid status {fm['status']!r}; expected one of {sorted(VALID_STATUSES)}")

    if "resource" in fm:
        check_relative_resource(fm["resource"], "resource", md_path, bundle_root, report)

    # generated: { by, at }
    gen = fm.get("generated")
    if not isinstance(gen, dict):
        report.add_error(md_path, "Missing 'generated: { by, at }' mapping")
    else:
        by = gen.get("by")
        if not isinstance(by, str) or not ACTOR_RE.match(by):
            report.add_error(md_path, f"Invalid generated.by actor {by!r} (OKF §7)")
        check_iso_datetime(gen.get("at"), "generated.at", md_path, report)

    # verified: bare { by, at } OR list of { by, at } (OKF §5.2)
    if "verified" in fm:
        ver_raw = fm["verified"]
        ver_list = [ver_raw] if isinstance(ver_raw, dict) else ver_raw
        if not isinstance(ver_list, list) or not ver_list:
            report.add_error(md_path, "'verified' must be a { by, at } mapping or non-empty list of mappings")
        else:
            for idx, entry in enumerate(ver_list):
                if not isinstance(entry, dict):
                    report.add_error(md_path, f"verified[{idx}] must be a mapping")
                    continue
                vby = entry.get("by")
                if not isinstance(vby, str) or not ACTOR_RE.match(vby):
                    report.add_error(md_path, f"Invalid verified[{idx}].by actor {vby!r} (OKF §7)")
                check_iso_datetime(entry.get("at"), f"verified[{idx}].at", md_path, report)

    if "stale_after" in fm:
        check_iso_datetime(fm["stale_after"], "stale_after", md_path, report)

    # sources + keyed footnotes
    source_ids: set[str] = set()
    if "sources" in fm:
        sources = fm["sources"]
        if not isinstance(sources, list):
            report.add_error(md_path, "'sources' must be a list")
        else:
            for idx, src in enumerate(sources):
                if not isinstance(src, dict):
                    report.add_error(md_path, f"sources[{idx}] must be a mapping")
                    continue
                check_relative_resource(src.get("resource"), f"sources[{idx}].resource", md_path, bundle_root, report)
                if "id" in src:
                    sid = src["id"]
                    if not isinstance(sid, str) or not sid.strip():
                        report.add_error(md_path, f"sources[{idx}].id must be a non-empty string")
                    elif sid in source_ids:
                        report.add_error(md_path, f"Duplicate sources[].id {sid!r}")
                    else:
                        source_ids.add(sid)
                if "author" in src:
                    author = src["author"]
                    if not isinstance(author, str) or not SOURCE_AUTHOR_RE.match(author):
                        report.add_error(md_path, f"Invalid sources[{idx}].author {author!r}")
                if "last_modified" in src:
                    check_iso_datetime(src["last_modified"], f"sources[{idx}].last_modified", md_path, report)

    prose = strip_code_and_inline(body)
    used_footnotes = set(FOOTNOTE_USE_RE.findall(prose))
    defined_footnotes = set(FOOTNOTE_DEF_RE.findall(body_no_fences))
    for fid in sorted(used_footnotes):
        if fid not in source_ids:
            report.add_error(md_path, f"Inline footnote [^{fid}] has no matching sources[].id")
        if fid not in defined_footnotes:
            report.add_error(md_path, f"Inline footnote [^{fid}] missing body definition '[^{fid}]: ...'")
    for fid in sorted(defined_footnotes - used_footnotes):
        report.add_error(md_path, f"Orphan footnote definition '[^{fid}]: ...' is never cited in body")

    # Attested Computation strict contract (§10.2–§10.3)
    if concept_type == "Attested Computation":
        params = fm.get("parameters")
        if not isinstance(params, list) or not params:
            report.add_error(md_path, "Attested Computation must declare non-empty 'parameters' list")
        else:
            for idx, p in enumerate(params):
                if not isinstance(p, dict) or not {"name", "type", "required"}.issubset(p.keys()):
                    report.add_error(md_path, f"parameters[{idx}] must declare name, type, required")

        executor = fm.get("executor")
        if not isinstance(executor, dict) or not isinstance(executor.get("receipt"), list):
            report.add_error(md_path, "Attested Computation 'executor' must declare 'resource' and 'receipt' list")
        else:
            check_relative_resource(executor.get("resource"), "executor.resource", md_path, bundle_root, report)

        attester = fm.get("attester")
        if not isinstance(attester, dict):
            report.add_error(md_path, "Attested Computation 'attester' must declare 'resource'")
        else:
            check_relative_resource(attester.get("resource"), "attester.resource", md_path, bundle_root, report)

        comp_path = fm.get("computation")
        has_inline_comp = bool(re.search(r"^#\s+Computation\s*$", body_no_fences, re.MULTILINE))
        if comp_path is None and not has_inline_comp:
            report.add_error(md_path, "Attested Computation must set 'computation' path or include '# Computation' section")
        elif comp_path is not None:
            check_relative_resource(comp_path, "computation", md_path, bundle_root, report)

    check_relative_links(md_path, body, bundle_root, report)


def validate_bundle(bundle_root: Path, strict: bool = False) -> ValidationReport:
    report = ValidationReport()
    bundle_root = bundle_root.resolve()
    if not bundle_root.is_dir():
        report.add_error(bundle_root, "Bundle root directory does not exist")
        return report

    if strict:
        for receipt in bundle_root.rglob("*receipt*.json"):
            report.add_error(receipt, "Runtime receipt artifacts MUST NOT be committed inside OKF bundle (OKF §10.5)")

    for md_path in sorted(bundle_root.rglob("*.md")):
        report.files_checked += 1
        text = md_path.read_text(encoding="utf-8")
        if md_path.name == "index.md":
            validate_index_file(
                md_path,
                is_root=(md_path.parent == bundle_root),
                text=text,
                bundle_root=bundle_root,
                strict=strict,
                report=report,
            )
        elif md_path.name == "log.md":
            validate_log_file(md_path, text, bundle_root, strict, report)
        else:
            validate_concept_file(md_path, text, bundle_root, strict, report)

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an OKF v0.2 knowledge bundle.")
    parser.add_argument("bundle", type=Path, help="Path to OKF bundle root (e.g. docs/)")
    parser.add_argument("--strict", action="store_true", help="Enable CI producer lint checks")
    args = parser.parse_args()

    report = validate_bundle(args.bundle, strict=args.strict)
    mode = "strict" if args.strict else "conformance (§11)"
    if report.errors:
        print(f"OKF v0.2 validation FAILED ({mode}, {report.files_checked} files):", file=sys.stderr)
        for err in report.errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(f"OKF v0.2 validation PASSED ({mode}, {report.files_checked} files checked).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
