#!/usr/bin/env python3
"""把 meta-rules-dat 分析产物（geosite.csv / geoip.csv）合并进规则目录。

用法：python3 tools/merge_catalog.py <catalog.json> <geosite.csv> <geoip.csv>
输出：原地精简 + 富化后的 catalog.json
字段：zh(中文名) cat(大类) cnt(条目数) act(建议动作) desc(用途) sample(样例)
"""
import csv
import json
import sys


def load_csv(path, kind):
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("name") or "").strip()
            if not name:
                continue
            out[name] = {
                "zh": (row.get("zh") or "").strip(),
                "cat": (row.get("cat") or "").strip(),
                "cnt": int(row["cnt"]) if (row.get("cnt") or "").isdigit() else 0,
                "act": (row.get("act") or "").strip(),
                "desc": (row.get("desc") or "").strip(),
                "sample": (row.get("sample") or "").strip(),
                "empty": bool((row.get("empty") or "").strip()),
            }
    return out


def main():
    catalog_path, gs_path, gi_path = sys.argv[1:4]
    with open(catalog_path, encoding="utf-8") as fh:
        data = json.load(fh)
    gs = load_csv(gs_path, "geosite")
    gi = load_csv(gi_path, "geoip")
    hit = 0
    for item in data.get("items", []):
        src = gs if item["kind"] == "geosite" else gi
        info = src.get(item["name"])
        if not info:
            continue
        hit += 1
        if info["zh"]:
            item["zh"] = info["zh"]
            item["label"] = info["zh"]
        if info["cat"]:
            item["cat"] = info["cat"]
        item["cnt"] = info["cnt"]
        if info["desc"]:
            item["desc"] = info["desc"]
        if info["act"]:
            item["act"] = info["act"]
        if info["empty"]:
            item["empty"] = True
    data["count"] = len(data.get("items", []))
    data["enriched"] = hit
    with open(catalog_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"合并完成：{hit}/{data['count']} 条命中，输出 {catalog_path}")


if __name__ == "__main__":
    main()
