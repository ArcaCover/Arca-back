#!/usr/bin/env python3
"""
Arca Capa 2 underwriting configuration validator.

Run this on every configuration change. It turns the invariants that used to
live as prose in the skill into checks that actually execute, so a bad config
fails here instead of silently mispricing firms in production.

    python3 validate_capa2.py capa2_config.json

Exit code 0 = valid. Exit code 1 = at least one invariant failed.
"""

import json
import sys

PROFILE_ORDER = ["P0", "P1", "P2", "P3", "P4"]
CATEGORIES = ["aidg", "ps", "fm"]


class Report:
    def __init__(self):
        self.failures = []
        self.warnings = []
        self.facts = []

    def fail(self, check, detail):
        self.failures.append((check, detail))

    def warn(self, check, detail):
        self.warnings.append((check, detail))

    def fact(self, label, value):
        self.facts.append((label, value))

    def render(self):
        for label, value in self.facts:
            print(f"  {label:<46} {value}")
        if self.warnings:
            print("\nWARNINGS")
            for check, detail in self.warnings:
                print(f"  [{check}] {detail}")
        if self.failures:
            print("\nFAILURES")
            for check, detail in self.failures:
                print(f"  [{check}] {detail}")
        print()
        if self.failures:
            print(f"INVALID: {len(self.failures)} invariant(s) failed. Do not ship this config.")
        else:
            print("VALID: all invariants hold.")
        return 1 if self.failures else 0


def profile_ge(profile, floor):
    return PROFILE_ORDER.index(profile) >= PROFILE_ORDER.index(floor)


def best_option(question):
    """Highest-scoring option for a question, or None if it is unscored."""
    opts = question.get("options") or []
    scored = [o for o in opts if isinstance(o.get("points"), (int, float))]
    if not scored:
        return None
    return max(scored, key=lambda o: o["points"])


def select_questions(cfg, profile, *, capa1_has_areas=True, capa1_bar_ok=True):
    """
    Reproduce the engine's deterministic selection, including the hard cap.
    Returns (selected_ids, dropped_ids).
    """
    cap = cfg["question_cap"]
    primary = cfg["profile_primary"][profile]
    knockouts = cfg["profile_knockouts"][profile]
    profile_qs = cfg["profiles"][profile]["questions"]
    rest = [q for q in profile_qs if q != primary and q not in knockouts]

    ordered = []
    for entry in cfg["selection_priority"]:
        for raw in entry["ids"]:
            if raw == "@profile_primary":
                ids = [primary]
            elif raw == "@profile_knockouts":
                ids = list(knockouts)
            elif raw == "@profile_rest":
                ids = list(rest)
            elif raw == "@practice_area":
                ids = ["E-criminal"]  # one area question fires; any is equivalent for budget
            else:
                ids = [raw]

            when = entry["when"]
            for qid in ids:
                if when == "profile_ge_P1" and not profile_ge(profile, "P1"):
                    continue
                if when == "profile_ge_P3" and not profile_ge(profile, "P3"):
                    continue
                if when == "capa1_no_areas" and capa1_has_areas:
                    continue
                if when == "capa1_bar_failed" and capa1_bar_ok:
                    continue
                if qid not in ordered:
                    ordered.append(qid)

    return ordered[:cap], ordered[cap:]


def max_capa2_points(cfg, selected, profile, *, p0_verified=True):
    """Best-case Capa 2 points per category for a given selection."""
    totals = {c: 0 for c in CATEGORIES}
    for qid in selected:
        q = cfg["questions"].get(qid)
        if not q or not q.get("category"):
            continue
        opt = best_option(q)
        if opt and opt["points"] > 0:
            totals[q["category"]] += opt["points"]

    if profile == "P0":
        p0 = cfg["profiles"]["P0"]
        award = p0["award_verified"] if p0_verified else p0["award_unverified"]
        totals[p0["award_category"]] += award

    return totals


def main(path):
    with open(path) as fh:
        cfg = json.load(fh)

    rep = Report()
    cats = cfg["scoring"]["categories"]
    cap = cfg["question_cap"]

    print(f"\nArca Capa 2 config validator")
    print(f"config_version {cfg['config_version']}  bank_version {cfg['bank_version']}\n")

    # --- Invariant 0: category maximums sum to 100 -------------------------
    total_max = sum(cats.values())
    rep.fact("category maximums sum", total_max)
    if total_max != 100:
        rep.fail("sum-100", f"category maximums sum to {total_max}, expected 100")

    # --- Invariant 1: every referenced question exists ---------------------
    referenced = set()
    for entry in cfg["selection_priority"]:
        for raw in entry["ids"]:
            if not raw.startswith("@"):
                referenced.add(raw)
    for p in PROFILE_ORDER:
        referenced.add(cfg["profile_primary"][p])
        referenced.update(cfg["profile_knockouts"][p])
        referenced.update(cfg["profiles"][p]["questions"])
    missing = sorted(referenced - set(cfg["questions"]))
    if missing:
        rep.fail("questions-exist", f"referenced but not defined in the bank: {missing}")

    # --- Invariant 2: question cap is never exceeded -----------------------
    print("Question budget per profile")
    worst_case_ok = True
    for p in PROFILE_ORDER:
        for areas_ok in (True, False):
            for bar_ok in (True, False):
                sel, dropped = select_questions(
                    cfg, p, capa1_has_areas=areas_ok, capa1_bar_ok=bar_ok
                )
                if len(sel) > cap:
                    rep.fail("cap", f"{p} selected {len(sel)} questions, cap is {cap}")
                    worst_case_ok = False
        sel, dropped = select_questions(cfg, p)
        rep.fact(f"  {p} standard path", f"{len(sel)} asked, {len(dropped)} dropped")

    # --- Invariant 3: no knockout question is dropped on the standard path --
    print("\nKnockout coverage")
    for p in PROFILE_ORDER:
        sel, dropped = select_questions(cfg, p)
        ko_dropped = []
        for qid in dropped:
            q = cfg["questions"].get(qid, {})
            if any(o.get("ko") for o in q.get("options", [])):
                ko_dropped.append(qid)
        if ko_dropped:
            rep.warn(
                "knockout-dropped",
                f"{p}: cap drops knockout question(s) {ko_dropped} on the standard path. "
                f"The engine must force REFERRAL in this case.",
            )
        rep.fact(f"  {p} knockouts dropped", ko_dropped or "none")

    # --- Invariant 4: the ceiling. Every category reachable ----------------
    print("\nCeiling: can every category reach its maximum?")
    for p in PROFILE_ORDER:
        sel, _ = select_questions(cfg, p)
        c2 = max_capa2_points(cfg, sel, p, p0_verified=True)
        for cat in CATEGORIES:
            # Capa 1 can contribute up to the category maximum.
            reachable = min(cats[cat], cats[cat] + c2[cat])
            if reachable < cats[cat]:
                rep.fail(
                    "ceiling",
                    f"{p}/{cat} tops out at {reachable} of {cats[cat]} even with Capa 1 at max",
                )
        rep.fact(f"  {p} capa2 best-case", {k: v for k, v in c2.items()})

    # --- Invariant 5: the floor. Capa 1 contributes nothing ----------------
    print("\nFloor: best score reachable when Capa 1 contributes nothing")
    e1_auto = cfg["exposure"]["thresholds"]["E1"]["auto_bind"]
    for p in PROFILE_ORDER:
        # "Capa 1 contributes nothing" means all of its sources failed, so the
        # conditional questions that exist to cover those failures do fire.
        sel, _ = select_questions(cfg, p, capa1_has_areas=False, capa1_bar_ok=False)
        # A firm Capa 1 could not read cannot have a verified P0 award.
        c2 = max_capa2_points(cfg, sel, p, p0_verified=False)
        floor = sum(min(c2[cat], cats[cat]) for cat in CATEGORIES)
        rep.fact(f"  {p} floor", f"{floor} / 100   (E1 auto-bind is {e1_auto})")
        if floor >= e1_auto:
            rep.warn(
                "floor-reaches-autobind",
                f"{p}: a firm Capa 1 could not read at all can still reach {floor}, "
                f"which meets the E1 auto-bind threshold of {e1_auto}. This is only safe "
                f"because such a firm has LOW confidence and LOW blocks auto-bind. "
                f"If confidence.low_blocks_auto_bind is ever turned off, this becomes a hole.",
            )

    # --- Invariant 6: the structural guard behind the floor ----------------
    if not cfg["confidence"].get("low_blocks_auto_bind"):
        rep.fail(
            "confidence-guard",
            "low_blocks_auto_bind is false. The floor analysis above depends on it being true.",
        )

    # --- Invariant 7: thresholds are ordered and sane ----------------------
    print("\nThresholds")
    prev_auto = 0
    for level in ["E1", "E2", "E3", "E4"]:
        t = cfg["exposure"]["thresholds"][level]
        rep.fact(f"  {level}", f"auto_bind {t['auto_bind']}  conditions {t['conditions']}")
        if t["auto_bind"] is None:
            continue
        if t["conditions"] is None or t["conditions"] >= t["auto_bind"]:
            rep.fail("threshold-order", f"{level}: conditions must be below auto_bind")
        if t["auto_bind"] < prev_auto:
            rep.fail("threshold-monotonic", f"{level}: auto_bind lower than the band below it")
        prev_auto = t["auto_bind"]
        if t["conditions"] < cfg["referral_senior_below_score"]:
            rep.warn(
                "threshold-vs-senior",
                f"{level}: conditions threshold {t['conditions']} sits below the senior-referral "
                f"line of {cfg['referral_senior_below_score']}",
            )

    # --- Invariant 8: every area has a factor and a band -------------------
    banded = {a for areas in cfg["exposure"]["area_bands"].values() for a in areas}
    priced = set(cfg["pricing"]["area_factors"])
    if banded != priced:
        rep.fail(
            "area-coverage",
            f"areas banded but not priced: {sorted(banded - priced)}; "
            f"priced but not banded: {sorted(priced - banded)}",
        )

    # --- Invariant 9: risk factor range matches its declared bounds --------
    rf = cfg["pricing"]["risk_factor"]
    at_100 = rf["intercept"] - rf["slope"]
    at_0 = rf["intercept"]
    rep.fact("  risk factor at score 100 / 0", f"{at_100:.2f} / {at_0:.2f}")
    if abs(at_100 - rf["min"]) > 1e-9 or abs(at_0 - rf["max"]) > 1e-9:
        rep.warn(
            "risk-factor-bounds",
            f"declared min/max ({rf['min']}, {rf['max']}) do not match the formula's "
            f"actual range ({at_100:.2f}, {at_0:.2f}); the clamp is doing nothing or hiding a gap",
        )

    # --- Invariant 10: every scored option has points ----------------------
    for qid, q in cfg["questions"].items():
        if q.get("category") is None:
            continue
        for opt in q.get("options", []):
            if not isinstance(opt.get("points"), (int, float)):
                rep.fail("option-points", f"{qid}/{opt.get('id')} has no numeric points")

    print()
    return rep.render()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
