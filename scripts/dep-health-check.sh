#!/usr/bin/env bash
# Dependency health gate (Issue #58).
#
# The dependency tree contains deprecated / unmaintained transitive packages
# (e.g. eslint@8, glob@7, inflight@1.0.6, prebuild-install@7.1.3 — the last via
# better-sqlite3's native install path). These do not currently trigger a CVE but
# keep raising install/build risk. This script surfaces them on a periodic basis
# so they can be tracked and upgraded deliberately, rather than blocking a release
# by surprise.
#
# It is a reporting gate: it prints findings and exits 0. It does NOT fail the
# build on its own, because upgrading those transitive deps (jest/eslint/glob,
# better-sqlite3's prebuild chain) is a separate, riskier change tracked elsewhere.

set -uo pipefail

echo "== npm audit (prod only) =="
npm audit --omit=dev || true

echo
echo "== npm outdated (prod only) =="
npm outdated --omit=dev || true

echo
echo "== Known deprecated / abandoned transitive packages =="
# --all walks the full tree; failures (package not present) are expected and ignored.
npm ls glob@7.2.3 eslint@8.7.1 prebuild-install@7.1.3 inflight@1.0.6 --all || true

echo
echo "Dependency health check complete."
