#!/usr/bin/env python3
"""
Local interoperability adapter for Claude Code.

This script modifies a copy of Claude Code already installed on the end-user's
own machine, for the sole purpose of enabling interoperability with
third-party AI models (OpenAI GPT family). It is intended to be run by the
end user against their own local binary.

Legal position
--------------
This tool performs local reverse engineering solely for the purpose of
interoperability. The maintainers rely on:

    - DMCA §1201(f) — interoperability exception
    - 17 U.S.C. §117(a) — owner's right to adapt software for their own use
    - Sega Enterprises v. Accolade (9th Cir. 1992)

Properties of this modification:

    - Performed only on the end-user's own machine
    - Byte-length-neutral (padding preserves original binary size)
    - Reversible (--restore reinstates the original from backup)
    - Never redistributed — no pre-patched binary is ever shipped

The end user is required to give explicit consent through the installer
before this script is invoked. See README § "Legal Position" and
TAKEDOWN_POLICY.md in the project root.

This script is **not** officially endorsed by Anthropic.

Usage
-----
  python3 patch-claude.py              # Apply patches
  python3 patch-claude.py --restore    # Restore from backup
  python3 patch-claude.py --diagnose   # Report which patterns match (dry run)
  python3 patch-claude.py --auto       # Non-interactive (for launchd autopatch)

Environment
-----------
  CLAUDE_BINARY  Override binary path (default: ~/.local/bin/claude)
  GPT_MODELS     Comma-separated models to inject (default: gpt-5.4,gpt-5.4-fast)
"""

import re
import subprocess
import shutil
import sys
import os
import json
import hashlib
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BINARY = Path(os.environ.get("CLAUDE_BINARY", Path.home() / ".local" / "bin" / "claude"))
BACKUP = BINARY.with_suffix(".backup")
LOG_DIR = Path.home() / "Library" / "Logs"
LOG_FILE = LOG_DIR / "gptcc-patch.log"

# Models to inject — configurable via env
_models_env = os.environ.get("GPT_MODELS", "gpt-5.4,gpt-5.4-fast")
INJECT_MODELS = [m.strip() for m in _models_env.split(",") if m.strip()]

# Variable names for injected model defs (checked for collisions)
VAR_NAMES = ["pQ3", "Z9", "xR7", "wK4", "jL8", "mN2"]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_auto_mode = "--auto" in sys.argv
_diagnose_mode = "--diagnose" in sys.argv


def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    if not _auto_mode:
        print(f"  {msg}")
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def notify_failure(msg):
    """macOS notification on patch failure (autopatch mode)."""
    if not _auto_mode:
        return
    try:
        subprocess.run([
            "osascript", "-e",
            f'display notification "{msg}" with title "GPT for Claude Code" subtitle "Patch Failed"'
        ], capture_output=True, timeout=5)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Pattern Definitions (version-resilient)
# ---------------------------------------------------------------------------
# Each pattern uses structural regex instead of hardcoded variable/function names.
# The regex captures dynamic parts (minified names) and reconstructs patches.

PATTERNS = {
    "model_defs": {
        "description": "Model picker definitions (sonnet/haiku)",
        # Minified var names may contain $ (e.g. $85, l$7). Match [\w$]+
        "regex": rb'([\w\$]{1,6})=\{value:"sonnet",label:"Sonnet"(?:,description:"[^"]*")?\},([\w\$]{1,6})=\{value:"haiku",label:"Haiku"(?:,description:"[^"]*")?\}',
    },
    "agent_enum": {
        "description": "Agent tool model enum validation",
        # Matches: ANYTHING.enum(["sonnet","opus","haiku"]) with any zod-like validator var
        "regex": rb'([\w\$]+)\.enum\(\["sonnet","opus","haiku"\]\)',
    },
    "context_1m": {
        "description": "1M context window detection function",
        # Matches: function XX(V){if(GUARD())return!1;return/\[1m\]/i.test(V)}
        "regex": rb'function\s+([\w\$]{1,6})\((\w)\)\{if\(([\w\$]+)\(\)\)return!1;return/\\\[1m\\\]/i\.test\(\2\)\}',
    },
    "context_absorber": {
        "description": "Function with .includes() for sonnet-4/opus-4-6 (byte absorber)",
        # Old: 2-way (sonnet-4|opus-4-6). New: 3-way (sonnet-4|opus-4-6|opus-4-7)
        # Match either variant flexibly
        "regex": rb'function\s+([\w\$]{1,6})\((\w)\)\{if\(([\w\$]+)\(\)\)return!1;let\s+(\w)=([\w\$]+)\(\2\);return\s+\4\.includes\("claude-sonnet-4"\)\|\|\4\.includes\("opus-4-6"\)(?:\|\|\4\.includes\("opus-4-7"\))?\}',
    },
    "model_check_3way": {
        "description": "Function with 3-way .includes() to shorten (opus-4/sonnet-4/haiku-4)",
        "regex": rb'function\s+([\w\$]{1,6})\((\w)\)\{let\s+(\w)=([\w\$]+)\(\2\);return\s+\3\.includes\("claude-opus-4"\)\|\|\3\.includes\("claude-sonnet-4"\)\|\|\3\.includes\("claude-haiku-4"\)\}',
    },
    "picker_return_vz": {
        "description": "Model picker Vz()/$T() branch return (needs GPT push)",
        # Matches: return X.push(FUNC()),X} OR return X.push(VAR),X}
        "regex": rb'return\s+(\w)\.push\(([\w\$]{1,6}(?:\(\))?)\),\1\}',
    },
    "picker_return_else": {
        "description": "Model picker else branch final return (needs GPT push)",
        # Matches: else _.push(XX());return _} OR else _.push(XX(),...);return _}
        "regex": rb'else\s+(\w)\.push\(([\w\$]{1,6})\(\)\);return\s+\1\}',
    },
}


def find_pattern(data, name):
    """Find a pattern in binary data. Returns match object or None."""
    info = PATTERNS[name]
    return re.search(info["regex"], data)


def count_pattern(data, name):
    """Count occurrences of a pattern."""
    info = PATTERNS[name]
    return len(re.findall(info["regex"], data))


# ---------------------------------------------------------------------------
# Collision Check
# ---------------------------------------------------------------------------

def check_var_collisions(data, var_names):
    """Verify injected variable names don't collide with existing minified names."""
    collisions = []
    for v in var_names:
        # Check if var name is used as an identifier (word boundary, incl. $)
        pattern = rb'(?<![a-zA-Z0-9_\$])' + re.escape(v.encode()) + rb'(?:=|,|\(|\)|\[|\.)'
        if re.search(pattern, data):
            collisions.append(v)
    return collisions


# ---------------------------------------------------------------------------
# Diagnose Mode
# ---------------------------------------------------------------------------

def diagnose(data):
    """Report which patterns match and where. Dry run, no modifications."""
    print(f"\n  Binary: {len(data):,} bytes")
    print(f"  SHA256: {hashlib.sha256(data).hexdigest()[:16]}...")
    print(f"  Already patched: {b'\"gpt-5.4\",\"gpt-5.4-fast\"' in data}")
    print()

    all_ok = True
    for name, info in PATTERNS.items():
        m = re.search(info["regex"], data)
        count = len(re.findall(info["regex"], data))
        if m:
            # Show matched text (truncated)
            matched = m.group(0)
            preview = matched[:120].decode("utf-8", errors="replace")
            if len(matched) > 120:
                preview += "..."
            print(f"  OK  {name} ({info['description']})")
            print(f"      Matches: {count}x")
            print(f"      Preview: {preview}")
            # Show captured groups
            for i, g in enumerate(m.groups(), 1):
                print(f"      Group {i}: {g.decode('utf-8', errors='replace')}")
        else:
            all_ok = False
            print(f"  FAIL {name} ({info['description']})")
            print(f"      Pattern: {info['regex'][:100]}")
            # Try partial matches to help debug
            _diagnose_partial(data, name, info)
        print()

    # Check variable collisions
    needed_vars = VAR_NAMES[:len(INJECT_MODELS)]
    collisions = check_var_collisions(data, needed_vars)
    if collisions:
        print(f"  WARN Variable collisions: {collisions}")
        print(f"       These names exist in the binary and would conflict.")
    else:
        print(f"  OK   No variable name collisions for {needed_vars}")

    print(f"\n  {'All patterns matched — patch should succeed.' if all_ok else 'Some patterns failed — patch will fail.'}")
    return all_ok


def _diagnose_partial(data, name, info):
    """Try to find what changed when a pattern fails to match."""
    if name == "model_defs":
        # Try to find sonnet/haiku defs with different structures
        for probe in [
            rb'value:"sonnet"',
            rb'value:"sonnet",label:"Sonnet"',
            rb'label:"Sonnet"',
        ]:
            idx = data.find(probe)
            if idx >= 0:
                ctx = data[max(0, idx - 30):idx + 100].decode("utf-8", errors="replace")
                print(f"      Partial: found '{probe.decode()}' at offset {idx}")
                print(f"      Context: ...{ctx}...")
                return
        print(f"      No trace of sonnet/haiku model defs found")

    elif name == "agent_enum":
        for probe in [
            rb'enum(["sonnet"',
            rb'"sonnet","opus","haiku"',
            rb'"sonnet","opus"',
        ]:
            idx = data.find(probe)
            if idx >= 0:
                ctx = data[max(0, idx - 20):idx + 80].decode("utf-8", errors="replace")
                print(f"      Partial: found at offset {idx}")
                print(f"      Context: ...{ctx}...")
                return
        print(f"      No trace of model enum found")

    elif name == "context_1m":
        probe = rb'[1m]'
        idx = data.find(probe)
        if idx >= 0:
            ctx = data[max(0, idx - 60):idx + 40].decode("utf-8", errors="replace")
            print(f"      Partial: [1m] found at offset {idx}")
            print(f"      Context: ...{ctx}...")
        else:
            print(f"      No trace of [1m] context check found")


# ---------------------------------------------------------------------------
# Patch Application
# ---------------------------------------------------------------------------

def apply_all(data):
    orig_size = len(data)
    replacements = []  # (orig, new, description)

    if b'"gpt-5.4","gpt-5.4-fast"' in data:
        log("Already patched!")
        return data, False

    # ---- Step 1: Find model definitions ----
    m_defs = find_pattern(data, "model_defs")
    if not m_defs:
        log("Model defs not found — run with --diagnose for details", "ERROR")
        return data, False

    orig_defs = m_defs.group(0)
    sv, hv = m_defs.group(1).decode(), m_defs.group(2).decode()
    def_count = data.count(orig_defs)
    log(f"Model defs: {sv}=sonnet, {hv}=haiku ({def_count} copies, {len(orig_defs)} bytes)")

    # ---- Step 2: Check variable name collisions ----
    needed_vars = VAR_NAMES[:len(INJECT_MODELS)]
    collisions = check_var_collisions(data, needed_vars)
    if collisions:
        alt_pool = [f"q{i}X" for i in range(10)] + [f"z{i}W" for i in range(10)]
        for c in collisions:
            idx = needed_vars.index(c)
            for alt in alt_pool:
                if alt not in needed_vars and alt not in collisions:
                    test_collisions = check_var_collisions(data, [alt])
                    if not test_collisions:
                        needed_vars[idx] = alt
                        log(f"Variable collision: {c} → using {alt} instead")
                        break
            else:
                log(f"Cannot resolve variable collision for {c}", "ERROR")
                return data, False

    model_vars = ",".join(needed_vars[:len(INJECT_MODELS)])

    # ---- Step 3: Find ALL push sites (existing haiku pushes) ----
    push_base = f'.push({hv})'.encode()
    push_pairs = []
    seen = set()
    idx = 0
    while True:
        idx = data.find(push_base, idx)
        if idx == -1:
            break
        suffix = data[idx + len(push_base):idx + len(push_base) + 1]
        if suffix not in seen:
            seen.add(suffix)
            orig_p = push_base + suffix
            new_p = f'.push({hv},{model_vars})'.encode() + suffix
            cnt = data.count(orig_p)
            push_pairs.append((orig_p, new_p, cnt))
        idx += 1
    push_growth = sum((len(n) - len(o)) * c for o, n, c in push_pairs)
    log(f"Haiku push sites: {sum(c for _, _, c in push_pairs)} total, {push_growth:+d} bytes")

    # ---- Step 3b: Find return paths WITHOUT GPT push (Vz branch, else branch) ----
    extra_push_pairs = []

    # Pattern: return T.push(FUNC()),T} → return T.push(FUNC(),pQ3,q0X),T}
    for m_vz in re.finditer(rb'return\s+(\w)\.push\((\w{1,5})\(\)\),\1\}', data):
        orig_ret = m_vz.group(0)
        arr_var = m_vz.group(1).decode()
        func_name = m_vz.group(2).decode()
        new_ret = f'return {arr_var}.push({func_name}(),{model_vars}),{arr_var}}}'.encode()
        if orig_ret not in [p[0] for p in extra_push_pairs]:
            cnt = data.count(orig_ret)
            extra_push_pairs.append((orig_ret, new_ret, cnt))
            log(f"Extra push (Vz return): {cnt}x, +{(len(new_ret)-len(orig_ret))*cnt}b")

    # Pattern: else _.push(XX());return _} → else _.push(XX(),pQ3,q0X);return _}
    for m_else in re.finditer(rb'else\s+(\w)\.push\((\w{1,5})\(\)\);return\s+\1\}', data):
        orig_ret = m_else.group(0)
        arr_var = m_else.group(1).decode()
        func_name = m_else.group(2).decode()
        new_ret = f'else {arr_var}.push({func_name}(),{model_vars});return {arr_var}}}'.encode()
        if orig_ret not in [p[0] for p in extra_push_pairs]:
            cnt = data.count(orig_ret)
            extra_push_pairs.append((orig_ret, new_ret, cnt))
            log(f"Extra push (else return): {cnt}x, +{(len(new_ret)-len(orig_ret))*cnt}b")

    extra_push_growth = sum((len(n) - len(o)) * c for o, n, c in extra_push_pairs)

    # ---- Step 4: Agent enum ----
    m_enum = find_pattern(data, "agent_enum")
    ae_growth = 0
    ae_orig = None
    ae_new = None
    if m_enum:
        validator_var = m_enum.group(1).decode()
        ae_orig = m_enum.group(0)
        models_str = ",".join(f'"{m}"' for m in INJECT_MODELS)
        ae_new = f'{validator_var}.enum(["sonnet","opus","haiku",{models_str}])'.encode()
        ae_count = data.count(ae_orig)
        ae_growth = (len(ae_new) - len(ae_orig)) * ae_count
        log(f"Agent enum: {ae_count}x, {ae_growth:+d} bytes (validator: {validator_var})")
    else:
        log("Agent enum not found — GPT models won't work in Agent tool", "WARN")

    # ---- Step 5: 1M context window function ----
    m_ctx = find_pattern(data, "context_1m")
    ctx_growth = 0
    ctx_orig = None
    ctx_new = None
    if m_ctx:
        ctx_orig = m_ctx.group(0)
        fname, v, guard = m_ctx.group(1).decode(), m_ctx.group(2).decode(), m_ctx.group(3).decode()
        ctx_new = f'function {fname}({v}){{if({guard}())return!1;return/\\[1m\\]|^gpt/i.test({v})}}'.encode()
        ctx_count = data.count(ctx_orig)
        ctx_growth = (len(ctx_new) - len(ctx_orig)) * ctx_count
        log(f"Context 1M func: {ctx_count}x, {ctx_growth:+d} bytes (func: {fname})")
    else:
        log("Context 1M function not found — GPT won't show as 1M context", "WARN")

    # ---- Step 5b: Collect all absorber functions for byte savings ----
    absorbers = []  # (orig_bytes, min_replacement_bytes, description)

    # Absorber 1: context_absorber (sonnet-4/opus-4-6 with guard)
    m_abs = find_pattern(data, "context_absorber")
    if m_abs:
        abs1_orig = m_abs.group(0)
        afn = m_abs.group(1).decode()
        ap1, ap2 = m_abs.group(2).decode(), m_abs.group(3).decode()
        ap5 = m_abs.group(5).decode()
        abs1_min = f'function {afn}({ap1}){{if({ap2}())return!1;return/sonnet-4|opus-4-6/.test({ap5}({ap1}))}}'.encode()
        absorbers.append((abs1_orig, abs1_min, f"absorber1({afn})"))

    # Absorber 2: model_check_3way (opus-4/sonnet-4/haiku-4 without guard)
    m_3way = find_pattern(data, "model_check_3way")
    if m_3way:
        abs2_orig = m_3way.group(0)
        fn2 = m_3way.group(1).decode()
        p2_1, p2_4 = m_3way.group(2).decode(), m_3way.group(4).decode()
        abs2_min = f'function {fn2}({p2_1}){{return/opus-4|sonnet-4|haiku-4/.test({p2_4}({p2_1}))}}'.encode()
        absorbers.append((abs2_orig, abs2_min, f"absorber2({fn2})"))

    total_absorber_max_savings = 0
    for ao, am, desc in absorbers:
        cnt = data.count(ao)
        savings = (len(ao) - len(am)) * cnt
        total_absorber_max_savings += savings
        log(f"{desc}: {len(ao)}b → {len(am)}b min, saves up to {savings}b ({cnt}x)")

    # ---- Step 6: Calculate byte budget and build model definitions ----
    total_growth = push_growth + extra_push_growth + ae_growth + ctx_growth
    available_savings = total_absorber_max_savings
    net_growth = total_growth - available_savings
    # defs_growth must equal -net_growth to balance
    # defs_growth = (len(new_defs) - len(orig_defs)) * def_count
    # so new_defs_len = orig_defs_len + (net_growth // -def_count)... wait, let's think simply:
    # We need: defs saves enough that defs_savings + absorber_savings >= total_growth
    # defs_target = len(orig_defs) - ceil(remaining / def_count)
    # remaining = total_growth - available_savings... but absorbers are flexible

    # Strategy: pick best labels first, then pad absorbers to balance
    def build_model_defs(sonnet_label, haiku_label, model_labels):
        parts = [
            f'{sv}={{value:"sonnet",label:"{sonnet_label}"}}',
            f'{hv}={{value:"haiku",label:"{haiku_label}"}}',
        ]
        for i, (model, label) in enumerate(model_labels):
            var = needed_vars[i]
            parts.append(f'{var}={{value:"{model}",label:"{label}"}}')
        return ",".join(parts).encode()

    label_combos = [
        ("Sonnet", "Haiku", [("gpt-5.4", "GPT-5.4"), ("gpt-5.4-fast", "GPT-5.4 Fast")]),
        ("Sonnet", "Haiku", [("gpt-5.4", "GPT-5.4"), ("gpt-5.4-fast", "5.4 Fast")]),
        ("Sonnet", "Haiku", [("gpt-5.4", "GPT5.4"), ("gpt-5.4-fast", "5.4 Fast")]),
        ("Sonnet", "Haiku", [("gpt-5.4", "GPT5.4"), ("gpt-5.4-fast", "5.4F")]),
        ("Sonnet", "Haiku", [("gpt-5.4", "5.4"), ("gpt-5.4-fast", "5.4F")]),
        ("S", "H", [("gpt-5.4", "GPT5.4"), ("gpt-5.4-fast", "5.4 Fast")]),
        ("S", "H", [("gpt-5.4", "5.4"), ("gpt-5.4-fast", "5.4F")]),
    ]

    # Max target: use all absorber savings
    max_target = len(orig_defs) - (total_growth - available_savings) // def_count
    log(f"Byte budget: growth={total_growth:+d}b, absorbers={available_savings}b, max defs target={max_target}b")

    new_defs_base = None
    for sl, hl, ml in label_combos:
        candidate = build_model_defs(sl, hl, ml)
        if len(candidate) <= max_target:
            new_defs_base = candidate
            labels = "/".join([sl, hl] + [l for _, l in ml])
            log(f"Labels: {labels} ({len(candidate)} <= {max_target})")
            break

    if new_defs_base is None:
        parts = [f'{sv}={{value:"sonnet"}}', f'{hv}={{value:"haiku"}}']
        for i, model in enumerate(INJECT_MODELS):
            parts.append(f'{needed_vars[i]}={{value:"{model}"}}')
        candidate = ",".join(parts).encode()
        if len(candidate) <= max_target:
            new_defs_base = candidate
            log(f"Labels: value-only ({len(candidate)} <= {max_target})")
        else:
            log(f"Defs too long even minimal ({len(candidate)} > {max_target})", "ERROR")
            return data, False

    # Pad defs to fill remaining space optimally
    # We want: defs_growth + absorber_growth + total_growth = 0
    # defs_growth = (new_defs_len - orig_defs_len) * def_count
    # absorber_growth = sum of absorber changes
    # So we set defs to use as little padding as needed, then absorbers take the rest

    defs_growth_from_base = (len(new_defs_base) - len(orig_defs)) * def_count
    remaining_to_absorb = -(total_growth + defs_growth_from_base)

    # Distribute remaining savings across absorbers (pad each to use only needed savings)
    absorber_replacements = []
    remaining = remaining_to_absorb
    for ao, am, desc in absorbers:
        cnt = data.count(ao)
        max_save = (len(ao) - len(am)) * cnt
        if remaining >= 0:
            break  # already balanced
        use = min(-remaining, max_save)
        save_per = use // cnt
        new_len = len(ao) - save_per
        if new_len < len(am):
            new_len = len(am)
            save_per = len(ao) - new_len
        padded = am[:-1] + b' ' * (new_len - len(am)) + b'}'
        absorber_replacements.append((ao, padded, cnt, desc))
        remaining += save_per * cnt

    # If still unbalanced, pad the defs to absorb remainder
    defs_pad = 0
    if remaining < 0:
        log(f"Cannot balance: {remaining} bytes remaining", "ERROR")
        return data, False
    elif remaining > 0:
        # We have surplus savings — add padding to defs
        defs_pad = remaining // def_count

    new_defs = new_defs_base + b' ' * (defs_pad)
    defs_growth = (len(new_defs) - len(orig_defs)) * def_count
    absorber_total_growth = sum((len(n) - len(o)) * c for o, n, c, _ in absorber_replacements)

    log(f"Model defs: {def_count}x, {len(new_defs)}b, {defs_growth:+d}b")
    for ao, an, cnt, desc in absorber_replacements:
        log(f"{desc}: {len(ao)}b → {len(an)}b, {(len(an)-len(ao))*cnt:+d}b total")

    # ---- Verify byte balance ----
    total = defs_growth + push_growth + extra_push_growth + ae_growth + ctx_growth + absorber_total_growth
    log(f"Total byte change: {total}")
    if total != 0:
        log("UNBALANCED — aborting", "ERROR")
        return data, False

    # ---- Apply all replacements ----
    data = data.replace(orig_defs, new_defs)
    assert data.count(new_defs) == def_count, "Model defs replacement count mismatch"

    for o, n, _ in push_pairs:
        data = data.replace(o, n)

    for o, n, _ in extra_push_pairs:
        data = data.replace(o, n)

    if ae_orig and ae_new:
        data = data.replace(ae_orig, ae_new)

    if ctx_orig and ctx_new:
        data = data.replace(ctx_orig, ctx_new)

    for ao, an, _, _ in absorber_replacements:
        data = data.replace(ao, an)

    # ---- Cosmetic: shorten verbose model descriptions (byte-neutral with space padding) ----
    desc_replacements = [
        # descriptionForModel (tooltip/info)
        (b'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks',
         b'Sonnet 4.6'),
        (b'Opus 4.6 - most capable for complex work',
         b'Opus 4.6'),
        (b'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
         b'Haiku 4.5'),
        (b'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
         b'Sonnet 4.6 (1M context)'),
        # Picker descriptions (visible in /model UI)
        (b'Billed as extra usage',
         b'                     '),
        (b'Sonnet 4.6 for long sessions',
         b'Sonnet 4.6 (1M)             '),
        (b'Best for everyday tasks',
         b'Everyday tasks         '),
        (b'Most capable for complex work',
         b'Most capable                 '),
        # Label upgrades: full version numbers in picker labels
        # \xB7 stored as literal 4 bytes: \, x, B, 7
        # "Sonnet" → "Sonnet 4.6" (+4b), offset by trimming description padding (-4b)
        (b'label:"Sonnet",description:`Sonnet 4.6 \\xB7 Everyday tasks         ',
         b'label:"Sonnet 4.6",description:`Sonnet 4.6 \\xB7 Everyday tasks     '),
        # "Haiku" → "Haiku 4.5" (+4b), offset by trimming description
        (b'label:"Haiku",description:`Haiku 4.5 \\xB7 Fastest for quick answers',
         b'label:"Haiku 4.5",description:`Haiku 4.5 \\xB7 Fast                 '),
        # "Sonnet (1M context)" → "Sonnet 4.6 (1M)" (-4b, already shorter, pad with spaces)
        (b'label:"Sonnet (1M context)"',
         b'label:"Sonnet 4.6 (1M)"    '),
    ]
    for old_desc, new_desc in desc_replacements:
        if old_desc in data:
            if len(new_desc) < len(old_desc):
                padded_desc = new_desc + b' ' * (len(old_desc) - len(new_desc))
            elif len(new_desc) == len(old_desc):
                padded_desc = new_desc
            else:
                continue  # skip if new is longer
            data = data.replace(old_desc, padded_desc)
            log(f"Desc: \"{old_desc.decode(errors='replace')[:30]}\" → \"{new_desc.decode().rstrip()}\"")

    # Final size check
    if len(data) != orig_size:
        log(f"CRITICAL: size changed {orig_size} → {len(data)}", "ERROR")
        return None, False

    return data, True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not BINARY.exists():
        msg = f"Binary not found: {BINARY}"
        log(msg, "ERROR")
        notify_failure(msg)
        sys.exit(1)

    # --restore
    if "--restore" in sys.argv:
        if BACKUP.exists():
            shutil.copy2(BACKUP, BINARY)
            subprocess.run(["codesign", "--force", "--sign", "-", str(BINARY)], capture_output=True)
            log("Restored from backup.")
        else:
            log("No backup found.", "WARN")
        sys.exit(0)

    # --diagnose
    if _diagnose_mode:
        data = BINARY.read_bytes()
        print(f"\n  === GPT for Claude Code Patch Diagnostics ===")
        diagnose(data)
        sys.exit(0)

    # Normal patch / --auto
    if not BACKUP.exists():
        shutil.copy2(BINARY, BACKUP)
        log(f"Backup created: {BACKUP}")
    else:
        # Verify backup isn't itself patched
        backup_data = BACKUP.read_bytes()
        if b'"gpt-5.4","gpt-5.4-fast"' in backup_data:
            log("WARNING: Backup appears to be patched. Creating fresh backup.", "WARN")
            # Only overwrite if current binary is unpatched
            current = BINARY.read_bytes()
            if b'"gpt-5.4","gpt-5.4-fast"' not in current:
                shutil.copy2(BINARY, BACKUP)
                log("Fresh backup created from unpatched binary.")

    data = BINARY.read_bytes()
    log(f"Binary: {len(data):,} bytes (SHA256: {hashlib.sha256(data).hexdigest()[:16]})")

    # Try to detect Claude Code version from binary (for diagnostic logging)
    try:
        r = subprocess.run([str(BINARY), "--version"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            version = r.stdout.strip().split()[0] if r.stdout else "unknown"
            log(f"Claude Code version: {version}")
    except Exception:
        pass

    result, ok = apply_all(data)
    if result is None:
        log("Patch failed critically!", "ERROR")
        notify_failure("Critical patch failure — binary may be corrupted")
        sys.exit(1)
    if not ok:
        if _auto_mode:
            # Check if already patched (not an error)
            if b'"gpt-5.4","gpt-5.4-fast"' in data:
                sys.exit(0)
            notify_failure("Patch patterns did not match — manual update needed")
        sys.exit(0 if b'"gpt-5.4","gpt-5.4-fast"' in data else 1)

    BINARY.write_bytes(result)
    r = subprocess.run(["codesign", "--force", "--sign", "-", str(BINARY)], capture_output=True, text=True)
    if r.returncode != 0:
        log("Codesign failed — restoring backup", "ERROR")
        shutil.copy2(BACKUP, BINARY)
        subprocess.run(["codesign", "--force", "--sign", "-", str(BINARY)], capture_output=True)
        notify_failure("Codesign failed after patching")
        sys.exit(1)

    # Verify
    v = BINARY.read_bytes()
    checks = [
        ("GPT model picker", b'value:"gpt-5.4"' in v),
        ("GPT-5.4-fast", b'gpt-5.4-fast' in v),
        ("Agent enum", b'"gpt-5.4","gpt-5.4-fast"' in v),
        ("1M context", b'|^gpt' in v),
    ]
    all_pass = True
    for name, passed in checks:
        log(f"{'OK' if passed else 'FAIL'} {name}")
        if not passed:
            all_pass = False

    # Runtime verification
    try:
        r2 = subprocess.run([str(BINARY), "--version"], capture_output=True, text=True, timeout=10)
        if r2.returncode == 0:
            log(f"OK Runtime: {r2.stdout.strip()[:50]}")
        else:
            log(f"FAIL Runtime: exit code {r2.returncode}", "ERROR")
            log("Restoring backup...")
            shutil.copy2(BACKUP, BINARY)
            subprocess.run(["codesign", "--force", "--sign", "-", str(BINARY)], capture_output=True)
            notify_failure("Patched binary failed runtime check")
            sys.exit(1)
    except subprocess.TimeoutExpired:
        log("WARN Runtime: --version timed out (may still work)", "WARN")

    if all_pass:
        log("Patch applied successfully!")
        if _auto_mode:
            # Notify success
            try:
                subprocess.run([
                    "osascript", "-e",
                    'display notification "Auto-patch successful" with title "GPT for Claude Code"'
                ], capture_output=True, timeout=5)
            except Exception:
                pass
    else:
        log("Patch applied but some checks failed", "WARN")
        notify_failure("Patch applied but verification partially failed")


if __name__ == "__main__":
    main()
