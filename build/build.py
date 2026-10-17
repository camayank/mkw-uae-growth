#!/usr/bin/env python3
"""Build the UAE ASP Selector and the E-Invoice Data Check.

Inputs   site.config.json (URLs, contact details), data/raw/*.json, src/template.html, tools/validator/einvoice_check.html
Outputs  data/providers.json                      normalised dataset
         dist/asp_selector.artifact.html          selector fragment for the Claude Artifact host (artifact URLs, host adds the skeleton)
         dist/einvoice_check.artifact.html        validator fragment for the Claude Artifact host
         dist/index.html                          selector, standalone, site-relative links, OG metadata
         dist/check/index.html                    validator, standalone
         dist/og-image.png                        1200x630 preview image for shared links
         dist/.nojekyll, dist/404.html            GitHub Pages plumbing

Usage    python3 build/build.py [--site-url URL] [--adviser-whatsapp DIGITS] [--adviser-email ADDR] [--adviser-name NAME]
         Flags override site.config.json. Standard library plus Pillow (optional, for the preview image).
"""
import argparse, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT_DATA = ROOT / "data" / "providers.json"
TEMPLATE = ROOT / "src" / "template.html"
VALIDATOR = ROOT / "tools" / "validator" / "einvoice_check.html"
DIST = ROOT / "dist"
CONFIG_FILE = ROOT / "site.config.json"

# MoF accreditation numbers, copied from the register on 2026-10-17 (keyed by our provider id).
ACCREDITATION = {1:196766,2:189050,3:134809,4:141846,5:101071,6:185520,7:179804,8:178533,9:164921,10:181172,11:110668,12:112219,13:142208,14:101139,15:158550,16:129478,17:163162,18:123513,19:117846,20:102434,21:165308,22:138271,23:134577,24:159905,25:144576,26:131375,27:171157,28:187021,29:184465,30:114413,31:120915,32:142349,33:111062,34:130476,35:160945,36:143578,37:157529,38:158006,39:104802,40:100511,41:194498,42:198978,43:129353,44:153759,45:199307,46:139410,47:197202,48:193219,49:152306,50:180240,51:106799,52:162503,53:128546,54:175257,55:166926,56:105700,57:182493,58:148957,59:163006,60:106062,61:149302,62:126326,63:194753,64:129932,65:133108,66:116145,67:121988}
OWN_PRODUCT = {52: "Tally", 67: "Zoho Books", 23: "Focus", 47: "SAP"}  # ERP vendors accredited for their own software
ERP_VOCAB = {"SAP","Oracle","Dynamics 365","NetSuite","Odoo","Tally","Zoho Books","QuickBooks","Xero","Sage","Focus","Infor","Epicor","Other ERP","Custom API","Excel/CSV upload","Web portal"}
SEGMENTS = {"enterprise","mid_market","sme","micro","government"}
PRICING = {"per_invoice","subscription","tiered","quote_only","unknown"}
SUPPORT = {"24/7","chat","phone","email","dedicated_manager","onsite"}
TYPES = {"erp_vendor","tax_tech","accounting_firm","big4_advisory","enterprise_edi","fintech_platform","it_services","unknown"}
FIELDS = ["id","name","website","accreditation","type","origin","erp_integrations","segments","multi_entity","free_zone_qfzp_support","ksa_zatca_experience","other_countries","pricing","free_trial_or_sandbox","arabic_ui","onboarding_claim","support","also_provides_accounting_or_tax_advisory","notable","confidence","sources"]

def load_config(args):
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    for k, v in (("site_url", args.site_url), ("adviser_whatsapp", args.adviser_whatsapp), ("adviser_email", args.adviser_email), ("adviser_name", args.adviser_name)):
        if v: cfg[k] = v
    cfg.setdefault("site_url", "")
    if cfg["site_url"] and not cfg["site_url"].endswith("/"): cfg["site_url"] += "/"
    return cfg

def load_raw():
    rows = []
    for f in sorted(RAW.glob("asp_data_[A-Z].json")):
        rows += json.loads(f.read_text(encoding="utf-8"))
    rows.sort(key=lambda r: r["id"])
    if [r["id"] for r in rows] != list(range(1, len(rows) + 1)):
        sys.exit("provider ids are not contiguous 1..N")
    return rows

def tri(v): return v if v in (True, False) else None

def normalise(r):
    r["accreditation"] = str(ACCREDITATION.get(r["id"], ""))
    ei = r.get("erp_integrations") or {}
    nat = [e for e in (ei.get("native") or []) if e in ERP_VOCAB]
    if r["id"] in OWN_PRODUCT:
        nat = [e for e in nat if e != "Other ERP"]
        if OWN_PRODUCT[r["id"]] not in nat: nat.insert(0, OWN_PRODUCT[r["id"]])
    api = [e for e in (ei.get("connector_or_api") or []) if e in ERP_VOCAB and e not in nat]
    r["erp_integrations"] = {"native": nat, "connector_or_api": api, "evidence_url": ei.get("evidence_url") or ""}
    r["segments"] = [s for s in (r.get("segments") or []) if s in SEGMENTS]
    pr = r.get("pricing") or {}
    r["pricing"] = {"model": pr.get("model") if pr.get("model") in PRICING else "unknown", "published": bool(pr.get("published")), "indicative": pr.get("indicative") or "", "evidence_url": pr.get("evidence_url") or ""}
    for k in ("multi_entity","free_zone_qfzp_support","ksa_zatca_experience","free_trial_or_sandbox","arabic_ui"): r[k] = tri(r.get(k))
    r["other_countries"] = r.get("other_countries") or []
    r["support"] = [s for s in (r.get("support") or []) if s in SUPPORT]
    r["also_provides_accounting_or_tax_advisory"] = bool(r.get("also_provides_accounting_or_tax_advisory"))
    r["onboarding_claim"] = (r.get("onboarding_claim") or "")[:140]
    r["notable"] = (r.get("notable") or "")[:220]
    r["origin"] = r.get("origin") or ""
    r["confidence"] = r.get("confidence") if r.get("confidence") in ("high","medium","low") else "low"
    r["type"] = r.get("type") if r.get("type") in TYPES else "unknown"
    w = r.get("website") or ""
    r["website"] = w if (not w or w.startswith("http")) else "https://" + w
    srcs = []
    for s in (r.get("sources") or []):
        if isinstance(s, str) and s.startswith("http") and s not in srcs: srcs.append(s)
    r["sources"] = srcs[:5]
    return {k: r[k] for k in FIELDS}

def set_config(html, pairs):
    for key, val in pairs:
        if val is None: continue
        html, n = re.subn(rf'({key}:\s*)"[^"]*"', lambda m: f'{m.group(1)}"{val}"', html, count=1)
        if n != 1: sys.exit(f"could not set CONFIG.{key}")
    return html

def standalone(fragment, cfg, *, title, description, path):
    """Wrap a fragment in a full document with the host's reset, OG metadata and a favicon."""
    url = (cfg["site_url"] + path) if cfg["site_url"] else ""
    og_img = (cfg["site_url"] + "og-image.png") if cfg["site_url"] else ""
    favicon = ("data:image/svg+xml," + "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230F766E'/%3E%3Cpath d='M18 34l10 10 18-22' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
    head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            f'<meta name="description" content="{description}">'
            f'<meta property="og:type" content="website"><meta property="og:title" content="{title}"><meta property="og:description" content="{description}">'
            + (f'<meta property="og:url" content="{url}"><link rel="canonical" href="{url}">' if url else "")
            + (f'<meta property="og:image" content="{og_img}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="{og_img}">' if og_img else '<meta name="twitter:card" content="summary">')
            + f'<link rel="icon" href="{favicon}">'
            '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
            '</head><body>')
    return head + fragment + "</body></html>"

def og_image(path, cfg):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return False
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), (15, 118, 110))
    d = ImageDraw.Draw(im)
    def font(size, bold=True):
        for name in (["DejaVuSans-Bold.ttf","DejaVuSans.ttf"] if bold else ["DejaVuSans.ttf"]):
            try: return ImageFont.truetype(name, size)
            except Exception: pass
        return ImageFont.load_default()
    d.rounded_rectangle((60, 60, 1140, 570), radius=28, fill=(245, 247, 246))
    d.text((110, 110), "UAE E-Invoicing", font=font(64), fill=(19, 33, 58))
    d.text((110, 190), "ASP Selector & Data Check", font=font(64), fill=(15, 118, 110))
    d.text((110, 300), "67 accredited providers, ranked for your ERP, size and volume.", font=font(30, False), fill=(91, 101, 120))
    d.text((110, 345), "Check which invoices would be rejected before you appoint.", font=font(30, False), fill=(91, 101, 120))
    d.text((110, 430), "Neutral · free · no paid placement · nothing uploaded", font=font(26, False), fill=(194, 65, 12))
    d.text((110, 500), f"Data as of {cfg.get('data_as_of','2026-10-17')}  ·  {cfg.get('adviser_name','')}, MKW Advisors", font=font(24, False), fill=(91, 101, 120))
    im.save(path, "PNG", optimize=True)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site-url", default=""); ap.add_argument("--adviser-whatsapp", default=""); ap.add_argument("--adviser-email", default=""); ap.add_argument("--adviser-name", default="")
    a = ap.parse_args(); cfg = load_config(a)

    providers = [normalise(r) for r in load_raw()]
    OUT_DATA.write_text(json.dumps(providers, ensure_ascii=False, indent=1), encoding="utf-8")
    data = json.dumps(providers, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    tpl = TEMPLATE.read_text(encoding="utf-8")
    if "/*__DATA__*/[]" not in tpl: sys.exit("template is missing the /*__DATA__*/[] marker")
    base = tpl.replace("/*__DATA__*/[]", "/*__DATA__*/" + data)
    base = set_config(base, (("adviserName", cfg.get("adviser_name")), ("adviserWhatsApp", cfg.get("adviser_whatsapp")), ("adviserEmail", cfg.get("adviser_email")), ("dataAsOf", cfg.get("data_as_of"))))
    DIST.mkdir(exist_ok=True); (DIST / "check").mkdir(exist_ok=True)

    # Selector: artifact flavour (artifact URLs) and site flavour (site-relative URLs).
    art = set_config(base, (("shareUrl", cfg.get("artifact_selector_url", "")), ("validatorUrl", cfg.get("artifact_validator_url", ""))))
    (DIST / "asp_selector.artifact.html").write_text(art, encoding="utf-8")
    site_sel = set_config(base, (("shareUrl", cfg["site_url"]), ("validatorUrl", (cfg["site_url"] + "check/") if cfg["site_url"] else "check/")))
    (DIST / "index.html").write_text(standalone(site_sel, cfg, title="UAE ASP Selector", description="Six questions rank all 67 MoF-accredited UAE e-invoicing providers against your ERP, size, zone and volume, with your legal dates, penalty exposure and a readiness checklist. Neutral and free.", path=""), encoding="utf-8")

    # Validator: artifact flavour and site flavour.
    val = VALIDATOR.read_text(encoding="utf-8")
    val = set_config(val, (("adviserName", cfg.get("adviser_name")), ("adviserWhatsApp", cfg.get("adviser_whatsapp")), ("adviserEmail", cfg.get("adviser_email")), ("asOf", cfg.get("data_as_of"))))
    val_art = set_config(val, (("selectorUrl", cfg.get("artifact_selector_url", "")),))
    (DIST / "einvoice_check.artifact.html").write_text(val_art, encoding="utf-8")
    site_val = set_config(val, (("selectorUrl", cfg["site_url"] or "../"),))
    site_val = site_val.replace(cfg.get("artifact_selector_url", "\x00"), cfg["site_url"] or "../")  # footer link
    (DIST / "check" / "index.html").write_text(standalone(site_val, cfg, title="E-Invoice Data Check", description="Drop your customer list and invoice register from Tally, Zoho, QuickBooks, SAP or Excel and see which invoices would be rejected under UAE e-invoicing, the receivables at risk and the fix plan. Runs in your browser; nothing is uploaded.", path="check/"), encoding="utf-8")

    (DIST / ".nojekyll").write_text("", encoding="utf-8")
    (DIST / "404.html").write_text('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/asp-selector/"><title>UAE ASP Selector</title><p>Redirecting to the <a href="/asp-selector/">UAE ASP Selector</a>.</p>', encoding="utf-8")
    made = og_image(DIST / "og-image.png", cfg)
    print(f"built {len(providers)} providers -> data/providers.json; dist/index.html, dist/check/index.html, two artifact fragments{', og-image.png' if made else ''}; site_url={cfg['site_url'] or '(none)'}")

if __name__ == "__main__":
    main()
